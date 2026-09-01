# Apple Photos contact evidence

Use this workflow when a local application needs exact evidence that one
Apple Photos person cluster is linked to one Apple Contacts record. It is a
local-source export, not a provider capability, Photos API, contact search, or
media reader.

## Run the bounded export

The default source is the conventional current-account Photos library path,
`~/Pictures/Photos Library.photoslibrary`. It does not discover or claim the
library that Photos currently designates as the System Photo Library:

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
SQLite files within reviewed byte and count bounds. It opens each source
read-only with trusted schemas disabled and uses SQLite `VACUUM INTO` to create
one mode-`0600` database in a mode-`0700` operation-owned temporary directory.
The source's device, inode, birth time, owner, type, link count, and permission
mode must agree before and after capture. Live size and modification-time churn
is allowed. Apple Contacts databases use the same boundary. Wrench runs
`quick_check`, then opens only the captured databases read-only and query-only.

Relevant Core Data tables and columns have a strict schema fingerprint. Schema
drift, SQLite integrity failure, a symlink, hardlink, owner or physical-identity
mismatch, or size overrun fails closed. Ordinary success and handled failure
remove the temporary captures before returning. Forced termination or a crash
can leave an exact leased capture for a later recovery pass.

The CLI serializes private local exports before inspecting a source. Its
operation-owned snapshot directory has a process-owned,
filesystem-identity-bound recovery lease before database bytes are copied. A
later export reclaims only an exact directory whose owner is dead; live or
uninspectable owners remain untouched and stop the run.

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
- `linkedAssetCount`, the number of distinct `ZASSET` rows linked through the
  detected faces;
- `firstAssetAt` and `lastAssetAt`, or two null values when no linked asset has
  a date.

The output and receipt declare a path-free realm digest for the physical Photos
library, the source generation, relevant Photos and Contacts schema digests,
bounds, counts, privacy exclusions, component capture intervals, and canonical
SHA-256 integrity. Each captured database is internally consistent within its
interval. The export does not claim an atomic instant across Photos and
Contacts or completed iCloud and Contacts synchronization. Absence is not
deletion evidence.

Wrench does not open or ask Photos to materialize referenced photo or video
asset files. A `VACUUM INTO` capture is nevertheless a full private SQLite
database copy and can contain source fields outside the reviewed query. Names,
paths, images, encoded media, thumbnails, locations, raw blobs, credentials,
faceprint templates, face crops, and unmatched clusters are not selected or
projected into the returned JSON. The returned cluster identifiers and counts
are private biometric-derived metadata as well as relationship evidence. Keep
the artifact outside Git and shared output paths.

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
again, infer names, expose biometric-derived counts, or advance a deletion
state from an absent relationship.
