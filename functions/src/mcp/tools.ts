// SPDX-License-Identifier: Apache-2.0
// The thirteen MCP tools (SPEC §19).

/**
 * Chosen to close a loop, not to expose a surface.
 *
 * `get_comments` is what earns this whole feature. Because every annotation
 * stores the passage it is anchored to — exact, prefix and suffix — a comment
 * comes back WITH the text it is about, so an agent knows what to change without
 * fetching the document and diffing it. Publish a draft, humans highlight the
 * sentences they object to, the agent reads anchored feedback and revises. That
 * is the product, and it is the reason to have an agent surface at all.
 *
 * Efficiency is a correctness concern here, because agent context is the scarce
 * resource:
 *   - `list_documents` returns metadata only.
 *   - `get_document` returns SOURCE, never rendered HTML with its embedded
 *     stylesheet — the rendering is three kilobytes of CSS the agent cannot use.
 *   - `get_comments` returns quote, comment, author and thread id, nothing else.
 *   - Everything is capped and cursor-paginated.
 *
 * The three folder tools are the workspace half of the same argument. An agent
 * that can publish but cannot see where things go either drops everything at
 * the root or asks a person to file it — and the person is not there, which is
 * why an agent is doing this. `list_folders` returns whole paths rather than a
 * tree to walk, so placing a document is one call and not a traversal.
 *
 * What they deliberately do NOT include is deleting or sharing a folder.
 * Deletion reparents everything beneath it, sharing decides who can read what;
 * both are decisions a person makes, and the guide says so in the same words.
 */

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { bucketName, publicOrigin } from "../config";
import type { Actor } from "../lib/actor";
import type { Principal } from "../lib/auth";
import {
  canEdit,
  canEditFolder,
  canManageSharing,
  canRead,
  canSuggest,
  expiryMs,
  isDocEditor,
  isExpired,
  visibilityOf,
  type DocAclData,
  type FolderAclData,
} from "../lib/acl";
import { grantsOf } from "../lib/access";
import { extractBundle } from "../lib/bundle";
import { linkProofFor } from "../lib/linkgrant";
import {
  BAD_DOC_ID,
  createFolderRecord,
  isValidDocId,
  persistDocMembership,
  resolveFolderTarget,
} from "../lib/folders";
import { forkDocument, lineageFor, type Lineage } from "../lib/fork";
import { compileBundle, publishNewDocument, reviseDocument } from "../lib/publish";
import { locateQuote } from "../lib/quote";
import { ANNOTATION_COLOR, SUGGESTION_COLOR, createSuggestion, parseNote } from "../lib/suggestions";
import { MAX_BUNDLE_BYTES } from "../config";

type Db = admin.firestore.Firestore;

const LIST_LIMIT = 50;
const COMMENT_LIMIT = 50;
/**
 * The folder tree comes back whole or not at all.
 *
 * Paginating it would be worse than capping it: a page of folders cannot render
 * its own paths, because an ancestor may be on the next page, so half a tree is
 * a tree with wrong names in it. A workspace with more than two hundred folders
 * says so in `truncated` rather than quietly returning some of them.
 */
const FOLDER_LIMIT = 200;
/**
 * Source is capped so one oversized document cannot consume an agent's context.
 * The CLI prints to a file or a pipe instead, so it reads a cut source whole
 * through /content rather than inheriting this cap.
 */
const SOURCE_LIMIT = 200_000;

