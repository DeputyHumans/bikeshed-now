// SPDX-License-Identifier: Apache-2.0
// The nine MCP tools (SPEC §19).

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
  expiryMs,
  isDocEditor,
  isExpired,
  visibilityOf,
  type DocAclData,
  type FolderAclData,
} from "../lib/acl";
import { extractBundle } from "../lib/bundle";
import { linkProofFor } from "../lib/linkgrant";
import {
  BAD_DOC_ID,
  createFolderRecord,
  isValidDocId,
  persistDocMembership,
  resolveFolderTarget,
} from "../lib/folders";
import { commitNewVersion, compileBundle, publishNewDocument } from "../lib/publish";
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
/** Source is capped so one oversized document cannot consume an agent's context. */
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
      "Fetch a document's metadata and its current SOURCE (Markdown when the document is Markdown-authored).",
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
        source: truncated ? source.slice(0, SOURCE_LIMIT) : source,
        truncated,
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
      if (!canEdit(data, ctx.caller, proof)) throw new Error("you cannot edit that document");
      refuseIfExpired(data);
      const content = String(args.content ?? "");
      if (!content.trim()) throw new Error("content is empty");

      const baseVersion = String(data.currentVersion ?? "");
      const vSnap = await ref.collection("versions").doc(baseVersion).get();
      const format = vSnap.data()?.format === "markdown" ? "markdown" : "html";
      const filename = format === "html" ? "index.html" : "index.md";

      const extracted = extractBundle(Buffer.from(content, "utf8"), filename, MAX_BUNDLE_BYTES);
      if ("error" in extracted) throw new Error(extracted.error);

      const compiled = compileBundle(extracted, String(data.title ?? ref.id));
      const committed = await commitNewVersion({
        db: ctx.db,
        docRef: ref,
        compiled,
        actor: ctx.actor,
        authorEmail: ctx.caller.emailLower,
        baseVersion: baseVersion || null,
        via: "mcp",
      });
      // The id comes from the document, not from the result: an update result is
      // about a version and does not name the document it belongs to.
      return withReaderAddress(committed, ref.id);
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
          viewers: asArray(data.viewers),
          editors: asArray(data.editors),
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
          comments: comments.docs.map((c) => {
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
    name: "reply_to_comment",
    description: "Add a reply to an existing comment thread.",
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

/** Exported for the wiring test: the surface is nine tools, not "some tools". */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

void isDocEditor;
