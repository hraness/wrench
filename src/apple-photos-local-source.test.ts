import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  APPLE_CONTACTS_SCHEMA_SHA256,
  APPLE_PHOTOS_SCHEMA_SHA256,
  exportApplePhotosContactEvidence,
  resolveApplePhotosAccountHomeDirectory,
} from "./apple-photos-local-source";

const roots: string[] = [];
const FIXED_TIME = new Date("2026-08-28T12:34:56.000Z");
const FIXED_RUN = "123e4567-e89b-42d3-a456-426614174000";

type Fixture = Readonly<{
  root: string;
  home: string;
  library: string;
  temporary: string;
  photosPath: string;
  photos: Database;
  contacts: readonly Database[];
}>;

function fixture(options: Readonly<{ schemaDrift?: boolean }> = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(
    realpathSync(tmpdir()),
    "wrench-apple-photos-source-",
  )));
  roots.push(root);
  const home = join(root, "home");
  const library = join(home, "Pictures", "Photos Library.photoslibrary");
  const photosDirectory = join(library, "database");
  const contactsRoot = join(
    home,
    "Library",
    "Application Support",
    "AddressBook",
  );
  const sourceRoot = join(
    contactsRoot,
    "Sources",
    "11111111-1111-4111-8111-111111111111",
  );
  const temporary = join(root, "temporary");
  mkdirSync(photosDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });

  const photosPath = join(photosDirectory, "Photos.sqlite");
  const photos = new Database(photosPath, { create: true, strict: true });
  photos.exec("PRAGMA journal_mode = WAL");
  photos.exec("PRAGMA wal_autocheckpoint = 0");
  photos.exec(options.schemaDrift === true ? `
    CREATE TABLE ZPERSON (
      Z_PK INTEGER PRIMARY KEY,
      ZPERSONUUID VARCHAR,
      ZDISPLAYNAME VARCHAR,
      ZCONTACTMATCHINGDICTIONARY BLOB
    );
  ` : `
    CREATE TABLE ZPERSON (
      Z_PK INTEGER PRIMARY KEY,
      ZPERSONUUID VARCHAR,
      ZPERSONURI VARCHAR,
      ZDISPLAYNAME VARCHAR,
      ZCONTACTMATCHINGDICTIONARY BLOB
    );
  `);
  photos.exec(`
    CREATE TABLE ZDETECTEDFACE (
      Z_PK INTEGER PRIMARY KEY,
      ZPERSONFORFACE INTEGER,
      ZASSETFORFACE INTEGER,
      ZFACEPRINT BLOB,
      ZTHUMBNAILIDENTIFIER VARCHAR
    );
    CREATE TABLE ZASSET (
      Z_PK INTEGER PRIMARY KEY,
      ZDATECREATED TIMESTAMP,
      ZFILENAME VARCHAR,
      ZLATITUDE FLOAT,
      ZLONGITUDE FLOAT,
      ZLOCATIONDATA BLOB
    );
  `);
  if (options.schemaDrift !== true) {
    photos.query(`
      INSERT INTO ZPERSON (
        Z_PK, ZPERSONUUID, ZPERSONURI, ZDISPLAYNAME,
        ZCONTACTMATCHINGDICTIONARY
      ) VALUES (?1, ?2, ?3, ?4, ?5)
    `).run(
      1,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "CONTACT-001:ABPerson",
      "PRIVATE_MATCHED_NAME",
      Buffer.from("PRIVATE_MATCH_BLOB"),
    );
    photos.query(`
      INSERT INTO ZPERSON (
        Z_PK, ZPERSONUUID, ZPERSONURI, ZDISPLAYNAME,
        ZCONTACTMATCHINGDICTIONARY
      ) VALUES (?1, ?2, ?3, ?4, ?5)
    `).run(
      2,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "CONTACT-UNMATCHED:ABPerson",
      "PRIVATE_UNMATCHED_NAME",
      Buffer.from("PRIVATE_UNMATCHED_BLOB"),
    );
    photos.exec(`
      INSERT INTO ZASSET (
        Z_PK, ZDATECREATED, ZFILENAME, ZLATITUDE, ZLONGITUDE,
        ZLOCATIONDATA
      ) VALUES
        (10, 0, 'PRIVATE_ONE.jpg', 18.4, -66.1, X'010203'),
        (11, 86400, 'PRIVATE_TWO.jpg', 19.0, -67.0, X'040506'),
        (12, 172800, 'PRIVATE_UNMATCHED.jpg', 20.0, -68.0, X'070809');
      INSERT INTO ZDETECTEDFACE (
        Z_PK, ZPERSONFORFACE, ZASSETFORFACE, ZFACEPRINT,
        ZTHUMBNAILIDENTIFIER
      ) VALUES
        (100, 1, 10, X'1011', 'PRIVATE_CROP_ONE'),
        (101, 1, 10, X'1213', 'PRIVATE_CROP_TWO'),
        (102, 1, 11, X'1415', 'PRIVATE_CROP_THREE'),
        (103, 2, 12, X'1617', 'PRIVATE_CROP_UNMATCHED');
    `);
  }

  const contactPaths = [
    join(contactsRoot, "AddressBook-v22.abcddb"),
    join(sourceRoot, "AddressBook-v22.abcddb"),
  ];
  const contacts = contactPaths.map((path, index) => {
    const database = new Database(path, { create: true, strict: true });
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA wal_autocheckpoint = 0");
    database.exec(`
      CREATE TABLE ZABCDRECORD (
        Z_PK INTEGER PRIMARY KEY,
        ZUNIQUEID VARCHAR,
        ZFIRSTNAME VARCHAR,
        ZLASTNAME VARCHAR,
        ZIMAGEDATA BLOB,
        ZTHUMBNAILIMAGEDATA BLOB
      );
    `);
    database.query(`
      INSERT INTO ZABCDRECORD (
        Z_PK, ZUNIQUEID, ZFIRSTNAME, ZLASTNAME, ZIMAGEDATA,
        ZTHUMBNAILIMAGEDATA
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(
      index + 1,
      index === 0 ? "CONTACT-001:ABPerson" : "CONTACT-OTHER:ABPerson",
      "PRIVATE_CONTACT_FIRST",
      "PRIVATE_CONTACT_LAST",
      Buffer.from("PRIVATE_CONTACT_IMAGE"),
      Buffer.from("PRIVATE_CONTACT_THUMBNAIL"),
    );
    return database;
  });
  return Object.freeze({
    root,
    home,
    library,
    temporary,
    photosPath,
    photos,
    contacts: Object.freeze(contacts),
  });
}

function dependencies(value: Fixture) {
  return {
    platform: "darwin" as const,
    resolveAccountHomeDirectory: () => value.home,
    temporaryDirectory: value.temporary,
    now: () => FIXED_TIME,
    runId: () => FIXED_RUN,
  };
}

function close(value: Fixture): void {
  value.photos.close(false);
  for (const database of value.contacts) database.close(false);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Apple Photos local source", () => {
  test("resolves the OS account home independently of ambient source variables", () => {
    const accountHome = resolveApplePhotosAccountHomeDirectory();
    const keys = ["HOME", "TMPDIR", "TMP", "TEMP"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) process.env[key] = `/private/untrusted-${key.toLowerCase()}`;
      expect(resolveApplePhotosAccountHomeDirectory()).toBe(accountHome);
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("uses one account-home authority for conventional Photos and Contacts sources", async () => {
    const value = fixture();
    const ambientHome = join(value.root, "ambient-home");
    mkdirSync(ambientHome, { mode: 0o700 });
    const previousHome = process.env.HOME;
    process.env.HOME = ambientHome;
    try {
      const result = await exportApplePhotosContactEvidence({
        dependencies: dependencies(value),
      });
      expect(result.output.counts).toMatchObject({
        matchedPeople: 1,
      });
      expect(result.receipt.counts.contactsDatabases).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      close(value);
    }
  });

  test("pins the reviewed query-relevant Core Data schema identities", () => {
    expect(APPLE_PHOTOS_SCHEMA_SHA256).toBe(
      "698ba28c3216c2c8b7f65e1487aff54137cb5f53db4295fe40f33b196c80f6c4",
    );
    expect(APPLE_CONTACTS_SCHEMA_SHA256).toBe(
      "81056edfd5f336cfeba9b4babc057c6dea4aa23c336d1443385c03801a19c6de",
    );
  });

  test("reads exact WAL-backed contact matches without projecting private fields", async () => {
    const value = fixture();
    const environment = { WRENCH_STATE_HOME: join(value.root, "state") };
    const leaseRoot = join(
      environment.WRENCH_STATE_HOME,
      "recovery",
      "beeper-message-like-me-directory-leases",
    );
    let observedSnapshotLease = false;
    const capturedNames = new Set<string>();
    const sourceFiles = [
      value.photosPath,
      `${value.photosPath}-wal`,
      `${value.photosPath}-shm`,
    ];
    const before = sourceFiles.map((path) => lstatSync(path, { bigint: true }));
    const result = await exportApplePhotosContactEvidence({
      library: value.library,
      stateEnvironment: environment,
      dependencies: {
        ...dependencies(value),
        afterDatabaseCaptured: () => {
          observedSnapshotLease ||= existsSync(leaseRoot)
            && readdirSync(leaseRoot).length === 1;
          const snapshotName = readdirSync(value.temporary).find((name) =>
            name.startsWith("wrench-apple-photos-"));
          if (snapshotName !== undefined) {
            for (const name of readdirSync(join(value.temporary, snapshotName))) {
              capturedNames.add(name);
            }
          }
        },
      },
    });
    const after = sourceFiles.map((path) => lstatSync(path, { bigint: true }));
    expect(result.output.source).toMatchObject({
      id: "apple-photos-local",
      version: "1.0.0",
      libraryRealmSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      photosSchemaSha256: APPLE_PHOTOS_SCHEMA_SHA256,
      contactsSchemaSha256: APPLE_CONTACTS_SCHEMA_SHA256,
    });
    expect(result.output.source.capture).toEqual({
      startedAt: FIXED_TIME.toISOString(),
      finishedAt: FIXED_TIME.toISOString(),
      photos: {
        startedAt: FIXED_TIME.toISOString(),
        finishedAt: FIXED_TIME.toISOString(),
      },
      contacts: [
        {
          ordinal: 0,
          startedAt: FIXED_TIME.toISOString(),
          finishedAt: FIXED_TIME.toISOString(),
        },
        {
          ordinal: 1,
          startedAt: FIXED_TIME.toISOString(),
          finishedAt: FIXED_TIME.toISOString(),
        },
      ],
      consistency: "independent-read-transactions",
      crossDatabaseAtomicity: "not-asserted",
    });
    expect(result.output.scope.assets).toBe(
      "distinct-zasset-rows-linked-through-detected-faces",
    );
    expect(result.output.evidence).toEqual([{
      photosPersonId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      appleContactId: "CONTACT-001:ABPerson",
      linkedFaceCount: 3,
      linkedAssetCount: 2,
      firstAssetAt: "2001-01-01T00:00:00.000Z",
      lastAssetAt: "2001-01-02T00:00:00.000Z",
    }]);
    expect(result.receipt.counts.contactsDatabases).toBe(2);
    expect(result.output.completeness.remoteSync).toBe("not-asserted");
    expect(result.output.privacy).toEqual({
      names: "excluded-from-returned-json",
      localPaths: "excluded-from-returned-json",
      images: "excluded-from-returned-json",
      media: "excluded-from-returned-json",
      locations: "excluded-from-returned-json",
      rawContactData: "excluded-from-returned-json",
      rawPhotosData: "excluded-from-returned-json",
      faceClusterIdentifiers: "included-biometric-derived-private-metadata",
      faceClusterCounts: "included-biometric-derived-private-metadata",
      faceprintTemplates: "excluded-from-returned-json",
      faceCrops: "excluded-from-returned-json",
      unmatchedPeople: "excluded-from-returned-json",
    });
    const wire = JSON.stringify(result);
    for (const forbidden of [
      value.root,
      "PRIVATE_",
      "CONTACT-UNMATCHED",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "ZCONTACTMATCHINGDICTIONARY",
      "ZFACEPRINT",
      "ZLOCATIONDATA",
    ]) expect(wire).not.toContain(forbidden);
    for (const [index, prior] of before.entries()) {
      expect(after[index]?.dev).toBe(prior.dev);
      expect(after[index]?.ino).toBe(prior.ino);
      expect(after[index]?.size).toBe(prior.size);
      expect(after[index]?.mtimeNs).toBe(prior.mtimeNs);
      expect(after[index]?.ctimeNs).toBe(prior.ctimeNs);
    }
    expect(readdirSync(value.temporary)).toEqual([]);
    expect([...capturedNames].sort()).toEqual([
      "contacts-00.sqlite",
      "contacts-01.sqlite",
      "photos.sqlite",
    ]);
    expect([...capturedNames].some((name) =>
      name.endsWith("-wal") || name.endsWith("-shm"))).toBeFalse();
    expect(observedSnapshotLease).toBeTrue();
    expect(readdirSync(leaseRoot)).toEqual([]);
    close(value);
  });

  test("is idempotent for the same stable snapshot", async () => {
    const value = fixture();
    const first = await exportApplePhotosContactEvidence({
      library: value.library,
      dependencies: dependencies(value),
    });
    const second = await exportApplePhotosContactEvidence({
      library: value.library,
      dependencies: dependencies(value),
    });
    expect(second).toEqual(first);
    close(value);
  });

  test("records enclosing, Photos, and ordered per-Contacts capture intervals", async () => {
    const value = fixture();
    let tick = 0;
    const progress: unknown[] = [];
    const result = await exportApplePhotosContactEvidence({
      library: value.library,
      dependencies: {
        ...dependencies(value),
        now: () => new Date(FIXED_TIME.getTime() + tick++ * 1_000),
      },
      progress: (event) => progress.push(event),
    });
    expect(result.receipt.startedAt).toBe("2026-08-28T12:34:56.000Z");
    expect(result.output.source.capture).toEqual({
      startedAt: "2026-08-28T12:34:56.000Z",
      finishedAt: "2026-08-28T12:35:04.000Z",
      photos: {
        startedAt: "2026-08-28T12:34:57.000Z",
        finishedAt: "2026-08-28T12:34:58.000Z",
      },
      contacts: [
        {
          ordinal: 0,
          startedAt: "2026-08-28T12:34:59.000Z",
          finishedAt: "2026-08-28T12:35:00.000Z",
        },
        {
          ordinal: 1,
          startedAt: "2026-08-28T12:35:01.000Z",
          finishedAt: "2026-08-28T12:35:02.000Z",
        },
      ],
      consistency: "independent-read-transactions",
      crossDatabaseAtomicity: "not-asserted",
    });
    expect(result.output.observedAt).toBe("2026-08-28T12:35:03.000Z");
    expect(result.receipt.finishedAt).toBe("2026-08-28T12:35:05.000Z");
    expect(progress).toEqual([
      { phase: "source-admission" },
      { phase: "contacts-discovery" },
      { phase: "photos-capture" },
      { phase: "contacts-capture", current: 1, total: 2 },
      { phase: "contacts-capture", current: 2, total: 2 },
      { phase: "evidence-validation" },
      { phase: "generation-hashing" },
      { phase: "cleanup" },
    ]);
    close(value);
  });

  test("keeps advisory progress failures outside capture and cleanup custody", async () => {
    const value = fixture();
    const result = await exportApplePhotosContactEvidence({
      library: value.library,
      dependencies: dependencies(value),
      progress: () => {
        throw new Error("observer failed");
      },
    });
    expect(result.output.counts.matchedPeople).toBe(1);
    expect(readdirSync(value.temporary)).toEqual([]);
    close(value);
  });

  test("allows content churn while binding stable source-file identity", async () => {
    const changing = fixture();
    let mutations = 0;
    const captured = await exportApplePhotosContactEvidence({
      library: changing.library,
      dependencies: {
        ...dependencies(changing),
        afterDatabaseCaptured: (role) => {
          if (role === "photos") {
            mutations += 1;
            changing.photos.query(
              "INSERT INTO ZASSET (Z_PK, ZDATECREATED) VALUES (?1, ?2)",
            ).run(1000, 1);
          }
        },
      },
    });
    expect(mutations).toBe(1);
    expect(captured.output.evidence).toHaveLength(1);
    close(changing);

    const identityDrift = fixture();
    const originalMode = Number(lstatSync(identityDrift.photosPath, {
      bigint: true,
    }).mode & 0o777n);
    await expect(exportApplePhotosContactEvidence({
      library: identityDrift.library,
      dependencies: {
        ...dependencies(identityDrift),
        afterDatabaseCaptured: (role) => {
          if (role === "photos") {
            chmodSync(identityDrift.photosPath, originalMode ^ 0o100);
          }
        },
      },
    })).rejects.toThrow("changed filesystem identity during capture");
    chmodSync(identityDrift.photosPath, originalMode);
    close(identityDrift);
  });

  test("binds a path-free physical library realm independent of contents", async () => {
    const firstFixture = fixture();
    const first = await exportApplePhotosContactEvidence({
      library: firstFixture.library,
      dependencies: dependencies(firstFixture),
    });
    firstFixture.photos.query(
      "INSERT INTO ZASSET (Z_PK, ZDATECREATED) VALUES (?1, ?2)",
    ).run(999, 1);
    const changedContents = await exportApplePhotosContactEvidence({
      library: firstFixture.library,
      dependencies: dependencies(firstFixture),
    });
    expect(changedContents.output.source.libraryRealmSha256).toBe(
      first.output.source.libraryRealmSha256,
    );
    expect(JSON.stringify(first)).not.toContain(firstFixture.library);
    close(firstFixture);

    const secondFixture = fixture();
    const second = await exportApplePhotosContactEvidence({
      library: secondFixture.library,
      dependencies: dependencies(secondFixture),
    });
    expect(second.output.source.libraryRealmSha256).not.toBe(
      first.output.source.libraryRealmSha256,
    );
    close(secondFixture);
  });

  test("rejects relevant Core Data schema drift", async () => {
    const value = fixture({ schemaDrift: true });
    await expect(exportApplePhotosContactEvidence({
      library: value.library,
      dependencies: dependencies(value),
    })).rejects.toThrow("lost column ZPERSONURI");
    close(value);
  });

  test("rejects symlinked libraries and hardlinked databases", async () => {
    const symlinked = fixture();
    const symlinkPath = join(symlinked.home, "Pictures", "Linked.photoslibrary");
    symlinkSync(symlinked.library, symlinkPath);
    await expect(exportApplePhotosContactEvidence({
      library: symlinkPath,
      dependencies: dependencies(symlinked),
    })).rejects.toThrow("without symlink components");
    close(symlinked);

    const hardlinked = fixture();
    linkSync(hardlinked.photosPath, join(hardlinked.root, "second-photos.sqlite"));
    await expect(exportApplePhotosContactEvidence({
      library: hardlinked.library,
      dependencies: dependencies(hardlinked),
    })).rejects.toThrow("hardlink");
    close(hardlinked);
  });

  test("uses the default Photos library and rejects arbitrary database paths", async () => {
    const value = fixture();
    const result = await exportApplePhotosContactEvidence({
      dependencies: dependencies(value),
    });
    expect(result.output.counts.matchedPeople).toBe(1);
    await expect(exportApplePhotosContactEvidence({
      library: value.photosPath,
      dependencies: dependencies(value),
    })).rejects.toThrow(".photoslibrary suffix");
    close(value);
  });

  test("canonicalizes the OS-owned default temporary root", async () => {
    const value = fixture();
    const { temporaryDirectory: _explicitTemporary, ...defaultTemporary } =
      dependencies(value);
    const result = await exportApplePhotosContactEvidence({
      library: value.library,
      dependencies: defaultTemporary,
    });
    expect(result.output.counts.matchedPeople).toBe(1);
    close(value);
  });

  test("rejects a group-writable snapshot parent before creating a snapshot", async () => {
    const value = fixture();
    chmodSync(value.temporary, 0o730);
    await expect(exportApplePhotosContactEvidence({
      library: value.library,
      dependencies: dependencies(value),
    })).rejects.toThrow("temporary directory must be private mode 0700");
    expect(readdirSync(value.temporary)).toEqual([]);
    chmodSync(value.temporary, 0o700);
    close(value);
  });

  test("does not query or remove a replacement snapshot root", async () => {
    const value = fixture();
    let replacementRoot = "";
    let displacedRoot = "";
    const sentinel = "replacement-owned-by-another-operation";
    await expect(exportApplePhotosContactEvidence({
      library: value.library,
      dependencies: {
        ...dependencies(value),
        afterDatabaseCaptured: (role, attempt) => {
          if (role !== "photos" || attempt !== 1) return;
          const snapshotName = readdirSync(value.temporary).find((name) =>
            name.startsWith("wrench-apple-photos-"));
          if (snapshotName === undefined) throw new Error("snapshot root was not created");
          replacementRoot = join(value.temporary, snapshotName);
          displacedRoot = `${replacementRoot}-displaced`;
          renameSync(replacementRoot, displacedRoot);
          mkdirSync(replacementRoot, { mode: 0o700 });
          writeFileSync(join(replacementRoot, "sentinel"), sentinel, { mode: 0o600 });
        },
      },
    })).rejects.toThrow("private snapshot root changed before exact cleanup");
    expect(replacementRoot).not.toBe("");
    expect(displacedRoot).not.toBe("");
    expect(realpathSync(replacementRoot)).toBe(replacementRoot);
    await expect(Bun.file(join(replacementRoot, "sentinel")).text()).resolves.toBe(sentinel);
    expect(existsSync(displacedRoot)).toBeTrue();
    close(value);
  });
});
