// SPDX-License-Identifier: Apache-2.0
// The document tools: listing, reading, publishing, forking and revising (SPEC §19, §21).

import { versionObjectKey, versionStorageIdentity } from "../../lib/storage";
import * as admin from "firebase-admin";
import { FieldPath } from "firebase-admin/firestore";
import { mutationVersion, originOf, selectedVersion } from "../../lib/versions";
import { bucketName, publicOrigin } from "../../config";
import { actedThrough, isAutomated, type Actor } from "../../lib/actor";
import {
  canEdit,
  canSuggest,
  isDocEditor,
  expiryMs,
  isFrozen,
  isTrashed,
  isMember,
  visibilityOf,
  type DocAclData,
} from "../../lib/acl";
import { filedIn } from "../../lib/audience";
import { extractBundle, type BundleEntry, type ExtractedBundle } from "../../lib/bundle";
import { decodeAgentFiles } from "../../lib/files";
import { BAD_DOC_ID, isValidDocId, resolveFolderTarget, slugify } from "../../lib/folders";
import { forkDocument, lineageFor } from "../../lib/fork";
import { compileBundle, pagePath, publishNewDocument, reviseDocument } from "../../lib/publish";
import {
  composeReading,
  contentAddress,
  readerAddress,
  readingPreamble,
} from "../../lib/markdown/reading";
import { opensWithOwnFrontMatter } from "../../lib/markdown/source";
import { storedReading } from "../../lib/markdown/stored";
import { commitDraft } from "../../lib/draft";
import { editorsRefusal } from "../../lib/presence";
import { MAX_BUNDLE_BYTES } from "../../config";
import { safeRelPath, safeSegment } from "../../lib/http";
import {
  LIST_LIMIT,
  SOURCE_LIMIT,
  LOOKS_LIKE_HTML,
  pageEnd,
  offsetOf,
  str,
  whereAndWho,
  startingCursor,
  LINK_KEY_DESCRIPTION,
  READ_KEY_DESCRIPTION,
  loadDoc,
  loadDocForRead,
  refuseIfFrozen,
  recordApiRead,
  withReaderAddress,
  lineageForAgent,
} from "./shared";
import type { ToolDefinition } from "./shared";

const FILES_SCHEMA = {
  type: "array",
  description:
    "Files beside the page, at the relative paths it references them by: a stylesheet, a script, an SVG, a small picture. " +
    "Text files (css, js, mjs, json, svg, vtt, txt, csv, md, html, xml) go as text, as you would write them inline. " +
    "Binary files (png, jpg, gif, webp, avif, ico, woff2, pdf, audio, video) go as base64, without a data: prefix. " +
    "Up to 10 MB in all; anything larger is a folder for bikeshed publish.",
  items: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Relative path, e.g. style.css or img/chart.png." },
      content: { type: "string" },
      encoding: { type: "string", enum: ["utf8", "base64"], description: "Default utf8." },
    },
  },
} as const;

