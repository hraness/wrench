import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeInternalHarValue } from "./har-internal";
import { parseRuntimeManifest } from "./model";
import {
  isValidatedProviderPlugin,
  type ProviderPluginV1,
} from "./provider-plugin";
import { createProviderPluginRegistry } from "./provider-plugin-registry";
import {
  checkSourceProviderPluginDirectory,
  scaffoldWebProvider,
} from "./scripts/scaffold-web-provider";

const roots: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): {
  readonly root: string;
  readonly evidence: string;
  readonly output: string;
} {
  const root = mkdtempSync(join(tmpdir(), "wrench-provider-scaffold-"));
  roots.push(root);
  const evidence = join(root, "internal-api-evidence.json");
  writeFileSync(
    evidence,
    `${JSON.stringify({
      schemaVersion: 1,
      adapterId: "acme-web",
      targetOrigin: "https://www.acme.example",
      analyzedAt: "2026-07-23T00:00:00.000Z",
      observedEntries: 1,
      candidates: [{
        method: "GET",
        origin: "https://www.acme.example",
        path: "/api/items/:dynamic",
        operationType: "unknown",
        sampleCount: 1,
        statuses: [200],
        queryNames: [],
        headerNames: ["accept", "cookie"],
        requestFieldPaths: [],
        responseFieldPaths: ["$.data.items"],
        revisions: [],
        reviewRequired: true,
      }],
      warnings: [],
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(evidence, 0o600);
  return { root, evidence, output: join(root, "scaffold") };
}

function canonicalPluginOutput(pluginId: string): string {
  const containedRoot = mkdtempSync(join(import.meta.dir, ".provider-scaffold-test-"));
  roots.push(containedRoot);
  const wrenchRoot = join(containedRoot, "skills", "wrench");
  const outputDirectory = join(wrenchRoot, "plugins", pluginId);
  mkdirSync(wrenchRoot, { recursive: true });
  writeFileSync(
    join(wrenchRoot, "provider-plugin.ts"),
    `export { defineProviderPlugin, lazyWebSessionRuntime } from ${JSON.stringify(
      join(import.meta.dir, "provider-plugin.ts"),
    )};\n`,
  );
  writeFileSync(join(wrenchRoot, "auth.ts"), "export {};\n");
  writeFileSync(join(wrenchRoot, "web-session.ts"), "export {};\n");
  return outputDirectory;
}

describe("code-owned web provider scaffold", () => {
  test("is exposed through the public wrench CLI without widening its authority", async () => {
    const value = fixture();
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "wrench.ts"),
      "plugin",
      "scaffold",
      "--site", "acme",
      "--display-name", "Acme",
      "--origin", "https://www.acme.example",
      "--operation", "feeds.read",
      "--risk", "R1",
      "--evidence", value.evidence,
      "--candidate", "0",
      "--output", value.output,
      "--json",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      status: "capture-required",
      executable: false,
      pluginId: "acme-web",
      outputDirectory: value.output,
      files: [
        "plugin.ts",
        "runtime.ts",
        "plugin.test.ts",
        "runtime.internal.test.ts",
        "wrench-adapter.json",
        "promotion-checklist.json",
      ],
      next:
        "Review the source unit at src/plugins/acme-web, then run 'wrench plugin check src/plugins/acme-web'; the scaffold performs no request and contains no browser action.",
    });
    expect(stdout).not.toContain("/api/items");
  });

  test("runs as a CLI and reports only generated relative paths", async () => {
    const value = fixture();
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "scripts", "scaffold-web-provider.ts"),
      "--site", "acme",
      "--display-name", "Acme",
      "--origin", "https://www.acme.example",
      "--operation", "messaging.send",
      "--risk", "R3",
      "--evidence", value.evidence,
      "--candidate", "0",
      "--output", value.output,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout) as {
      readonly status: string;
      readonly outputDirectory: string;
      readonly files: readonly string[];
    };
    expect(result).toEqual({
      status: "capture-required",
      outputDirectory: value.output,
      files: [
        "plugin.ts",
        "runtime.ts",
        "plugin.test.ts",
        "runtime.internal.test.ts",
        "wrench-adapter.json",
        "promotion-checklist.json",
      ],
    });
    expect(stdout).not.toContain("/api/items");
  });

  test("binds sanitized evidence and emits only a network-inert capture-required skeleton", () => {
    const value = fixture();
    const files = scaffoldWebProvider({
      site: "acme",
      displayName: "Acme",
      origin: "https://www.acme.example",
      operation: "feeds.read",
      risk: "R1",
      evidencePath: value.evidence,
      candidateIndex: 0,
      outputDirectory: value.output,
    });

    expect(files).toHaveLength(6);
    const plugin = readFileSync(join(value.output, "plugin.ts"), "utf8");
    const runtime = readFileSync(
      join(value.output, "runtime.ts"),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(
        join(value.output, "wrench-adapter.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const checklist = JSON.parse(
      readFileSync(join(value.output, "promotion-checklist.json"), "utf8"),
    ) as {
      readonly state: string;
      readonly sanitizedEvidence: { readonly sha256: string; readonly candidateIndex: number };
      readonly proofs: Readonly<Record<string, boolean>>;
    };

    expect(plugin).toContain('"feeds.read"');
    expect(plugin).toContain('state: "capture-required"');
    expect(runtime).toContain("deliberately network-inert");
    expect(runtime).not.toContain("fetch(");
    expect(runtime).not.toContain("page.click");
    expect(JSON.stringify(manifest)).not.toContain("reviewedTemplate");
    expect(JSON.stringify(manifest)).not.toContain("/api/items");
    expect(checklist.state).toBe("capture-required");
    expect(checklist.sanitizedEvidence.candidateIndex).toBe(0);
    expect(checklist.sanitizedEvidence.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.values(checklist.proofs).every((proved) => proved === false)).toBe(true);
    expect(statSync(value.output).mode & 0o077).toBe(0);
    for (const file of files) expect(statSync(file).mode & 0o077).toBe(0);
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    for (const file of files.filter((path) => path.endsWith(".ts"))) {
      expect(() => transpiler.transformSync(readFileSync(file, "utf8"))).not.toThrow();
    }
  });

  test("accepts the operationType emitted by real internal HAR analysis", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-provider-analysis-scaffold-"));
    roots.push(root);
    const evidencePath = join(root, "internal-api-evidence.json");
    const outputDirectory = join(root, "linkedin-web");
    const revision = "0123456789abcdef0123456789abcdef";
    const url = new URL(
      "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql",
    );
    url.searchParams.set("queryId", `messengerConversations.${revision}`);
    const evidence = analyzeInternalHarValue({
      log: {
        version: "1.2",
        creator: { name: "scaffold-regression", version: "1" },
        entries: [{
          request: {
            method: "GET",
            url: url.href,
            headers: [],
            queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
          },
          response: {
            status: 200,
            headers: [],
            content: { mimeType: "application/json", text: "{\"data\":{}}" },
          },
        }],
      },
    }, "linkedin-web", "https://www.linkedin.com", new Date("2026-07-24T00:00:00.000Z"));
    expect(evidence.candidates[0]?.operationType).toBe("query");
    writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
    chmodSync(evidencePath, 0o600);

    expect(scaffoldWebProvider({
      site: "linkedin",
      displayName: "LinkedIn",
      origin: "https://www.linkedin.com",
      operation: "feeds.read",
      risk: "R1",
      evidencePath,
      candidateIndex: 0,
      outputDirectory,
    }).map((path) => path.slice(outputDirectory.length + 1))).toEqual([
      "plugin.ts",
      "runtime.ts",
      "plugin.test.ts",
      "runtime.internal.test.ts",
      "wrench-adapter.json",
      "promotion-checklist.json",
    ]);
  });

  test("checks without source execution and emits a real ProviderPluginV1", async () => {
    const value = fixture();
    const outputDirectory = canonicalPluginOutput("acme-web");
    scaffoldWebProvider({
      site: "acme",
      displayName: "Acme",
      origin: "https://www.acme.example",
      operation: "feeds.read",
      risk: "R1",
      evidencePath: value.evidence,
      candidateIndex: 0,
      outputDirectory,
    });

    expect(checkSourceProviderPluginDirectory(outputDirectory)).toEqual({
      status: "capture-required",
      executable: false,
      pluginId: "acme-web",
      directory: outputDirectory,
      files: [
        "plugin.ts",
        "runtime.ts",
        "plugin.test.ts",
        "runtime.internal.test.ts",
        "wrench-adapter.json",
        "promotion-checklist.json",
      ],
    });
    const generatedPluginModule: unknown = await import(
      join(outputDirectory, "plugin.ts")
    );
    if (!isRecord(generatedPluginModule)) {
      throw new Error("generated plugin module did not export an object");
    }
    expect(generatedPluginModule["default"]).toMatchObject({
      apiVersion: 1,
      id: "acme-web",
      sourceKind: "source",
      bindings: [{
        transport: "web-session-api",
        surfaceId: "acme",
        operations: [{ name: "feeds.read", contractVersions: [1] }],
      }],
    });
    const checkedThroughWrench = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "wrench.ts"),
      "plugin",
      "check",
      outputDirectory,
      "--json",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [checkExitCode, checkStdout, checkStderr] = await Promise.all([
      checkedThroughWrench.exited,
      new Response(checkedThroughWrench.stdout).text(),
      new Response(checkedThroughWrench.stderr).text(),
    ]);
    if (checkExitCode !== 0) {
      throw new Error(`wrench plugin check failed:\n${checkStdout}\n${checkStderr}`);
    }
    expect(JSON.parse(checkStdout)).toEqual({
      status: "capture-required",
      executable: false,
      pluginId: "acme-web",
      directory: outputDirectory,
      files: [
        "plugin.ts",
        "runtime.ts",
        "plugin.test.ts",
        "runtime.internal.test.ts",
        "wrench-adapter.json",
        "promotion-checklist.json",
      ],
    });
    const generatedTests = Bun.spawn([
      process.execPath,
      "test",
      join(outputDirectory, "plugin.test.ts"),
      join(outputDirectory, "runtime.internal.test.ts"),
    ], {
      cwd: outputDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [generatedTestExitCode, generatedTestStdout, generatedTestStderr] =
      await Promise.all([
        generatedTests.exited,
        new Response(generatedTests.stdout).text(),
        new Response(generatedTests.stderr).text(),
      ]);
    if (generatedTestExitCode !== 0) {
      throw new Error(
        `generated plugin tests failed:\n${generatedTestStdout}\n${generatedTestStderr}`,
      );
    }

    const runtimePath = join(outputDirectory, "runtime.ts");
    writeFileSync(
      runtimePath,
      `${readFileSync(runtimePath, "utf8")}\nfetch("https://www.acme.example");\n`,
    );
    expect(() => checkSourceProviderPluginDirectory(outputDirectory))
      .toThrow("must remain network-inert");
  });

  test("accepts the predecessor adapter manifest name but rejects ambiguity", () => {
    const value = fixture();
    const outputDirectory = canonicalPluginOutput("acme-web");
    scaffoldWebProvider({
      site: "acme",
      displayName: "Acme",
      origin: "https://www.acme.example",
      operation: "feeds.read",
      risk: "R1",
      evidencePath: value.evidence,
      candidateIndex: 0,
      outputDirectory,
    });
    renameSync(
      join(outputDirectory, "wrench-adapter.json"),
      join(outputDirectory, "oh-adapter.json"),
    );
    expect(() => checkSourceProviderPluginDirectory(outputDirectory)).not.toThrow();
    writeFileSync(
      join(outputDirectory, "wrench-adapter.json"),
      readFileSync(join(outputDirectory, "oh-adapter.json")),
    );
    expect(() => checkSourceProviderPluginDirectory(outputDirectory))
      .toThrow("must contain exactly one");
  });

  test("round-trips the exact installable ID and display-name bounds", async () => {
    const maximum = fixture();
    const maximumSite = `a${"b".repeat(43)}`;
    const maximumPluginId = `${maximumSite}-web`;
    const maximumDisplayName = `A${"b".repeat(75)}`;
    const outputDirectory = canonicalPluginOutput(maximumPluginId);
    scaffoldWebProvider({
      site: maximumSite,
      displayName: maximumDisplayName,
      origin: "https://www.acme.example",
      operation: "feeds.read",
      risk: "R1",
      evidencePath: maximum.evidence,
      candidateIndex: 0,
      outputDirectory,
    });
    const manifest: unknown = JSON.parse(
      readFileSync(join(outputDirectory, "wrench-adapter.json"), "utf8"),
    );
    const checklist = JSON.parse(
      readFileSync(join(outputDirectory, "promotion-checklist.json"), "utf8"),
    ) as { readonly pluginId: string };
    expect(checklist.pluginId).toBe(maximumPluginId);
    expect(checklist.pluginId).toHaveLength(48);
    if (
      !isRecord(manifest)
      || typeof manifest.displayName !== "string"
    ) throw new Error("generated manifest is not an object with a display name");
    expect(manifest).toMatchObject({
      id: maximumPluginId,
      displayName: `${maximumDisplayName} (Authenticated Web API)`,
    });
    expect(manifest.displayName.length).toBe(100);

    const generatedPluginModule: unknown = await import(
      join(outputDirectory, "plugin.ts")
    );
    if (!isRecord(generatedPluginModule)) {
      throw new Error("generated plugin module did not export a validated plugin");
    }
    const generatedPlugin =
      generatedPluginModule["default"] as ProviderPluginV1;
    if (!isValidatedProviderPlugin(generatedPlugin)) {
      throw new Error("generated plugin module did not export a validated plugin");
    }
    const parsed = parseRuntimeManifest(
      manifest,
      createProviderPluginRegistry([generatedPlugin]),
    );
    expect(parsed.ok, parsed.ok ? undefined : parsed.issues.join("; ")).toBeTrue();
    expect(() => checkSourceProviderPluginDirectory(outputDirectory)).not.toThrow();

    const tooLongSite = fixture();
    expect(() => scaffoldWebProvider({
      site: `a${"b".repeat(44)}`,
      displayName: "Bounded",
      origin: "https://www.acme.example",
      operation: "feeds.read",
      risk: "R1",
      evidencePath: tooLongSite.evidence,
      candidateIndex: 0,
      outputDirectory: tooLongSite.output,
    })).toThrow("at most 44 characters");

    const tooLongDisplayName = fixture();
    expect(() => scaffoldWebProvider({
      site: "acme",
      displayName: `A${"b".repeat(76)}`,
      origin: "https://www.acme.example",
      operation: "feeds.read",
      risk: "R1",
      evidencePath: tooLongDisplayName.evidence,
      candidateIndex: 0,
      outputDirectory: tooLongDisplayName.output,
    })).toThrow("at most 76 characters");
  });

  test("rejects raw-looking transport operations, mismatched evidence, and unsafe evidence modes", () => {
    const operation = fixture();
    expect(() => scaffoldWebProvider({
      site: "acme",
      displayName: "Acme",
      origin: "https://www.acme.example",
      operation: "graphql.call",
      risk: "R1",
      evidencePath: operation.evidence,
      candidateIndex: 0,
      outputDirectory: operation.output,
    })).toThrow("semantic outcome");

    const riskMismatch = fixture();
    expect(() => scaffoldWebProvider({
      site: "acme",
      displayName: "Acme",
      origin: "https://www.acme.example",
      operation: "messaging.send",
      risk: "R1",
      evidencePath: riskMismatch.evidence,
      candidateIndex: 0,
      outputDirectory: riskMismatch.output,
    })).toThrow("must use R3");

    const mismatch = fixture();
    expect(() => scaffoldWebProvider({
      site: "acme",
      displayName: "Acme",
      origin: "https://api.acme.example",
      operation: "feeds.read",
      risk: "R1",
      evidencePath: mismatch.evidence,
      candidateIndex: 0,
      outputDirectory: mismatch.output,
    })).toThrow("schema and origin");

    const publicEvidence = fixture();
    chmodSync(publicEvidence.evidence, 0o644);
    expect(() => scaffoldWebProvider({
      site: "acme",
      displayName: "Acme",
      origin: "https://www.acme.example",
      operation: "feeds.read",
      risk: "R1",
      evidencePath: publicEvidence.evidence,
      candidateIndex: 0,
      outputDirectory: publicEvidence.output,
    })).toThrow("group or others");
  });

  test("refuses to overwrite an existing scaffold directory", () => {
    const value = fixture();
    writeFileSync(value.output, "occupied");
    expect(() => scaffoldWebProvider({
      site: "acme",
      displayName: "Acme",
      origin: "https://www.acme.example",
      operation: "posts.publish",
      risk: "R3",
      evidencePath: value.evidence,
      candidateIndex: 0,
      outputDirectory: value.output,
    })).toThrow("non-directory");
  });
});
