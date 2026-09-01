import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  runWhatsAppContactProjectionHelperChild,
  type WhatsAppContactProjectionHelperResult,
} from "./whatsapp-web-runtime";
import {
  WHATSAPP_CONTACT_PROJECTION_MAX_STDIN_BYTES,
  WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
  parseWhatsAppContactProjectionResponse,
  type WhatsAppContactProjectionRequest,
} from "./whatsapp-contact-projection-protocol";

const OWNER_JID = "15551234567:3@s.whatsapp.net";
const OWNER_LID = "999999999999999@lid";
const FIRST_CONTACT_JID = "15550000001@s.whatsapp.net";
const SECOND_CONTACT_JID = "222222222222222@lid";
const helper = join(import.meta.dir, "whatsapp-contact-projection-helper.ts");
const config = join(import.meta.dir, "../state-helper.bunfig.toml");

function privateDirectory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "wrench-wa-contact-helper-")));
  chmodSync(path, 0o700);
  return path;
}

function createStore(options: {
  readonly extraContactColumn?: boolean;
  readonly foreignKeyAction?: "CASCADE" | "RESTRICT";
  readonly duplicateLidOwner?: boolean;
  readonly craftedPrimaryIndexName?: boolean;
  readonly extraTables?: number;
  readonly extraContactForeignKeys?: number;
  readonly extraDeviceIndexes?: number;
  readonly overlongPnContact?: boolean;
  readonly overlongPnDevice?: boolean;
  readonly malformedSentinelContact?: boolean;
  readonly lidDeviceOwner?: boolean;
  readonly ownerJid?: string;
  readonly ownerLid?: string;
} = {}): string {
  const path = privateDirectory();
  const database = new Database(join(path, "session.db"), {
    create: true,
    strict: true,
  });
  try {
    const extraForeignKeys = Array.from(
      { length: options.extraContactForeignKeys ?? 0 },
      () => `,
        FOREIGN KEY (our_jid) REFERENCES whatsmeow_device(jid)
          ON DELETE CASCADE ON UPDATE CASCADE`,
    ).join("");
    const extraTables = Array.from(
      { length: options.extraTables ?? 0 },
      (_, index) => `CREATE TABLE unrelated_${index} (value TEXT);`,
    ).join("\n");
    const extraDeviceIndexes = Array.from(
      { length: options.extraDeviceIndexes ?? 0 },
      (_, index) => `CREATE INDEX device_lid_${index}
        ON whatsmeow_device(lid);`,
    ).join("\n");
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE whatsmeow_device (
        jid TEXT PRIMARY KEY,
        lid TEXT
      );
      CREATE TABLE whatsmeow_contacts (
        our_jid TEXT,
        their_jid TEXT,
        first_name TEXT,
        full_name TEXT,
        push_name TEXT,
        business_name TEXT,
        redacted_phone TEXT
        ${options.extraContactColumn === true ? ", unreviewed TEXT" : ""},
        ${options.craftedPrimaryIndexName === true
          ? "UNIQUE (first_name),"
          : ""}
        PRIMARY KEY (our_jid, their_jid),
        FOREIGN KEY (our_jid) REFERENCES whatsmeow_device(jid)
          ON DELETE ${options.foreignKeyAction ?? "CASCADE"}
          ON UPDATE CASCADE${extraForeignKeys}
      );
      ${extraTables}
      ${extraDeviceIndexes}
    `);
    const ownerJid = options.ownerJid
      ?? (options.lidDeviceOwner === true ? OWNER_LID : OWNER_JID);
    const ownerLid = options.ownerLid ?? OWNER_LID;
    database.query(
      "INSERT INTO whatsmeow_device (jid, lid) VALUES (?1, ?2)",
    ).run(ownerJid, ownerLid);
    database.query(
      "INSERT INTO whatsmeow_device (jid, lid) VALUES (?1, ?2)",
    ).run("18888888888@s.whatsapp.net", "888888888888888");
    if (options.overlongPnDevice === true) {
      database.query(
        "INSERT INTO whatsmeow_device (jid, lid) VALUES (?1, ?2)",
      ).run("123456789012345678901@s.whatsapp.net", null);
    }
    if (options.duplicateLidOwner === true) {
      database.query(
        "INSERT INTO whatsmeow_device (jid, lid) VALUES (?1, ?2)",
      ).run("17777777777@s.whatsapp.net", OWNER_LID);
    }
    const insert = database.query(`
      INSERT INTO whatsmeow_contacts (
        our_jid, their_jid, first_name, full_name,
        push_name, business_name, redacted_phone
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `);
    insert.run(
      ownerJid,
      options.overlongPnContact === true
        ? "123456789012345678901@s.whatsapp.net"
        : FIRST_CONTACT_JID,
      "Ada",
      "Ada Lovelace",
      "Ada Push",
      null,
      "+1 ••• ••• 0001",
    );
    insert.run(
      ownerJid,
      options.malformedSentinelContact === true
        ? "19999private@s.whatsapp.net"
        : SECOND_CONTACT_JID,
      "Lin",
      null,
      "Lin Push",
      "Lin Business",
      null,
    );
    insert.run(
      ownerJid,
      "120363123456789012@g.us",
      null,
      "Excluded Group",
      null,
      null,
      null,
    );
    insert.run(
      "18888888888@s.whatsapp.net",
      "19999999999@s.whatsapp.net",
      null,
      "Other Owner",
      null,
      null,
      null,
    );
  } finally {
    database.close();
  }
  chmodSync(join(path, "session.db"), 0o600);
  return path;
}

function corruptContactPrimaryIndex(path: string): void {
  const databasePath = join(path, "session.db");
  const database = new Database(databasePath, { readonly: true, strict: true });
  let pageNumber: number;
  let pageSize: number;
  try {
    const page = database.query(`
      SELECT rootpage
      FROM sqlite_schema
      WHERE type = 'index'
        AND name = 'sqlite_autoindex_whatsmeow_contacts_1'
        AND tbl_name = 'whatsmeow_contacts'
      LIMIT 1
    `).get() as { readonly rootpage?: unknown } | null;
    const size = database.query("PRAGMA page_size").get() as
      | { readonly page_size?: unknown }
      | null;
    if (
      page === null
      || typeof page.rootpage !== "number"
      || !Number.isSafeInteger(page.rootpage)
      || page.rootpage < 2
      || size === null
      || typeof size.page_size !== "number"
      || !Number.isSafeInteger(size.page_size)
      || size.page_size < 512
    ) throw new Error("fixture could not locate the contact primary index");
    pageNumber = page.rootpage;
    pageSize = size.page_size;
  } finally {
    database.close();
  }

  const descriptor = openSync(databasePath, "r+");
  try {
    const page = Buffer.alloc(pageSize);
    const position = (pageNumber - 1) * pageSize;
    if (readSync(descriptor, page, 0, page.length, position) !== page.length) {
      throw new Error("fixture could not read the contact primary index page");
    }
    if (page[0] !== 0x0a) {
      throw new Error("fixture contact primary index root is not a leaf page");
    }
    const marker = Buffer.from(FIRST_CONTACT_JID, "utf8");
    const markerOffset = page.indexOf(marker);
    if (markerOffset < 0) {
      throw new Error("fixture could not find the indexed contact key");
    }
    const replacement = Buffer.from("7", "utf8");
    if (
      writeSync(
        descriptor,
        replacement,
        0,
        replacement.length,
        position + markerOffset,
      ) !== replacement.length
    ) throw new Error("fixture could not corrupt the contact primary index");
    page.fill(0);
  } finally {
    closeSync(descriptor);
  }
}

function request(
  path: string,
  overrides: Partial<WhatsAppContactProjectionRequest> = {},
): WhatsAppContactProjectionRequest {
  const store = lstatSync(path, { bigint: true });
  const session = lstatSync(join(path, "session.db"), { bigint: true });
  return {
    schemaVersion: WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
    operation: "contacts.list",
    accountSubject: "whatsapp:pn:15551234567",
    cursor: null,
    limit: 1,
    storeIdentity: { dev: store.dev.toString(), ino: store.ino.toString() },
    sessionIdentity: {
      dev: session.dev.toString(),
      ino: session.ino.toString(),
    },
    ...overrides,
  };
}

async function invoke(
  path: string,
  requestValue: unknown,
): Promise<WhatsAppContactProjectionHelperResult> {
  return runWhatsAppContactProjectionHelperChild({
    command: [
      process.execPath,
      "--no-env-file",
      "--no-install",
      "--no-macros",
      "--no-addons",
      `--config=${config}`,
      helper,
    ],
    cwd: path,
    environment: {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
    },
    stdin: typeof requestValue === "string"
      ? requestValue
      : `${JSON.stringify(requestValue)}\n`,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    maxStderrBytes: 16 * 1024,
  });
}

async function response(path: string, requestValue: unknown) {
  const result = await invoke(path, requestValue);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return parseWhatsAppContactProjectionResponse(
    JSON.parse(result.stdout) as unknown,
  );
}

describe("WhatsApp account-bound contact projection helper", () => {
  test("projects only the matched owner with BINARY cursor paging", async () => {
    const path = createStore();
    try {
      const first = await response(path, request(path));
      expect(first).toEqual({
        schemaVersion: 1,
        status: "succeeded",
        contacts: [{
          providerId: FIRST_CONTACT_JID,
          jidKind: "user",
          phone: "15550000001",
          redactedPhone: "+1 ••• ••• 0001",
          firstName: "Ada",
          fullName: "Ada Lovelace",
          pushName: "Ada Push",
          businessName: null,
          displayName: "Ada Lovelace",
          displayNameBasis: "full-name",
        }],
        nextCursor: FIRST_CONTACT_JID,
        localContactTablePageComplete: false,
      });
      expect(await response(path, request(path, {
        accountSubject: "whatsapp:lid:999999999999999",
        cursor: FIRST_CONTACT_JID,
      }))).toEqual({
        schemaVersion: 1,
        status: "succeeded",
        contacts: [{
          providerId: SECOND_CONTACT_JID,
          jidKind: "lid",
          phone: null,
          redactedPhone: null,
          firstName: "Lin",
          fullName: null,
          pushName: "Lin Push",
          businessName: "Lin Business",
          displayName: "Lin Push",
          displayNameBasis: "push-name",
        }],
        nextCursor: null,
        localContactTablePageComplete: true,
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("fails closed on exact schema, FK action, and owner ambiguity", async () => {
    const cases = [
      { path: createStore({ extraContactColumn: true }), code: "schema-mismatch" },
      { path: createStore({ foreignKeyAction: "RESTRICT" }), code: "schema-mismatch" },
      {
        path: createStore({ craftedPrimaryIndexName: true }),
        code: "schema-mismatch",
      },
      {
        path: createStore({ overlongPnContact: true }),
        code: "projection-invalid",
      },
      {
        path: createStore({ overlongPnDevice: true }),
        code: "owner-mismatch",
      },
      { path: createStore({ duplicateLidOwner: true }), code: "owner-mismatch", lid: true },
      { path: createStore({ lidDeviceOwner: true }), code: "owner-mismatch", lid: true },
      {
        path: createStore({ ownerJid: "05551234567:3@s.whatsapp.net" }),
        code: "owner-mismatch",
        subject: "whatsapp:pn:05551234567",
      },
      {
        path: createStore({ ownerJid: "1234567890123456:3@s.whatsapp.net" }),
        code: "owner-mismatch",
        subject: "whatsapp:pn:1234567890123456",
      },
      {
        path: createStore({ ownerLid: "099999999999999@lid" }),
        code: "owner-mismatch",
        subject: "whatsapp:lid:099999999999999",
      },
      {
        path: createStore({ ownerLid: `${"9".repeat(21)}@lid` }),
        code: "owner-mismatch",
        subject: `whatsapp:lid:${"9".repeat(21)}`,
      },
    ] as const;
    try {
      for (const scenario of cases) {
        const projected = await response(
          scenario.path,
          request(scenario.path, "subject" in scenario
            ? { accountSubject: scenario.subject }
            : "lid" in scenario && scenario.lid === true
              ? { accountSubject: "whatsapp:lid:999999999999999" }
              : {}),
        );
        expect(projected).toEqual({
          schemaVersion: 1,
          status: "failed",
          errorCode: scenario.code,
        });
      }
      expect(await response(cases[0].path, request(cases[0].path, {
        accountSubject: "whatsapp:pn:19999999999",
      }))).toMatchObject({ status: "failed" });
    } finally {
      for (const scenario of cases) {
        rmSync(scenario.path, { recursive: true, force: true });
      }
    }
  });

  test("bounds schema, foreign-key, and index metadata iteration", async () => {
    const manyTables = createStore({ extraTables: 300 });
    const manyForeignKeys = createStore({ extraContactForeignKeys: 64 });
    const manyIndexes = createStore({ extraDeviceIndexes: 300 });
    try {
      expect(await response(manyTables, request(manyTables))).toMatchObject({
        status: "succeeded",
      });
      for (const path of [manyForeignKeys, manyIndexes]) {
        expect(await response(path, request(path))).toEqual({
          schemaVersion: 1,
          status: "failed",
          errorCode: "schema-mismatch",
        });
      }
    } finally {
      rmSync(manyTables, { recursive: true, force: true });
      rmSync(manyForeignKeys, { recursive: true, force: true });
      rmSync(manyIndexes, { recursive: true, force: true });
    }
  });

  test("validates the limit-plus-one sentinel before issuing a cursor", async () => {
    const path = createStore({ malformedSentinelContact: true });
    try {
      expect(await response(path, request(path, { limit: 1 }))).toEqual({
        schemaVersion: 1,
        status: "failed",
        errorCode: "projection-invalid",
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("uses bounded integrity checking to reject index-content corruption", async () => {
    const path = createStore();
    try {
      corruptContactPrimaryIndex(path);
      const database = new Database(join(path, "session.db"), {
        readonly: true,
        strict: true,
      });
      try {
        expect(Object.values(database.query("PRAGMA quick_check(1)").get()!)[0])
          .toBe("ok");
        expect(Object.values(database.query("PRAGMA integrity_check(1)").get()!)[0])
          .not.toBe("ok");
      } finally {
        database.close();
      }
      expect(await response(path, request(path))).toMatchObject({
        status: "failed",
        errorCode: "database-integrity-failed",
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("uses no-follow and rejects SQLite sidecars", async () => {
    const linked = createStore();
    const sidecar = createStore();
    try {
      renameSync(join(linked, "session.db"), join(linked, "target.db"));
      symlinkSync("target.db", join(linked, "session.db"));
      expect(await response(linked, request(linked))).toMatchObject({
        status: "failed",
        errorCode: "session-file-invalid",
      });

      writeFileSync(join(sidecar, "session.db-wal"), "private sidecar contents");
      chmodSync(join(sidecar, "session.db-wal"), 0o600);
      expect(await response(sidecar, request(sidecar))).toMatchObject({
        status: "failed",
        errorCode: "session-sidecar-present",
      });
    } finally {
      rmSync(linked, { recursive: true, force: true });
      rmSync(sidecar, { recursive: true, force: true });
    }
  });

  test("rejects stale session and store identities after path replacement", async () => {
    const sessionStore = createStore();
    const sessionReplacement = createStore();
    const directoryStore = createStore();
    const directoryReplacement = createStore();
    const movedDirectory = `${directoryStore}.moved`;
    try {
      const staleSessionRequest = request(sessionStore);
      renameSync(
        join(sessionStore, "session.db"),
        join(sessionStore, "session.db.original"),
      );
      renameSync(
        join(sessionReplacement, "session.db"),
        join(sessionStore, "session.db"),
      );
      expect(await response(sessionStore, staleSessionRequest)).toMatchObject({
        status: "failed",
        errorCode: "session-file-invalid",
      });

      const staleDirectoryRequest = request(directoryStore);
      renameSync(directoryStore, movedDirectory);
      renameSync(directoryReplacement, directoryStore);
      expect(await response(directoryStore, staleDirectoryRequest)).toMatchObject({
        status: "failed",
        errorCode: "store-binding-invalid",
      });
    } finally {
      rmSync(sessionStore, { recursive: true, force: true });
      rmSync(sessionReplacement, { recursive: true, force: true });
      rmSync(directoryStore, { recursive: true, force: true });
      rmSync(directoryReplacement, { recursive: true, force: true });
      rmSync(movedDirectory, { recursive: true, force: true });
    }
  });

  test("rejects unsafe permissions and empty or oversized session files", async () => {
    const permissions = createStore();
    const empty = createStore();
    const oversized = createStore();
    try {
      chmodSync(join(permissions, "session.db"), 0o644);
      truncateSync(join(empty, "session.db"), 0);
      truncateSync(join(oversized, "session.db"), 128 * 1024 * 1024 + 1);
      expect(await response(permissions, request(permissions))).toMatchObject({
        status: "failed",
        errorCode: "session-file-invalid",
      });
      for (const path of [empty, oversized]) {
        expect(await response(path, request(path))).toMatchObject({
          status: "failed",
          errorCode: "session-file-too-large",
        });
      }
    } finally {
      rmSync(permissions, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
      rmSync(oversized, { recursive: true, force: true });
    }
  });

  test("bounds input and returns only redacted categorical failures", async () => {
    const path = createStore();
    try {
      const privateMarker = `${path}/${FIRST_CONTACT_JID}/Ada Lovelace`;
      const result = await invoke(
        path,
        `${privateMarker}${"x".repeat(WHATSAPP_CONTACT_PROJECTION_MAX_STDIN_BYTES)}\n`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain('"errorCode":"request-invalid"');
      expect(result.stdout).not.toContain(path);
      expect(result.stdout).not.toContain(FIRST_CONTACT_JID);
      expect(result.stdout).not.toContain("Ada Lovelace");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
