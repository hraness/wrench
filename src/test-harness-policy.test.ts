import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import ts from "typescript";

type PolicyViolationCode =
  | "jest-timeout-call"
  | "set-default-timeout-import"
  | "set-default-timeout-call"
  | "registration-opaque-options"
  | "registration-options-timeout"
  | "registration-positional-timeout";

type PolicyViolation = {
  readonly code: PolicyViolationCode;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

type BunTestBindings = {
  readonly jestBindings: ReadonlySet<string>;
  readonly registrations: ReadonlySet<string>;
  readonly setDefaultTimeouts: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
};

const executableTestFilePattern = /[._](?:test|spec)\.(?:js|jsx|ts|tsx)$/u;
const jestTimeoutMembers = new Set(["setDefaultTimeout", "setTimeout"]);
const registrationExports = new Set(["it", "test", "xit", "xtest"]);
const registrationBuilderMembers = new Set(["each", "if", "skipIf"]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function memberName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  const argument = expression.argumentExpression;
  if (
    ts.isStringLiteral(argument)
    || ts.isNoSubstitutionTemplateLiteral(argument)
  ) {
    return argument.text;
  }
  return null;
}

function isMemberExpression(
  expression: ts.Expression,
): expression is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression);
}

function isNamespaceMember(
  expression: ts.Expression,
  namespaces: ReadonlySet<string>,
  names: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (!isMemberExpression(unwrapped)) return false;
  const owner = unwrapExpression(unwrapped.expression);
  return ts.isIdentifier(owner)
    && namespaces.has(owner.text)
    && names.has(memberName(unwrapped) ?? "");
}

function isRegistrationRootedExpression(
  expression: ts.Expression,
  bindings: BunTestBindings,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return bindings.registrations.has(unwrapped.text);
  }
  if (isMemberExpression(unwrapped)) {
    if (isNamespaceMember(unwrapped, bindings.namespaces, registrationExports)) {
      return true;
    }
    return isRegistrationRootedExpression(unwrapped.expression, bindings);
  }
  if (ts.isCallExpression(unwrapped)) {
    return isRegistrationRootedExpression(unwrapped.expression, bindings);
  }
  if (ts.isTaggedTemplateExpression(unwrapped)) {
    return isRegistrationRootedExpression(unwrapped.tag, bindings);
  }
  return false;
}

function isRegistrationCall(
  call: ts.CallExpression,
  bindings: BunTestBindings,
): boolean {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return bindings.registrations.has(callee.text);
  }
  if (isMemberExpression(callee)) {
    if (!isRegistrationRootedExpression(callee, bindings)) return false;
    return !registrationBuilderMembers.has(memberName(callee) ?? "");
  }
  return (ts.isCallExpression(callee) || ts.isTaggedTemplateExpression(callee))
    && isRegistrationRootedExpression(callee, bindings);
}

function propertyName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name)
    || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name)
    || ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (
      ts.isStringLiteral(expression)
      || ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return expression.text;
    }
  }
  return null;
}

function hasTimeoutProperty(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) return false;
    return propertyName(property.name) === "timeout";
  });
}

function hasOpaqueProperty(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some((property) => (
    ts.isSpreadAssignment(property) || propertyName(property.name) === null
  ));
}

function isJestTimeoutCall(
  expression: ts.Expression,
  bindings: BunTestBindings,
): boolean {
  const callee = unwrapExpression(expression);
  if (
    !isMemberExpression(callee)
    || !jestTimeoutMembers.has(memberName(callee) ?? "")
  ) {
    return false;
  }
  const owner = unwrapExpression(callee.expression);
  if (ts.isIdentifier(owner)) return bindings.jestBindings.has(owner.text);
  if (!isMemberExpression(owner) || memberName(owner) !== "jest") return false;
  const namespace = unwrapExpression(owner.expression);
  return ts.isIdentifier(namespace) && bindings.namespaces.has(namespace.text);
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function violation(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  code: PolicyViolationCode,
  message: string,
): PolicyViolation {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    code,
    file: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
    message,
  };
}

