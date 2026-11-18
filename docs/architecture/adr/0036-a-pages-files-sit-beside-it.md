# 0036 — A page's files sit beside it; video and audio go by a short-lived Storage link

**Status** Accepted · **Spec** §0, §2, §17, §19, §24 · **Builds on** [0035](0035-a-version-lists-its-files-each-stored-once.md) (each file stored once)

## Context

A document could already hold files beside its page, but almost nothing put them there. The publish skill and the agent guide told agents to keep to one file: inline the CSS and the SVG, and put pictures and fonts in `data:` URIs. The MCP tools took text only, so an agent had no other way. The CLI took one file or a zip, and a folder failed with `EISDIR`. The browser took one file or a zip. So a document with a picture usually carried it as base64 inside its HTML, a revision resent the whole page with every picture in it, and what an agent read back was mostly encoded image.

Video was worse. `/content` streamed every file whole and answered no `Range` request, so a browser could not seek, and Safari will not play a video served that way at all. Hosting also cuts any function response at 60 s, which a film on a slow connection outlasts.

ADR 0035 made a file beside the page cheap: it is stored once, and a version that changes one file writes one object. This ADR decides how files get there and how they reach a reader.

## Decision

1. **The upload unit is a folder or a zip.** A single page is the one-file case and works as before. No container of our own:

   | Option | Why not |
   |---|---|
   | A custom `.bsh` | Nothing writes or opens it. Every agent, script and operating system would need a writer, and SPEC a format to version. What it could carry (a title, a folder, an entry) already has a place in query parameters, MCP fields and CLI flags |
   | MHTML or `.webarchive` | Browser page captures: base64 or a property list inside, a third larger for media, and useful only behind a converter |
   | Web Bundles | Abandoned by Chrome |
   | **Zip** | Finder, Explorer, every standard library and every agent sandbox write one already, and Bikeshed's own Download makes one, so download, edit and upload round-trips |

   The browser and the CLI send a folder as one stored zip, so the deployment reads it exactly as it reads an uploaded zip.
2. **What a folder or a zip leaves out:** any file or folder whose name starts with a dot (`.env`, `.git/`, `.DS_Store`), `__MACOSX/`, `node_modules/` and `Thumbs.db`. A zip is now held to the same rule as a folder, so the two publish the same thing, and a credential in a dotfile never becomes a document's file. The browser and the CLI say what they left out. A symbolic link is never followed. A path is at most 256 bytes, so 2,000 of them fit one version record.
3. **An agent sends files beside the page.** `publish_document` and `update_document` take `files`, each `{path, content, encoding?}`: text types as text, binary types as base64 without a `data:` prefix, up to 10 MB in all. `update_document` needs only its `id`, so a revision sends the page, the files that changed, or both, and every other file is kept. Changing what a document is made of is its editors' own, as a bundle upload is; open editing still changes its text.
4. **Loose files replace their namesakes.** `POST /publish?update=<id>&merge=1` lays a zip of files over the current version. A bare name replaces the one file of that name, wherever it is. A path with a folder in it is taken exactly. A name nothing has is added at the top, except that one page alone replaces the page, as uploading a page always has. A name two files share is refused with both paths rather than guessed. The browser shows each file's fate before anything is sent, by the same rule, and the answer says where each one went.
5. **Video and audio go to the reader by a short-lived link.** Once `contentProxy` or `getDraft` has decided the caller may read, a file served as `video/*` or `audio/*` answers `302` to a V4 signed read link for that one object, rather than its bytes. The link lives ten minutes, names the type the file is served as and asks to be shown inline. It is never logged. The redirect is `private, no-store`, set last, because a cached redirect would outlive its link. Storage answers ranges for as long as a reader takes. Signing goes through IAM signBlob as the runtime's own identity, which already holds the token-creator role on itself for session cookies, so nothing new is granted. The emulator has no signer, so there the proxy streams as before.
6. **A member's browser keeps pictures, stylesheets and fonts for up to an hour,** `private, max-age` capped at the document's expiry and a folder reach's end, never `immutable`, because a version's name is minted again after a withdrawal. Scripts, SVG, pages and the run variant stay `private, no-store`, because trust is given for one version's bytes. A read the URL alone decides keeps `public, max-age=300`.
7. **A HEAD asks whether the file exists,** costing no Storage call when the version's list already knows its size, and every refusal is `private, no-store`. A missing file at a public address used to be a 404 cached for five minutes.
8. **Both frames allow fullscreen**, the viewer's and the embed page's, so a video's own fullscreen button works.

## Consequences

- An agent puts a stylesheet, a script or an SVG in `files` for the tokens it would have spent inlining them, and a revision sends only what changed. What it reads back is the page.
- A person drops a folder, or a new screenshot on an open document, and sees what will change before it is published. Only that screenshot is sent and stored.
- A reader whose access is withdrawn can finish fetching a media link they already hold, for at most ten minutes. Nothing longer-lived is handed out.
- A trusted document's script that `fetch()`es its own video gets a redirect to another origin, which fails without CORS on the bucket. This is documented, not built for: a `<video>` element needs no CORS.
- Video and audio no longer cost the proxy their bytes or their time, and are no longer cut at 60 s.
- The emulator cannot prove signing, the redirect in a real browser or Storage's range answers; unit tests drive the redirect with a stand-in signer, and the real deployment is where it is proven.
- A zip that held dotfiles now publishes without them, so republishing one such zip mints a new version once.

## What would change this

- Readers or operators needing a media link withdrawn at once on revocation. Then media go back through the proxy, which must answer ranges itself and is cut at 60 s.
- Trusted documents that script their own media in numbers. Then the bucket gets CORS for the deployment's own origin, proven on a real deployment first.
- A file a page needs that the left-out rule refuses, such as `.well-known/`. Then the rule names what it leaves out exactly instead of every dotfile.
- Agents whose clients can attach files to a tool call. Then `files` could take a reference to an upload instead of base64.