export interface ToolContext {
  db: Db;
  caller: Principal;
  actor: Actor;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

/**
 * A folder's full path, given the names the caller is allowed to know.
 *
 * An ancestor can be INVISIBLE. Membership cascades downward, so a grant on a
 * folder carries to everything beneath it — but a grant made directly on a
 * child says nothing about its parent, and that parent is then absent from the
 * caller's listing. Rendering its raw id would look like a folder they could
 * navigate to; dropping the level entirely would make a nested folder read as a
 * top-level one, and an agent would file things by a path that does not exist.
 *
 * An ellipsis is the only one of the three that is true: there is a level here,
 * and it is not yours.
 *
 * Pure, and exported, because it is the only part of `list_folders` with a
 * decision in it — the rest is a query.
 */
export function folderPath(
  ancestors: readonly string[],
  name: string,
  nameOf: ReadonlyMap<string, string>,
): string {
  return [...ancestors.map((id) => nameOf.get(id) ?? "…"), name].join("/");
}

/** How every tool that reads one document describes the unlisted key. */
const LINK_KEY_DESCRIPTION =
  "Only for an unlisted document you are not a member of: the key from its link, the value after ?k=. Without it such a document answers exactly as an id that does not exist.";

/**
 * Load a document the caller may read, or fail exactly as for an id that does
 * not exist. `k` is an unlisted document's key; a caller whose account already
 * holds a link grant needs none (SPEC §17).
 */
async function loadDoc(ctx: ToolContext, slug: string, k: string | null = null) {
  const ref = ctx.db.collection("docs").doc(slug);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`no document with id "${slug}"`);
  const data = snap.data() as DocAclData & Record<string, unknown>;
  const proof = await linkProofFor(ref, data, ctx.caller, k);
  if (!canRead(data, ctx.caller, proof)) throw new Error(`no document with id "${slug}"`);
  // An expired document reads as absent to everyone but its owner — the same
  // answer a document they may not read gives, so expiry cannot be used to
  // confirm that a slug exists (SPEC §17).
  if (isExpired(data, Date.now()) && !canManageSharing(data, ctx.caller.emailLower)) {
    throw new Error(`no document with id "${slug}"`);
  }
  return { ref, snap, data, proof };
}

/**
 * Find an agent's quoted passage in a document's current version.
 *
 * Looked for in the RENDERED entry, which is what a reader reads and what the
 * browser will look in: for a Markdown document, its HTML, not its source.
 * `crossesBlock` is the one refusal that differs by tool, because what to do
 * about a passage spanning two paragraphs depends on what is being done to it.
 */
async function locateInCurrentVersion(
  ref: admin.firestore.DocumentReference,
  versionId: string,
  args: Record<string, unknown>,
  crossesBlock: string,
) {
  const vSnap = await ref.collection("versions").doc(versionId).get();
  const entry = String(vSnap.data()?.entry ?? "index.html");
  let html = "";
  try {
    const [bytes] = await admin.storage().bucket(bucketName()).file(`docs/${ref.id}/${versionId}/${entry}`).download();
    html = bytes.toString("utf8");
  } catch {
    throw new Error("could not read the current version");
  }

  const located = locateQuote(html, {
    exact: String(args.exact ?? ""),
    prefix: typeof args.prefix === "string" ? args.prefix : undefined,
    suffix: typeof args.suffix === "string" ? args.suffix : undefined,
  });
  if ("error" in located) {
    throw new Error(
      located.error === "ambiguous"
        ? `that passage occurs ${located.count} times; add a prefix or suffix of the words around the one you mean`
        : located.error === "crosses-block"
          ? crossesBlock
          : "that passage is not in the current version; quote it as a reader sees it, without Markdown or HTML, within one paragraph",
    );
  }
  return { versionId, anchor: located.anchor };
}

/** Writes are refused on an expired document, the owner's included. */
function refuseIfExpired(data: DocAclData): void {
  if (isExpired(data, Date.now())) {
    throw new Error("this document has expired — change or clear its expiry to edit it");
  }
}

/**
 * Record the fetch as an automated read.
 *
 * `ms: 0` into `stats.apiReads`, never into `stats.views` or `stats.totalMs`.
 * An agent calling this forty times would otherwise turn a document's reading
 * statistics into noise, and reading TIME is not a concept that applies to a
 * machine fetch at all (SPEC §17).
 */
