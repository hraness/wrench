# Apple Photos contact evidence

Use this workflow when a local application needs exact evidence that one
Apple Photos person cluster is linked to one Apple Contacts record. It is a
local-source export, not a provider capability, Photos API, contact search, or
media reader.

## Run the bounded export

The default source is the current macOS account's Photos system library:

```sh
umask 077
wrench apple-photos export-contact-evidence --json \
  > /absolute/private/apple-photos-contact-evidence.json
```

Select a different library only by its normalized absolute
`.photoslibrary` directory:

```sh
wrench apple-photos export-contact-evidence \
  --library /absolute/private/Family.photoslibrary --json
```

There is no database-file, Contacts-root, SQL, query, output-path, network, or
media option. The command discovers the current Apple Contacts stores from the
fixed account root. It does not authenticate, connect, sync, download, modify,
or ask Photos to materialize an asset.

## Exact evidence boundary

Wrench accepts only owned real directories and owned single-link regular
SQLite files within reviewed byte and count bounds. It copies the Photos main
database and a complete WAL/SHM pair, when present, into a mode-`0700`
operation-owned temporary directory. Open-file and path identities must equal
the pre-copy identities after every byte has been copied. A mismatch discards
the attempt; three mismatches fail the run. Apple Contacts databases use the
same boundary. Queries open only the copies in read-only, query-only mode.

Relevant Core Data tables and columns have a strict schema fingerprint. Schema
drift, SQLite integrity failure, missing or one-sided WAL state, a symlink,
hardlink, owner mismatch, or size overrun fails closed. Temporary copies are
removed before success or failure returns.

The exact relationship is:

```text
ZPERSON.ZPERSONURI = ZABCDRECORD.ZUNIQUEID
```

Wrench does not parse `ZCONTACTMATCHINGDICTIONARY` or infer a match from a
name. Unmatched Photos people are excluded.

## Output and completeness

Stdout contains one strict `{ "receipt": ..., "output": ... }` JSON value.
The schema-1 output format is `wrench.apple-photos-contact-evidence`. Each
sorted evidence row contains:

- `photosPersonId`;
- `appleContactId`;
- `linkedFaceCount`;
- `linkedAssetCount`;
- `firstAssetAt` and `lastAssetAt`, or two null values when no linked asset has
  a date.

The output and receipt declare the source generation, relevant Photos and
Contacts schema digests, local-snapshot completeness, bounds, counts, privacy
exclusions, and canonical SHA-256 integrity. The export is complete for exact
matches in the copied local snapshots only. It does not claim that iCloud
Photos or Contacts finished remote synchronization. Absence is not deletion
evidence.

Names, paths, images, encoded media, thumbnails, locations, raw blobs,
faceprints, face crops, credentials, and unmatched clusters are never selected
or projected. The two returned identifiers are still private relationship
data. Keep the artifact outside Git and shared output paths.

## Typed client

Local Bun applications can invoke the installed Wrench boundary without
duplicating SQLite custody:

```ts
import {
  exportApplePhotosContactEvidenceSync,
  parseApplePhotosContactEvidenceExportResult,
} from "@hraness/wrench/apple-photos"

const result = exportApplePhotosContactEvidenceSync()
const checked = parseApplePhotosContactEvidenceExportResult(result)
```

Consumers should map these exact source coordinates into their own person
model and retain the receipt. They must not read Photos or Contacts databases
again, treat face counts as biometric output, infer names, or advance a deletion
state from an absent relationship.