function inspectTestSource(file: string, source: string): readonly PolicyViolation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const jestBindings = new Set<string>();
  const registrations = new Set<string>();
  const setDefaultTimeouts = new Set<string>();
  const namespaces = new Set<string>();
  const violations: PolicyViolation[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "bun:test"
    ) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      namespaces.add(namedBindings.name.text);
      continue;
    }
    for (const specifier of namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (registrationExports.has(importedName)) {
        registrations.add(specifier.name.text);
      }
      if (importedName === "jest") {
        jestBindings.add(specifier.name.text);
      }
      if (importedName === "setDefaultTimeout") {
        setDefaultTimeouts.add(specifier.name.text);
        violations.push(violation(
          sourceFile,
          specifier,
          "set-default-timeout-import",
          "Importing setDefaultTimeout from bun:test bypasses the package-wide timeout policy.",
        ));
      }
    }
  }

  const bindings: BunTestBindings = {
    jestBindings,
    registrations,
    setDefaultTimeouts,
    namespaces,
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const callsNamedDefaultTimeout = ts.isIdentifier(callee)
        && bindings.setDefaultTimeouts.has(callee.text);
      const callsNamespacedDefaultTimeout = isNamespaceMember(
        callee,
        bindings.namespaces,
        new Set(["setDefaultTimeout"]),
      );
      if (callsNamedDefaultTimeout || callsNamespacedDefaultTimeout) {
        violations.push(violation(
          sourceFile,
          node,
          "set-default-timeout-call",
          "Calling bun:test setDefaultTimeout bypasses the package-wide timeout policy.",
        ));
      }
      if (isJestTimeoutCall(callee, bindings)) {
        violations.push(violation(
          sourceFile,
          node,
          "jest-timeout-call",
          "Calling bun:test jest.setTimeout bypasses the package-wide timeout policy.",
        ));
      }

      if (isRegistrationCall(node, bindings)) {
        const optionsArgument = node.arguments[2];
        if (optionsArgument !== undefined) {
          const options = unwrapExpression(optionsArgument);
          if (ts.isObjectLiteralExpression(options)) {
            if (hasTimeoutProperty(options)) {
              violations.push(violation(
                sourceFile,
                options,
                "registration-options-timeout",
                "A bun:test registration options object must not set timeout.",
              ));
            }
            if (hasOpaqueProperty(options)) {
              violations.push(violation(
                sourceFile,
                options,
                "registration-opaque-options",
                "A bun:test registration options object must expose every property so timeout absence is reviewable.",
              ));
            }
          } else {
            violations.push(violation(
              sourceFile,
              options,
              "registration-positional-timeout",
              "A bun:test registration must not pass a numeric or opaque third-argument runner timeout.",
            ));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

async function executableTestFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.isFile() && executableTestFilePattern.test(entry.name)) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return files;
}

function displayPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

const acceptedFixtures = [
  {
    name: "direct registration and product deadline",
    source: `
      import { test } from "bun:test";
      const setDefaultTimeout = (milliseconds: number) => milliseconds;
      const productOptions = { timeout: 25 };
      setDefaultTimeout(productOptions.timeout);
      test("works", async () => runProductOperation(productOptions));
    `,
  },
  {
    name: "aliased registration",
    source: `
      import { test as check } from "bun:test";
      check.only("works", () => undefined);
    `,
  },
  {
    name: "namespace registration",
    source: `
      import * as bunTest from "bun:test";
      bunTest.it.skip("works", () => undefined);
    `,
  },
  {
    name: "each builder and modifier chain",
    source: `
      import { test } from "bun:test";
      test.only.each([[1], [2]])("case %i", (value) => value);
      test.skipIf(false)("conditional", () => undefined);
    `,
  },
  {
    name: "tagged each builder",
    source: `
      import { test } from "bun:test";
      test.each\`
        value
        \${1}
      \`("case $value", ({ value }) => value);
    `,
  },
  {
    name: "retry-only registration options",
    source: `
      import { test } from "bun:test";
      test("retries", () => undefined, { retry: 2, repeats: 1 });
    `,
  },
  {
    name: "skipped aliases and ordinary jest mocks",
    source: `
      import { jest, xit, xtest } from "bun:test";
      xit("skipped", () => undefined, { retry: 1 });
      xtest("also skipped", () => undefined);
      jest.fn(() => undefined);
    `,
  },
] as const;

const rejectedFixtures: readonly {
  readonly name: string;
  readonly source: string;
  readonly code: PolicyViolationCode;
}[] = [
  {
    name: "named setDefaultTimeout import",
    source: `import { setDefaultTimeout } from "bun:test";`,
    code: "set-default-timeout-import",
  },
  {
    name: "aliased setDefaultTimeout call",
    source: `
      import { setDefaultTimeout as configureHarness } from "bun:test";
      configureHarness(1_000);
    `,
    code: "set-default-timeout-call",
  },
  {
    name: "namespace setDefaultTimeout call",
    source: `
      import * as bunTest from "bun:test";
      bunTest.setDefaultTimeout(1_000);
    `,
    code: "set-default-timeout-call",
  },
  {
    name: "aliased jest timeout call",
    source: `
      import { jest as bunJest } from "bun:test";
      bunJest.setTimeout(1_000);
    `,
    code: "jest-timeout-call",
  },
  {
    name: "namespace jest timeout call",
    source: `
      import * as bunTest from "bun:test";
      bunTest.jest.setTimeout(1_000);
    `,
    code: "jest-timeout-call",
  },
  {
    name: "direct positional timeout",
    source: `
      import { test } from "bun:test";
      test("slow", () => undefined, 1_000);
    `,
    code: "registration-positional-timeout",
  },
  {
    name: "aliased modifier positional timeout",
    source: `
      import { it as check } from "bun:test";
      check.only("slow", () => undefined, TEST_TIMEOUT);
    `,
    code: "registration-positional-timeout",
  },
  {
    name: "namespace each positional timeout",
    source: `
      import * as bunTest from "bun:test";
      bunTest.test.each([[1]])("case %i", () => undefined, 1_000);
    `,
    code: "registration-positional-timeout",
  },
  {
    name: "modifier each options timeout",
    source: `
      import { test } from "bun:test";
      test.only.each([[1]])("case %i", () => undefined, { timeout: 1_000 });
    `,
    code: "registration-options-timeout",
  },
  {
    name: "tagged each positional timeout",
    source: `
      import { test } from "bun:test";
      test.each\`
        value
        \${1}
      \`("case $value", () => undefined, 1_000);
    `,
    code: "registration-positional-timeout",
  },
  {
    name: "timeout registration option",
    source: `
      import { test } from "bun:test";
      test("slow", () => undefined, { timeout: 1_000 });
    `,
    code: "registration-options-timeout",
  },
  {
    name: "quoted timeout registration option",
    source: `
      import { test } from "bun:test";
      test("slow", () => undefined, { "timeout": 1_000 });
    `,
    code: "registration-options-timeout",
  },
  {
    name: "shorthand timeout registration option",
    source: `
      import { test } from "bun:test";
      const timeout = 1_000;
      test("slow", () => undefined, { timeout });
    `,
    code: "registration-options-timeout",
  },
  {
    name: "opaque registration options identifier",
    source: `
      import { test } from "bun:test";
      const options = { retry: 1 };
      test("opaque", () => undefined, options);
    `,
    code: "registration-positional-timeout",
  },
  {
    name: "spread registration options",
    source: `
      import { test } from "bun:test";
      const shared = { retry: 1 };
      test("spread", () => undefined, { ...shared });
    `,
    code: "registration-opaque-options",
  },
  {
    name: "skipped registration timeout",
    source: `
      import { xtest } from "bun:test";
      xtest("slow", () => undefined, 1_000);
    `,
    code: "registration-positional-timeout",
  },
];

describe("test harness policy", () => {
  for (const fixture of acceptedFixtures) {
    test(`accepts ${fixture.name}`, () => {
      expect(inspectTestSource("fixture.test.ts", fixture.source)).toEqual([]);
    });
  }

  for (const fixture of rejectedFixtures) {
    test(`rejects ${fixture.name}`, () => {
      const codes = inspectTestSource("fixture.test.ts", fixture.source)
        .map((entry) => entry.code);
      expect(codes).toContain(fixture.code);
    });
  }

  test("matches every Bun-discovered test and spec filename form", () => {
    for (const separator of [".", "_"]) {
      for (const label of ["test", "spec"]) {
        for (const extension of ["js", "jsx", "ts", "tsx"]) {
          expect(
            executableTestFilePattern.test(`example${separator}${label}.${extension}`),
          ).toBe(true);
        }
      }
    }

    for (const file of [
      "example.ts",
      "example-test.ts",
      "example.testing.ts",
      "example.test.d.ts",
      "example.test.mts",
      "example.test.cts",
      "example.TEST.ts",
      "test.ts",
      "spec.ts",
    ]) {
      expect(executableTestFilePattern.test(file)).toBe(false);
    }
  });

  test("scans underscore tests and test files nested beneath assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrench-test-harness-policy-"));
    try {
      await mkdir(join(root, "assets", "nested"), { recursive: true });
      await Promise.all([
        writeFile(
          join(root, "underscore_test.ts"),
          `import { test } from "bun:test"; test("slow", () => undefined, 1_000);`,
        ),
        writeFile(
          join(root, "assets", "nested", "fixture_spec.js"),
          `import { jest } from "bun:test"; jest.setTimeout(1_000);`,
        ),
        writeFile(
          join(root, "assets", "nested", "ordinary.ts"),
          `throw new Error("not a test file");`,
        ),
        writeFile(
          join(root, "looks-like.test.d.ts"),
          `import { setDefaultTimeout } from "bun:test";`,
        ),
      ]);

      const files = await executableTestFiles(root);
      expect(files.map((file) => displayPath(root, file))).toEqual([
        "assets/nested/fixture_spec.js",
        "underscore_test.ts",
      ]);

      const violations = (
        await Promise.all(files.map(async (file) => ({
          file: displayPath(root, file),
          codes: inspectTestSource(file, await readFile(file, "utf8"))
            .map((entry) => entry.code),
        })))
      );
      expect(violations).toEqual([
        {
          file: "assets/nested/fixture_spec.js",
          codes: ["jest-timeout-call"],
        },
        {
          file: "underscore_test.ts",
          codes: ["registration-positional-timeout"],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("all executable source tests use the package harness policy", async () => {
    const sourceRoot = import.meta.dir;
    const files = await executableTestFiles(sourceRoot);
    const violations = (
      await Promise.all(files.map(async (file) => {
        const source = await readFile(file, "utf8");
        return inspectTestSource(displayPath(sourceRoot, file), source);
      }))
    ).flat();

    expect(violations.map((entry) => (
      `${entry.file}:${entry.line}:${entry.column} [${entry.code}] ${entry.message}`
    ))).toEqual([]);
  });

  test("the package script owns timeout and concurrency limits", async () => {
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as unknown;
    if (
      typeof packageJson !== "object"
      || packageJson === null
      || !("scripts" in packageJson)
      || typeof packageJson.scripts !== "object"
      || packageJson.scripts === null
    ) {
      throw new Error("package.json scripts must be an object");
    }
    const scripts = packageJson.scripts as Record<string, unknown>;
    const readScript = (name: string): string => {
      const value = scripts[name];
      if (typeof value !== "string") {
        throw new Error(`package.json scripts.${name} must be a string`);
      }
      return value;
    };
    const unitCommand =
      "bun test --no-orphans --timeout 180000 --max-concurrency \"$"
      + "{GOMAXPROCS:-4}\" ./src --path-ignore-patterns='**/src/omni-runtime.test.ts'";
    const omniCommand =
      "bun test --no-orphans --timeout 180000 --max-concurrency 1"
      + " ./src/omni-runtime.test.ts";
    expect(readScript("test:unit")).toBe(unitCommand);
    expect(readScript("test:omni")).toBe(omniCommand);
    expect(readScript("test")).toBe("bun run test:unit && bun run test:omni");
    expect(readScript("test:shard")).toBe("bun run ./scripts/ci-test-shard.ts");
  });
});