export const DOCUMENT_TOOLS: ToolDefinition[] = [
  {
    name: "list_documents",
    description:
      "List documents you can read, newest first. Metadata only — use get_document for content.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: `Maximum rows (default 20, max ${LIST_LIMIT}).` },
        cursor: { type: "string", description: "The `nextCursor` from a previous call." },
      },
    },
    async run(ctx, args) {
      const limit = Math.min(Number(args.limit) || 20, LIST_LIMIT);
      let q = ctx.db
        .collection("docs")
        .where("members", "array-contains", ctx.caller.emailLower)
        .orderBy("createdAt", "desc")
        .limit(limit + 1);
      const cursor = str(args, "cursor");
      if (cursor) {
        const after = await ctx.db.collection("docs").doc(cursor).get();
        if (after.exists) q = q.startAfter(after);
      }
      const snap = await q.get();
      // The Trash is list_trash's (SPEC §4): a trashed document is its owner's
      // and frozen, not something to work on. A page may come back short; its
      // cursor is still the last row read, so nothing is skipped or repeated.
      const page = snap.docs.slice(0, limit).filter((d) => !isTrashed(d.data()));

      /**
       * `format` lives on the VERSION, not on the document — a document's
       * format is whatever its current version is. Reading it off the document
       * record returned "html" for every row, including Markdown documents,
       * which is one of only seven fields this tool returns and the one an
       * agent uses to decide what it is about to receive.
       *
       * Fetched with a single getAll rather than N sequential gets, and
       * deliberately NOT denormalized onto the document: that would add a field
       * three separate paths have to keep in step, including version
       * withdrawal, to save one batched round trip.
       */
      const versionRefs = page
        .map((d) => {
          const current = d.data().currentVersion;
          return typeof current === "string" && current
            ? d.ref.collection("versions").doc(current)
            : null;
        })
        .filter((r): r is admin.firestore.DocumentReference => r !== null);
      const versions = versionRefs.length > 0 ? await ctx.db.getAll(...versionRefs) : [];
      const formatOf = new Map(
        versions.map((v) => [v.ref.parent.parent!.id, v.data()?.format === "markdown" ? "markdown" : "html"]),
      );
      const paths = await filedIn(ctx.db, ctx.caller, page.map((d) => d.data().folderId));

      const rows = page.map((d) => {
        const v = d.data();
        return {
          id: d.id,
          title: v.title,
          version: v.currentVersion,
          format: formatOf.get(d.id) ?? "html",
          visibility: visibilityOf(v as DocAclData),
          // Reported, never settable here: narrowing a document's reach is
          // still a decision about who may read it, and this surface does not
          // make those (SPEC §19).
          expiresAt: expiryMs(v as DocAclData),
          owner: v.ownerEmail,
          // Off the record, so free: whether it is a fork, and how many forks it
          // has. Where they came from is get_lineage's, per caller (SPEC §21).
          forked: v.forked === true,
          forks: typeof v.stats?.forks === "number" ? v.stats.forks : 0,
          // Where it lives, which is also who else can read it; null at the root.
          filedIn: (typeof v.folderId === "string" && paths.get(v.folderId)) || null,
          updatedAt: (v.updatedAt as admin.firestore.Timestamp)?.toDate?.().toISOString(),
        };
      });
      return {
        documents: rows,
        nextCursor: snap.docs.length > limit ? snap.docs[limit - 1].id : null,
      };
    },
  },

  {
    name: "list_versions",
    description: "List a document's published versions, newest first. Historical content and feedback remain readable but cannot be changed. Use get_document or get_comments with a returned version.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        k: { type: "string", description: READ_KEY_DESCRIPTION },
        limit: { type: "integer", description: "Maximum rows (default 20, max 50)." },
        cursor: { type: "string", description: "The nextCursor from the preceding page." },
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDocForRead(ctx, str(args, "id"), str(args, "k"));
      const limit = args.limit === undefined ? 20 : args.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT) {
        throw new Error("limit must be an integer from 1 to 50");
      }
      let q = ref.collection("versions").orderBy("publishedAt", "desc").orderBy(FieldPath.documentId(), "desc").limit(limit + 1);
      if (args.cursor !== undefined) {
        if (typeof args.cursor !== "string" || !safeSegment(args.cursor)) throw new Error("invalid version cursor");
        const cursor = await ref.collection("versions").doc(args.cursor).get();
        if (!cursor.exists || !cursor.data()?.publishedAt) throw new Error("version cursor no longer exists; list versions again");
        q = q.startAfter(cursor.data()!.publishedAt, cursor.id);
      }
      const snap = await q.get();
      // Who published, and through which credential, is a member's to know:
      // a link holder learns how each version arrived and whether a person
      // did it, never an address or a token's name (SPEC §17).
      const member = isMember(data as DocAclData, ctx.caller.uid, ctx.caller.emailLower);
      return {
        id: ref.id,
        currentVersion: data.currentVersion,
        versions: snap.docs.slice(0, limit).map((v) => {
          const row = v.data();
          const by = row.publishedBy as Actor | undefined;
          return withReaderAddress({
            version: v.id,
            label: row.label ?? v.id,
            publishedAt: row.publishedAt?.toDate?.().toISOString() ?? null,
            format: row.format === "markdown" ? "markdown" : "html",
            contentHash: row.contentHash ?? null,
            isCurrent: v.id === data.currentVersion,
            origin: originOf(row),
            automated: by ? isAutomated(by) : null,
            ...(member ? { publishedBy: row.publishedByEmail ?? null, ...(by?.channel ? actedThrough(by) : {}) } : {}),
          }, ref.id, v.id, str(args, "k") || undefined);
        }),
        nextCursor: snap.docs.length > limit ? snap.docs[limit - 1].id : null,
      };
    },
  },

  {
    name: "get_document",
    description:
      "Fetch a document's metadata and its content. An HTML document comes, by default, as a Markdown READING made for agents, under `markdown`: " +
      "it opens with front matter saying it is a reading, what it left out (styling, scripts, figures drawn in code) and where the original is. " +
      "Read it to understand or comment on the document; never send it back through update_document. " +
      'To revise an HTML document, read its source with as: "source", which returns the HTML exactly as published, under `source`. ' +
      "A Markdown-authored document always returns its Markdown source under `source`. " +
      `Content comes in pages of ${SOURCE_LIMIT.toLocaleString("en-US")} characters: \`truncated\` says there is more, ` +
      "and you read the rest by calling again with `offset` set to `nextOffset` and the same `version`. " +
      "Never send a cut source back through update_document: the new version would lose everything after the cut. " +
      "`bikeshed get` prints the whole thing.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The document id, as returned by list_documents." },
        version: {
          type: "string",
          description: "A specific version, e.g. v3. Defaults to current. Required with offset, so every page comes from one version.",
        },
        as: {
          type: "string",
          enum: ["markdown", "source"],
          description:
            'For an HTML document: "markdown" (the default) for a reading made for agents, "source" for the HTML as published, which is what you revise. A Markdown document returns its source either way.',
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Where to start reading, in characters: the nextOffset a previous call returned. Defaults to 0.",
        },
        k: {
          type: "string",
          description: READ_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const asked = str(args, "as");
      if (asked && asked !== "markdown" && asked !== "source") {
        throw new Error('as must be "markdown" or "source"');
      }
      const offset = offsetOf(args);
      if (offset > 0 && args.version === undefined) {
        throw new Error(
          "pass the version you read first, e.g. v3, together with offset: every page has to come from the same version",
        );
      }
      const { ref, data, proof, viaFolder, basis } = await loadDocForRead(ctx, str(args, "id"), str(args, "k"));
      const versionId = selectedVersion(args.version, data.currentVersion);
      const isCurrent = versionId === data.currentVersion;
      // Read through a folder's key: the reader may do nothing but read.
      const writable = isCurrent && !viaFolder && !isFrozen(data, Date.now());
      const vSnap = await ref.collection("versions").doc(versionId).get();
      if (!vSnap.exists) throw new Error(`no version "${versionId}"`);
      const v = vSnap.data() || {};
      const format = v.format === "markdown" ? "markdown" : "html";
      // A Markdown document's source is already what an agent should read.
      const as = format === "html" && asked !== "source" ? "markdown" : "source";

      const sourceRel =
        typeof v.sourceEntry === "string" ? v.sourceEntry : String(v.entry ?? "index.html");
      if (!safeRelPath(sourceRel)) throw new Error("invalid source path");
      const storagePrefix = versionStorageIdentity(ref.id, versionId, v);
      const sourceKey = versionObjectKey(ref.id, versionId, v, sourceRel);
      const bucket = admin.storage().bucket(bucketName());
      const loadSource = async () => {
        try {
          if (!sourceKey) throw new Error("not listed");
          const [bytes] = await bucket.file(sourceKey).download();
          return bytes.toString("utf8");
        } catch {
          throw new Error(`could not read source for version "${versionId}"`);
        }
      };

      // The version's own addresses carry the key only when a key is what
      // opened the document: a member's reading must not hand one out.
      const keyed = basis === "link" || basis === "folder-link" ? str(args, "k") || null : null;
      let body: string;
      let original: Record<string, unknown> | null = null;
      if (as === "markdown") {
        const origin = publicOrigin();
        const place = { origin, docId: ref.id, versionId, entry: sourceRel, k: keyed };
        // Made once for this version's bytes and kept, so a later page is a
        // read and a slice, not the whole page converted again (ADR 0033).
        const reading = await storedReading({ store: bucket, place, version: v, storagePrefix, source: loadSource });
        const files = Array.isArray(v.files) ? v.files.length : 1;
        const url = contentAddress(place, sourceRel);
        body = composeReading(
          readingPreamble({
            title: String(data.title ?? ref.id),
            document: readerAddress(origin, ref.id, args.version === undefined ? null : versionId, keyed),
            version: versionId,
            original: url,
            leftOut: reading.leftOut,
            warnings: reading.warnings,
          }),
          reading,
        );
        original = {
          as: "source",
          url,
          files,
          ...(files > 1
            ? { download: `${origin}/download/${ref.id}/${versionId}${keyed ? `?k=${encodeURIComponent(keyed)}` : ""}` }
            : {}),
        };
      } else {
        body = await loadSource();
      }
      const total = body.length;
      if (offset > 0 && offset >= total) {
        throw new Error(`offset ${offset} is past the end: this ${as === "markdown" ? "reading" : "source"} is ${total} characters`);
      }
      const end = pageEnd(body, offset);
      const truncated = end < total;

      // A walk through the pages is one read, not one per page.
      if (offset === 0) await recordApiRead(ctx, ref, versionId);
      const folderId = typeof data.folderId === "string" ? data.folderId : null;
      const paths = await filedIn(ctx.db, ctx.caller, [folderId]);

      return {
        id: ref.id,
        // The address, ahead of the source for the same reason `truncated` is.
        ...withReaderAddress({}, ref.id, args.version === undefined ? undefined : versionId, str(args, "k") || undefined),
        title: data.title,
        version: versionId,
        currentVersion: data.currentVersion,
        isCurrent,
        format: v.format ?? "html",
        sourceFile: sourceRel,
        visibility: visibilityOf(data),
        expiresAt: expiryMs(data),
        canComment: writable,
        canEdit: writable && canEdit(data, ctx.caller, proof),
        canSuggest: writable && canSuggest(data, ctx.caller, proof),
        ...(viaFolder ? { viaFolder: true } : {}),
        forked: data.forked === true,
        filedIn: (folderId && paths.get(folderId)) || null,
        // Where get_changes starts, for watching a document you did not
        // publish. Saved as "last" only if this credential has none for it.
        // Not for a folder's reader: get_changes reads threads, which are not theirs.
        cursor: viaFolder ? null : await startingCursor(ctx, ref, "ifNone"),
        // Ahead of the content, not after it: an agent reads this result as
        // JSON text in key order, and a flag after 200,000 characters of
        // content is a flag it may never reach.
        as,
        ...(original ? { original } : {}),
        truncated,
        total,
        ...(truncated ? { nextOffset: end } : {}),
        // A reading and a source never share a key, so neither can be
        // mistaken for the other on the way back to update_document.
        [as === "markdown" ? "markdown" : "source"]: body.slice(offset, end),
      };
    },
  },

  {
    name: "publish_document",
    description:
      "Create a new document from content you supply. Markdown is rendered server-side; HTML is stored as authored. " +
      "Put stylesheets, scripts and pictures in `files` beside the page and reference them by relative path, rather than inlining them. " +
      "The result says where it is filed and who can read it there (`filedIn`, `access`): tell the person both, with the `url`.",
    inputSchema: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "The document source: the page." },
        format: { type: "string", enum: ["markdown", "html"], description: "Default markdown." },
        files: FILES_SCHEMA,
        folder: { type: "string", description: "Destination folder id. Optional." },
        id: {
          type: "string",
          description:
            "The id to publish at, the part of the address after /d/. Optional; default is from the title. " +
            "If it is taken, a random suffix is added and `idTaken` says so, so use the docId this returns.",
        },
      },
    },
    async run(ctx, args) {
      const title = str(args, "title");
      const content = String(args.content ?? "");
      const wantedId = str(args, "id");
      if (!title) throw new Error("title is required");
      if (!content.trim()) throw new Error("content is empty");
      if (wantedId && !isValidDocId(wantedId)) throw new Error(BAD_DOC_ID);
      const format = args.format === "html" ? "html" : "markdown";
      const filename = format === "html" ? "index.html" : "index.md";

      const page = extractBundle(Buffer.from(content, "utf8"), filename, MAX_BUNDLE_BYTES);
      if ("error" in page) throw new Error(page.error);
      // The page and the files beside it make the bundle (SPEC §19).
      const sent = decodeAgentFiles(args.files, { entry: "index.html", format, ...(format === "markdown" ? { sourceEntry: "index.md" } : {}) });
      if ("error" in sent) throw new Error(sent.error);
      const extracted = { ...page, files: [...page.files, ...sent.files] };
      if (extracted.files.reduce((n, f) => n + f.data.length, 0) > MAX_BUNDLE_BYTES) throw new Error("bundle is too large");

      const target = await resolveFolderTarget(ctx.db, args.folder, ctx.caller);
      if (!target.ok) throw new Error(target.error);

      const compiled = compileBundle(extracted, title);
      // Provenance is the actor's, from the credential, not anything the
      // caller sent (SPEC §17).
      const published = await publishNewDocument({
        db: ctx.db,
        actor: ctx.actor,
        ownerEmail: ctx.caller.emailLower,
        ownerUid: ctx.caller.uid,
        compiled,
        title,
        folderId: target.id,
        parentMembership: target.membership,
        ...(wantedId ? { docId: wantedId } : {}),
      });
      const requestedId = wantedId || slugify(title);
      return withReaderAddress(
        {
          ...published,
          requestedId,
          idTaken: published.docId !== requestedId,
          ...(await whereAndWho(ctx, published.docId)),
          // Where get_changes starts: nothing that happens from now on is missed.
          cursor: await startingCursor(ctx, ctx.db.collection("docs").doc(published.docId), "always"),
        },
        published.docId,
      );
    },
  },

  {
    name: "fork_document",
    description:
      "Copy a document you can read into a new private one you own, and record which document it came from. " +
      "Its author sees that it was forked, not by whom. Comments, highlights and older versions are not copied.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The document to fork." },
        version: { type: "string", description: "A specific version, e.g. v3. Defaults to current." },
        folder: {
          type: "string",
          description: "Destination folder id, from list_folders. Optional; default is the workspace root.",
        },
        title: { type: "string", description: "Optional; default is the original's title." },
        k: {
          type: "string",
          description: READ_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const id = str(args, "id");
      const out = await forkDocument({
        db: ctx.db,
        bucket: admin.storage().bucket(bucketName()),
        caller: ctx.caller,
        actor: ctx.actor,
        sourceId: id,
        k: str(args, "k") || null,
        versionId: str(args, "version") || null,
        folderId: args.folder,
        title: str(args, "title") || undefined,
      });
      if (!out.ok) {
        // A refused read answers exactly as an id that does not exist (SPEC §17).
        throw new Error(out.unreadable ? `no document with id "${id}"` : out.error);
      }
      return withReaderAddress(
        {
          docId: out.docId,
          versionId: out.versionId,
          title: out.title,
          ...(await whereAndWho(ctx, out.docId)),
          cursor: await startingCursor(ctx, ctx.db.collection("docs").doc(out.docId), "always"),
        },
        out.docId,
      );
    },
  },

  {
    name: "get_lineage",
    description:
      "Where a document came from and, for its owner, its forks. Each original you can open is listed nearest first, " +
      "with `changedSince` on the nearest: whether it has changed since the fork was made. The list stops at the first " +
      "document you cannot open. Forks you cannot open are counted, never named.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The document id." },
        k: {
          type: "string",
          description: READ_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const id = str(args, "id");
      const out = await lineageFor({ db: ctx.db, caller: ctx.caller, docId: id, k: str(args, "k") || null });
      if (!out.ok) throw new Error(`no document with id "${id}"`);
      return lineageForAgent(id, out.lineage);
    },
  },

  {
    name: "update_document",
    description:
      "Publish a new version of an existing document. Identical content is a no-op, so this is safe to retry. " +
      "Send `content` to replace the page, `files` to replace or add files beside it at their paths, or both; every other file is kept, so send only what changed. " +
      "Pass the `baseVersion` you read and revised: if somebody has published since, the update is refused and names the current version, " +
      "instead of replacing their work. `threadsLeftBehind` counts the open threads that stay on the version this replaces. " +
      'An HTML document takes HTML: revise what get_document returns with as: "source", never its Markdown reading. ' +
      "Refused while somebody has the document open in the editor.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        content: { type: "string", description: "The page's new source. Optional when files are sent." },
        files: FILES_SCHEMA,
        baseVersion: {
          type: "string",
          description: "The version your content was revised from, e.g. v3, as get_document reported it. Recommended.",
        },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const { ref, data, proof } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
      if (!canEdit(data, ctx.caller, proof)) {
        throw new Error(
          canSuggest(data, ctx.caller, proof)
            ? "you cannot edit that document, but you can suggest an edit to it with suggest_edit; its owner or an approver accepts or rejects it"
            : "you cannot edit that document",
        );
      }
      refuseIfFrozen(data);
      const content = args.content === undefined ? null : String(args.content);
      const sendsFiles = Array.isArray(args.files) && args.files.length > 0;
      if (content === null && !sendsFiles) throw new Error("send content, files, or both");
      if (content !== null && !content.trim()) throw new Error("content is empty");
      // A picture, a film or a font read as text has NUL bytes, and no page
      // does. Up to 0.23.0, bikeshed sent any file but a .zip here as the
      // page, so `bikeshed update <id> chart.png` replaced the page with the
      // picture: a screenshot often holds a tag's worth of bytes somewhere,
      // which is all the HTML check below asks for.
      if (content !== null && content.includes("\u0000")) {
        throw new Error(
          "that content has a NUL byte in it, which no page has, so it looks like a picture or another binary file read as text. " +
            "To replace or add a file beside the page, send it in files. " +
            "From a shell, bikeshed update <id> <file> does that with bikeshed-now 0.24.0 or later; an older one sends every file but a .zip as the page",
        );
      }
      // Changing what a document is made of is its editors' own (SPEC §19), as
      // a bundle upload is: open editing exists for correcting text in place.
      if (sendsFiles && !isDocEditor(data, ctx.caller.uid, ctx.caller.emailLower)) {
        throw new Error("only the document's editors can change its files; you can change its text by sending content alone");
      }

      const baseVersion = String(data.currentVersion ?? "");
      // Optional, so an older client keeps working; absent, the update replaces
      // whatever is current, as it always has.
      const revisedFrom = args.baseVersion === undefined ? null : selectedVersion(args.baseVersion, data.currentVersion);
      if (revisedFrom && revisedFrom !== baseVersion) {
        throw new Error(
          `the document is at ${baseVersion} now, not ${revisedFrom}: somebody published since you read it. ` +
            "Read it again with get_document, then update that",
        );
      }
      const vSnap = await ref.collection("versions").doc(baseVersion).get();
      const format = vSnap.data()?.format === "markdown" ? "markdown" : "html";
      const filename = format === "html" ? "index.html" : "index.md";
      // The reading get_document hands out by default is Markdown. Sent back
      // here it would be published AS index.html, the document's whole page
      // replaced by its own summary, so text without a tag is refused.
      if (content !== null && format === "html" && !LOOKS_LIKE_HTML.test(content)) {
        throw new Error(
          "this is an HTML document and that content has no HTML in it, so it looks like the Markdown reading get_document returns, which is not the source. " +
            'Read the source with get_document and as: "source" (or bikeshed get --source), revise that, and send it back',
        );
      }
      // A Markdown document's `.md` address answers its Markdown under front
      // matter that is not part of it, and a reading opens with front matter
      // too. Sent back whole, either would become the document's first lines
      // (ADR 0042). An author's own front matter is not ours and passes.
      if (content !== null && format === "markdown" && opensWithOwnFrontMatter(content)) {
        throw new Error(
          "that content opens with the front matter Bikeshed puts on a document's .md address, which is not part of the document. " +
            "Send only the Markdown that follows it, or read the source with get_document (or bikeshed get), revise that, and send it back",
        );
      }

      const v = vSnap.data() ?? {};
      const slots = {
        entry: String(v.entry ?? "index.html"),
        format,
        ...(typeof v.sourceEntry === "string" ? { sourceEntry: v.sourceEntry } : format === "markdown" ? { sourceEntry: "index.md" } : {}),
      } as const;
      const sent = decodeAgentFiles(args.files, slots);
      if ("error" in sent) throw new Error(sent.error);
      let input: { extracted: ExtractedBundle } | { overlay: { files: BundleEntry[] } };
      if (sendsFiles) {
        // The page, when sent, and the files, each at its path; every other
        // file is carried as it is (SPEC §19).
        const pageFile = content === null ? [] : [{ rel: pagePath(slots), data: Buffer.from(content, "utf8") }];
        input = { overlay: { files: [...pageFile, ...sent.files] } };
      } else {
        const extracted = extractBundle(Buffer.from(content ?? "", "utf8"), filename, MAX_BUNDLE_BYTES);
        if ("error" in extracted) throw new Error(extracted.error);
        // The sent file replaces the entry; the files beside it are carried
        // forward, exactly as an in-app commit does (SPEC §19).
        input = { extracted };
      }
      const committed = await reviseDocument({
        db: ctx.db,
        docRef: ref,
        baseVersion,
        title: String(data.title ?? ref.id),
        ...input,
        actor: ctx.actor,
        authorEmail: ctx.caller.emailLower,
        k: proof.k,
        ...(sendsFiles ? { editorsOnly: true } : {}),
      });
      if ("error" in committed) throw new Error(committed.error);
      // A comment thread stays on the version it was opened on, and this path
      // does not refuse to leave one behind (only the in-app commit does, by
      // decision, SPEC §19), so the caller is told how many it left.
      const threadsLeftBehind = committed.deduped
        ? 0
        : (
            await ref.collection("versions").doc(baseVersion).collection("annotations")
              .where("resolved", "==", false).count().get()
          ).data().count;
      // The id comes from the document, not from the result: an update result is
      // about a version and does not name the document it belongs to.
      return withReaderAddress({ ...committed, threadsLeftBehind }, ref.id);
    },
  },

  {
    name: "commit_draft",
    description:
      "Publish a document's draft as its new version: the changes accepted into it, and any a person made in the app. " +
      "As \"Save as new version\" in the app, every thread on the current version must be resolved and every suggestion decided first. " +
      "Refused while somebody has the document open in the editor.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        baseVersion: { type: "string", description: "The current version on which the draft is based. Refuse if it changed." },
        id: { type: "string", description: "The document id." },
      },
    },
    async run(ctx, args) {
      // Whoever may edit, as for the app's own commit, which takes no link key either.
      const { ref, data, proof } = await loadDoc(ctx, str(args, "id"));
      if (!canEdit(data, ctx.caller, proof)) throw new Error("you cannot publish that document's draft");
      refuseIfFrozen(data);
      const baseVersion = mutationVersion(args.baseVersion, data);
      const editors = await editorsRefusal(ref.id, "published");
      if ("refusal" in editors) throw new Error(editors.refusal.error);
      const outcome = await commitDraft({
        db: ctx.db,
        docRef: ref,
        baseVersion,
        draft: data.draft as { entry?: unknown; editSessions?: unknown } | undefined,
        emailLower: ctx.caller.emailLower,
        actor: ctx.actor,
      });
      if (outcome.status !== 200) throw new Error(String(outcome.body.error));
      // As the app does once it has published: the log was the draft's, and
      // the next editor seeds from the new version.
      return withReaderAddress(outcome.body, ref.id);
    },
  },
];
