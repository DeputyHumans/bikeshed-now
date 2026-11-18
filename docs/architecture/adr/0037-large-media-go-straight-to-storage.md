# 0037 — Large media go straight to Storage through a server-issued session

**Status** Accepted · **Spec** §2, §4, §8, §9, §19, §24 · **Builds on** [0035](0035-a-version-lists-its-files-each-stored-once.md) (each file stored once), [0036](0036-a-pages-files-sit-beside-it.md) (a page's files beside it)

## Context

ADR 0036 let a document carry its pictures, films and recordings as files beside its page, but every byte still came through a function, and a function cannot take them. A request body is capped at 25 MB here, Cloud Run refuses one over 32 MiB, and Hosting cuts a function's response at 60 s. A screen recording or a short film is 200 MB. A download was built in memory and refused over 25 MB, which held only while no version could be larger.

Nothing here limits rates, by decision (overview, "What this is not"), so whatever takes large files has to bound the harm one account can do without one.

## Decision

1. **`POST /media` opens a session to Storage.** It is an exact rewrite to `createDoc`, so there is no new function, invoker grant or cold start. It takes `{docId?, k?, path, size, sha256?}`, answers `private, no-store`, and checks before opening anything: a signed-in caller; a usable path of at most 256 bytes that the left-out rule keeps; a picture, film or recording by extension, never SVG; a size from 1 byte to 200 MB. With `docId`, the document must exist and be readable (else `404`), the caller must be one of its editors (`isDocEditor`, else `403`) and it must not be frozen (`409`).
2. **The session is the caller's own, create-only, of a declared length.** `createResumableUpload` on `staging/{uid}/{uuid}`, with the type and `contentLength` declared and `ifGenerationMatch: 0`, so Storage refuses a byte more and a second object at that name. Its metadata names the document, the path and the size. For a browser's session cookie, the origin given to Storage is the deployment address the person is on, so Storage answers that origin's CORS check: the forwarded host when it is one of the deployment's own, the configured origin otherwise. A token's session has none. Nothing the caller sends can name a host outside the deployment. The answer is `{stagingId, uploadUrl, expiresAt, chunkBytes}`. The upload URL is a bearer secret and is never logged.
3. **What a document already stores is never sent again.** With `docId` and the file's `sha256`, `/media` answers `{have: true}` when `docs/{docId}/blobs/{sha256}` exists. Saying so tells an editor of that document nothing they could not read in its versions.
4. **The publish names what it uses, and nothing named is trusted.** `POST /publish` takes `media=<stagingId>` (at most 20) and `have=<path>:<sha256>`. A staging id is looked up only under the caller's own uid. Its metadata must name this document (none, for a new one), a stageable path and the size that arrived; it must be under a day old; its generation is pinned and it is read once at that generation to hash it. Anything else is `409 {error, staging}`. Then it is copied, server-side and create-only, into the document's stored files (ADR 0035). A `have` must name a stored file of this document.
5. **One version, one publish.** A new document's films go beside its page in its first version. `merge=1` lays a film over a version by name with no body at all. A version may hold 500 MB and 2,000 files, and nothing over 25 MB but a picture, a film or a recording.
6. **Nothing staged is deleted on success.** A publish whose acknowledgement is lost retries into `deduped` with the same staged objects. The bucket deletes `staging/` and `downloads/` a day after each object is made, by a lifecycle rule `scripts/setup.mjs` adds while keeping the bucket's other rules. That is the cleanup, not a scheduled job.
7. **Minting may outlast Hosting.** `createDoc` and `downloadBundle` run with a 300 s timeout (`MINTING`). The caller is still cut off at 60 s; the function finishes, and a retry finds what it made.
8. **A large version downloads by a link.** Over 25 MB, the version is written once as a stored zip to `downloads/{docId}/{contentHash}.zip`, named by its bytes because a withdrawn version's name is minted again, and the reader gets a `302` to a ten-minute signed link with `attachment` disposition, as a video does (ADR 0036). Each file is read twice, once for its CRC and once to copy it, so nothing is held but one chunk. 500 MB and 2,000 entries fit a zip without ZIP64, and a field that would overflow throws. At 25 MB or under the zip is built in memory as before.

## Consequences

- The browser and the CLI send a folder of any size up to 500 MB, the largest media through sessions until the rest fits one request, which then names them.
- The CLI resumes a broken upload from what Storage says it holds, and on an update sends nothing for a film the document already stores. The browser sends each film in one request and does not resume; it also sends again an unchanged film in a re-uploaded folder, though it is stored once.
- The abuse bound, without a rate limiter: one session holds at most 200 MB, for at most a day, and writes nothing to Firestore. Everything one account staged sits under `staging/{uid}/`. App Check is still the named hook if abuse appears.
- A publish that takes more than 60 s answers the caller `504` while the version lands. The browser says it may still publish; a retry is `deduped`.
- Storage holds one copy of each distinct file per document (ADR 0035), plus staged objects and built zips for a day.
- An existing deployment has no lifecycle rule until `scripts/setup.mjs` runs again; until then staged objects and built zips stay until the document is deleted forever.
- The emulator is not evidence for the parts that make this work: a session's declared length, its CORS, the lifecycle rule, signing and Hosting's 60 s cut. Unit tests stand in for each, and the real deployment is where they are proven.

## What would change this

- A 500 MB publish taking over 20 s on production. The content hash is already taken over the file list (SPEC §9.1 v2), so the time is the read that hashes a staged film; measure it before changing anything.
- Abuse of sessions: storage filled from one account, or many accounts. Then App Check, or a rate limiter argued for in its own ADR.
- People re-uploading large folders from the browser often. Then the browser hashes files and asks for `have` as the CLI does.
- A browser's `PUT` refused for CORS on the real deployment. Then the content bucket gets CORS for the deployment's own origin, in `scripts/lib/content-bucket.mjs`.