async function recordApiRead(
  ctx: ToolContext,
  docRef: admin.firestore.DocumentReference,
  versionId: string,
): Promise<void> {
  const sessionId = `api-${ctx.actor.tokenId ?? ctx.caller.uid}-${versionId}`;
  try {
    await docRef.collection("views").doc(sessionId).set(
      {
        sessionId,
        uid: ctx.caller.uid,
        email: ctx.caller.emailLower,
        versionId,
        ms: 0,
        via: "app",
        automated: true,
        actor: ctx.actor,
        reads: FieldValue.increment(1),
        lastBeatAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await docRef.set(
      { stats: { apiReads: FieldValue.increment(1) } },
      { merge: true },
    );
  } catch {
    /* statistics are best-effort and never fail the read */
  }
}

/**
 * A result, plus where a reader opens the document.
 *
 * An agent over MCP cannot work this out. The origin lives in its client's
 * configuration, not in anything the protocol hands it, so the one thing it has
 * to give a person back — the address — is the one thing only the server knows.
 *
 * Omitted rather than guessed when the deployment has no configured origin: a
 * bare `/d/<id>` path looks like an address and is not one, and an agent that
 * pastes it has handed over something broken (SPEC §17).
 */
export function withReaderAddress<T extends object>(result: T, docId: string): T {
  const origin = publicOrigin();
  return origin ? { ...result, url: `${origin}/d/${docId}` } : result;
}

/**
 * The lineage answer, in the vocabulary the other tools use: `id` and
 * `version`, an ISO date, and the address a person opens for every document an
 * agent might hand back. Nothing is added that the endpoint did not decide the
 * caller may see; this only renames and dates it. Pure, so the shape is pinned.
 */
export function lineageForAgent(docId: string, lineage: Lineage) {
  return {
    id: docId,
    forked: lineage.forked,
    // Nearest first. Stops at the first document the caller cannot open.
    forkedFrom: lineage.ancestors.map((a) =>
      withReaderAddress(
        {
          id: a.docId,
          title: a.title,
          version: a.versionId,
          ...(a.ownerEmail ? { owner: a.ownerEmail } : {}),
          ...(a.changed !== undefined ? { changedSince: a.changed } : {}),
        },
        a.docId,
      ),
    ),
    moreYouCannotOpen: lineage.hiddenAncestor,
    ...(lineage.forks
      ? {
          forks: {
            total: lineage.forks.total,
            youCannotOpen: lineage.forks.hidden,
            listed: lineage.forks.visible.map((f) =>
              withReaderAddress(
                {
                  id: f.docId,
                  title: f.title,
                  visibility: f.visibility,
                  forkedAt: f.forkedAt === null ? null : new Date(f.forkedAt).toISOString(),
                  ...(f.ownerEmail ? { owner: f.ownerEmail } : {}),
                },
                f.docId,
              ),
            ),
          },
        }
      : {}),
  };
}

export const TOOLS: ToolDefinition[] = [
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
      const page = snap.docs.slice(0, limit);

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
    name: "get_document",
    description:
      "Fetch a document's metadata and its current SOURCE (Markdown when the document is Markdown-authored). " +
      `A source over ${SOURCE_LIMIT.toLocaleString("en-US")} characters is cut, and \`truncated\` says so. ` +
      "Never send a cut source back through update_document: the new version would lose everything after the cut. " +
      "`bikeshed get` prints the whole source.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The document id, as returned by list_documents." },
        version: { type: "string", description: "A specific version, e.g. v3. Defaults to current." },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const { ref, data, proof } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
      const versionId = str(args, "version") || String(data.currentVersion ?? "");
      const vSnap = await ref.collection("versions").doc(versionId).get();
      if (!vSnap.exists) throw new Error(`no version "${versionId}"`);
      const v = vSnap.data() || {};

      const sourceRel =
        typeof v.sourceEntry === "string" ? v.sourceEntry : String(v.entry ?? "index.html");
      const key = `docs/${ref.id}/${versionId}/${sourceRel}`;
      let source = "";
      try {
        const [bytes] = await admin.storage().bucket(bucketName()).file(key).download();
        source = bytes.toString("utf8");
      } catch {
        source = "";
      }
      const truncated = source.length > SOURCE_LIMIT;

      await recordApiRead(ctx, ref, versionId);

      return {
        id: ref.id,
        title: data.title,
        version: versionId,
        format: v.format ?? "html",
        sourceFile: sourceRel,
        visibility: visibilityOf(data),
        expiresAt: expiryMs(data),
        canEdit: canEdit(data, ctx.caller, proof) && !isExpired(data, Date.now()),
        canSuggest: canSuggest(data, ctx.caller, proof) && !isExpired(data, Date.now()),
        forked: data.forked === true,
        // Ahead of the source, not after it: an agent reads this result as JSON
        // text in key order, and a flag after 200,000 characters of source is a
        // flag it may never reach.
        truncated,
        source: truncated ? source.slice(0, SOURCE_LIMIT) : source,
      };
    },
  },

  {
    name: "publish_document",
    description:
      "Create a new document from content you supply. Markdown is rendered server-side; HTML is stored as authored.",
    inputSchema: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "The document source." },
        format: { type: "string", enum: ["markdown", "html"], description: "Default markdown." },
        folder: { type: "string", description: "Destination folder id. Optional." },
        id: {
          type: "string",
          description:
            "The id to publish at, the part of the address after /d/. Optional; default is from the title. " +
            "If it is taken, a random suffix is added, so use the docId this returns.",
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

      const extracted = extractBundle(Buffer.from(content, "utf8"), filename, MAX_BUNDLE_BYTES);
      if ("error" in extracted) throw new Error(extracted.error);

      const target = await resolveFolderTarget(ctx.db, args.folder, ctx.caller);
      if (!target.ok) throw new Error(target.error);

      const compiled = compileBundle(extracted, title);
      // `via: "mcp"` is stamped here, from the endpoint, not from anything the
      // caller sent. Provenance survives the agent path (SPEC §17).
      const published = await publishNewDocument({
        db: ctx.db,
        actor: ctx.actor,
        ownerEmail: ctx.caller.emailLower,
        ownerUid: ctx.caller.uid,
        compiled,
        title,
        folderId: target.id,
        parentMembership: target.membership,
        via: "mcp",
        ...(wantedId ? { docId: wantedId } : {}),
      });
      return withReaderAddress(published, published.docId);
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
          description: LINK_KEY_DESCRIPTION,
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
        { docId: out.docId, versionId: out.versionId, title: out.title },
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
          description: LINK_KEY_DESCRIPTION,
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
      "Publish a new version of an existing document. Identical content is a no-op, so this is safe to retry.",
    inputSchema: {
      type: "object",
      required: ["id", "content"],
      properties: {
        id: { type: "string" },
        content: { type: "string" },
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
            ? "you cannot edit that document, but you can suggest an edit to it with suggest_edit; a person accepts or rejects it"
            : "you cannot edit that document",
        );
      }
      refuseIfExpired(data);
      const content = String(args.content ?? "");
      if (!content.trim()) throw new Error("content is empty");

      const baseVersion = String(data.currentVersion ?? "");
      const vSnap = await ref.collection("versions").doc(baseVersion).get();
      const format = vSnap.data()?.format === "markdown" ? "markdown" : "html";
      const filename = format === "html" ? "index.html" : "index.md";

      const extracted = extractBundle(Buffer.from(content, "utf8"), filename, MAX_BUNDLE_BYTES);
      if ("error" in extracted) throw new Error(extracted.error);

      // The sent file replaces the entry; the files beside it are carried
      // forward, exactly as an in-app commit does (SPEC §19).
      const committed = await reviseDocument({
        db: ctx.db,
        docRef: ref,
        baseVersion,
        title: String(data.title ?? ref.id),
        extracted,
        actor: ctx.actor,
        authorEmail: ctx.caller.emailLower,
        via: "mcp",
      });
      if ("error" in committed) throw new Error(committed.error);
      // The id comes from the document, not from the result: an update result is
      // about a version and does not name the document it belongs to.
      return withReaderAddress(committed, ref.id);
    },
  },

  {
    name: "suggest_edit",
    description:
      "Propose replacing a passage of a document's current version with new text, for a person to accept or reject. " +
      "Quote the passage exactly as a reader sees it — no Markdown or HTML — within one paragraph. " +
      "An empty replacement proposes deleting it. If the passage occurs more than once, add a few words " +
      "before it (prefix) or after it (suffix). Accepting or rejecting is a person's decision; there is no tool for it.",
    inputSchema: {
      type: "object",
      // `replacement` is required in practice but not listed: an empty string
      // is a deletion, and the protocol layer treats "" as a missing argument.
      required: ["id", "exact"],
      properties: {
        id: { type: "string" },
        exact: { type: "string", description: "The passage, as a reader sees it, within one paragraph." },
        replacement: { type: "string", description: "What it should say instead. Empty proposes deleting it." },
        prefix: { type: "string", description: "Words just before the passage, to say which one when it repeats." },
        suffix: { type: "string", description: "Words just after the passage, to say which one when it repeats." },
        note: { type: "string", description: "Why, for whoever decides. Optional." },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const { ref, data, proof } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
      if (!canSuggest(data, ctx.caller, proof)) throw new Error("you cannot suggest edits to that document");
      refuseIfExpired(data);
      if (typeof args.replacement !== "string") {
        throw new Error("replacement is required: the new text, or an empty string to propose deleting the passage");
      }
      const note = parseNote(args.note);
      if (typeof note !== "string") throw new Error(note.error);

      const { versionId, anchor } = await locateInCurrentVersion(
        ref,
        String(data.currentVersion ?? ""),
        args,
        "a suggestion changes text within one paragraph, and that passage spans more than one, or a line break; suggest each part on its own",
      );

      const created = await createSuggestion({
        db: ctx.db,
        docRef: ref,
        versionId,
        anchor,
        replacement: args.replacement,
        note,
        author: { uid: ctx.caller.uid, emailLower: ctx.caller.emailLower },
        actor: ctx.actor,
        color: SUGGESTION_COLOR,
      });
      if ("status" in created) throw new Error(created.error);
      return withReaderAddress({ threadId: created.annId, version: versionId, quote: anchor.exact }, ref.id);
    },
  },

  {
    name: "list_folders",
    description:
      "List every folder you can see, each with its full path. Use an id as the `folder` argument to publish_document or move_document.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      const snap = await ctx.db
        .collection("folders")
        .where("members", "array-contains", ctx.caller.emailLower)
        .orderBy("createdAt", "desc")
        .limit(FOLDER_LIMIT + 1)
        .get();
      const page = snap.docs.slice(0, FOLDER_LIMIT);
      const nameOf = new Map(page.map((d) => [d.id, String(d.data().name ?? d.id)]));

      const folders = page.map((d) => {
        const v = d.data();
        const name = String(v.name ?? d.id);
        return {
          id: d.id,
          name,
          parent: typeof v.parentId === "string" ? v.parentId : null,
          path: folderPath(asArray(v.ancestors), name, nameOf),
          // Read access and write access differ here: a folder shared with you
          // as a viewer is one you can see and cannot file into.
          canWrite: canEditFolder(
            v as FolderAclData,
            ctx.caller.uid,
            ctx.caller.emailLower,
          ),
        };
      });
      // Sorted by path so the listing reads as a tree, and compared by code
      // unit rather than by locale so two callers get the same order.
      folders.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { folders, truncated: snap.docs.length > FOLDER_LIMIT };
    },
  },

  {
    name: "create_folder",
    description:
      "Create a folder, optionally inside one you can already write to. Returns its id.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Up to 120 characters." },
        parent: {
          type: "string",
          description: "Folder id to create it inside. Omit for the workspace root.",
        },
      },
    },
    async run(ctx, args) {
      const name = str(args, "name");
      if (!name || name.length > 120) {
        throw new Error("folder name is required (up to 120 characters)");
      }
      const parent = await resolveFolderTarget(ctx.db, args.parent, ctx.caller);
      if (!parent.ok) throw new Error(parent.error);
      return createFolderRecord(ctx.db, ctx.caller, name, parent);
    },
  },

  {
    name: "move_document",
    description:
      "Move a document into a folder. OMIT `folder` to move it out to the workspace root.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The document id." },
        folder: {
          type: "string",
          description:
            "Destination folder id, from list_folders. OMIT this argument to move the document to the workspace root.",
        },
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"));
      // Moving a document changes who inherits access to it: the destination
      // folder's members become its members. So it takes the REAL editor set,
      // not open editing — otherwise any account could file someone's
      // open-editing document into its own folder and become a member.
      if (!isDocEditor(data, ctx.caller.uid, ctx.caller.emailLower)) {
        throw new Error("you cannot move that document");
      }
      refuseIfExpired(data);

      const target = await resolveFolderTarget(ctx.db, args.folder, ctx.caller);
      if (!target.ok) throw new Error(target.error);

      // persistDocMembership, not a bare field write: a document's effective
      // membership is its own grants unioned with its folder's, so moving it
      // between folders changes who can read it. The presence mirror and the
      // public projection are recomputed in the same call, which is the whole
      // reason that helper exists.
      await persistDocMembership(
        ctx.db,
        ref,
        {
          ownerEmail: String(data.ownerEmail ?? ""),
          grants: grantsOf(data),
          folderId: target.id,
        },
        { folderId: target.id },
      );
      return { id: ref.id, folder: target.id };
    },
  },

  {
    name: "get_comments",
    description:
      "Unresolved feedback on a document, each with the exact passage it is anchored to.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        includeResolved: { type: "boolean", description: "Default false." },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
      const versionId = String(data.currentVersion ?? "");
      const annRef = ref.collection("versions").doc(versionId).collection("annotations");
      const query = args.includeResolved === true ? annRef : annRef.where("resolved", "==", false);
      const anns = await query.limit(COMMENT_LIMIT).get();

      const threads = [];
      for (const a of anns.docs) {
        const ann = a.data();
        const comments = await a.ref.collection("comments").orderBy("createdAt", "asc").get();
        threads.push({
          threadId: a.id,
          quote: String(ann.anchor?.exact ?? ""),
          section: String(ann.anchor?.elementId ?? ""),
          resolved: ann.resolved === true,
          // A suggested edit: what the quote would become ("" deletes it), and
          // whether a person has accepted or rejected it yet (SPEC §22).
          ...(ann.suggestion
            ? {
                suggestion: {
                  replacement: String(ann.suggestion.replacement ?? ""),
                  state: String(ann.suggestion.state ?? "pending"),
                },
              }
            : {}),
          comments: comments.docs
            // The server's restatement of a suggestion says nothing the
            // `suggestion` field does not; a note its author wrote, and every
            // decision, are kept.
            .filter((c) => !(c.data().opensSuggestion === true && c.data().generated === true))
            .map((c) => {
              const v = c.data();
              return {
                author: v.authorEmail,
                via: (v.actor as Actor | undefined)?.channel ?? "web",
                body: v.body,
              };
            }),
        });
      }
      return { id: ref.id, version: versionId, threads };
    },
  },

  {
    name: "add_comment",
    description:
      "Start a new comment thread on a passage of a document's current version. " +
      "Quote the passage exactly as a reader sees it — no Markdown or HTML — within one paragraph. " +
      "If it occurs more than once, add a few words before it (prefix) or after it (suffix). " +
      "A thread belongs to the version it was opened on: get_comments stops listing it once a new version is published, " +
      "and a person resolves it; there is no tool for that. " +
      "To answer a thread that already exists, use reply_to_comment.",
    inputSchema: {
      type: "object",
      required: ["id", "exact", "body"],
      properties: {
        id: { type: "string" },
        exact: { type: "string", description: "The passage, as a reader sees it, within one paragraph." },
        body: { type: "string", description: "The comment." },
        prefix: { type: "string", description: "Words just before the passage, to say which one when it repeats." },
        suffix: { type: "string", description: "Words just after the passage, to say which one when it repeats." },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
      refuseIfExpired(data);
      const body = String(args.body ?? "").trim().slice(0, 5000);
      if (!body) throw new Error("body is empty");

      const { versionId, anchor } = await locateInCurrentVersion(
        ref,
        String(data.currentVersion ?? ""),
        args,
        "a comment is anchored to text within one paragraph, and that passage spans more than one, or a line break; quote the part you mean",
      );

      // `strict` because this anchor was found by its quote with no DOM, so its
      // offsets are a block-local hint, not positions in the page. A viewer
      // that fell back to them would highlight the wrong words; one that
      // resolves the quote exactly or not at all shows an orphan instead.
      const annRef = ref.collection("versions").doc(versionId).collection("annotations").doc();
      const commentRef = annRef.collection("comments").doc();
      const author = {
        authorUid: ctx.caller.uid,
        authorEmail: ctx.caller.emailLower,
        actor: ctx.actor,
        createdAt: FieldValue.serverTimestamp(),
      };
      // One batch: a thread with no comment in it is a highlight that says nothing.
      const batch = ctx.db.batch();
      batch.create(annRef, {
        annId: annRef.id,
        anchor: { ...anchor, strict: true },
        ...author,
        color: ANNOTATION_COLOR,
        resolved: false,
      });
      batch.create(commentRef, { commentId: commentRef.id, body, ...author });
      await batch.commit();
      return withReaderAddress({ threadId: annRef.id, version: versionId, quote: anchor.exact }, ref.id);
    },
  },

  {
    name: "reply_to_comment",
    description: "Add a reply to an existing comment thread. To start a new one, use add_comment.",
    inputSchema: {
      type: "object",
      required: ["id", "threadId", "body"],
      properties: {
        id: { type: "string" },
        threadId: { type: "string", description: "From get_comments." },
        body: { type: "string" },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
      refuseIfExpired(data);
      const threadId = str(args, "threadId");
      const body = String(args.body ?? "").slice(0, 5000);
      if (!body.trim()) throw new Error("body is empty");

      const versionId = String(data.currentVersion ?? "");
      const annRef = ref
        .collection("versions")
        .doc(versionId)
        .collection("annotations")
        .doc(threadId);
      if (!(await annRef.get()).exists) throw new Error("no such thread");

      const commentRef = annRef.collection("comments").doc();
      await commentRef.set({
        commentId: commentRef.id,
        body,
        authorUid: ctx.caller.uid,
        authorEmail: ctx.caller.emailLower,
        // The actor is what makes this reply visibly machine-authored in the UI
        // and in the notification email. A reviewer should never have to guess
        // whether feedback came from a person.
        actor: ctx.actor,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { commentId: commentRef.id, threadId, documentId: ref.id };
    },
  },
];

/** Tools an editor-only caller may still call, for the error message. */
export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Exported for the wiring test: the surface is thirteen tools, not "some tools". */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

void isDocEditor;
