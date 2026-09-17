// SPDX-License-Identifier: Apache-2.0
// The six MCP tools (SPEC §19).

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
 */

import * as admin from "firebase-admin";
import { bucketName } from "../config";
import type { Actor } from "../lib/actor";
import type { Principal } from "../lib/auth";
import { canEdit, canRead, isDocEditor, visibilityOf, type DocAclData } from "../lib/acl";
import { extractBundle } from "../lib/bundle";
import { commitNewVersion, compileBundle, publishNewDocument } from "../lib/publish";
import { MAX_BUNDLE_BYTES } from "../config";

type Db = admin.firestore.Firestore;

const LIST_LIMIT = 50;
const COMMENT_LIMIT = 50;
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

async function loadDoc(ctx: ToolContext, slug: string) {
  const ref = ctx.db.collection("docs").doc(slug);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`no document with id "${slug}"`);
  const data = snap.data() as DocAclData & Record<string, unknown>;
  if (!canRead(data, ctx.caller)) throw new Error(`no document with id "${slug}"`);
  return { ref, snap, data };
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
        reads: admin.firestore.FieldValue.increment(1),
        lastBeatAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await docRef.set(
      { stats: { apiReads: admin.firestore.FieldValue.increment(1) } },
      { merge: true },
    );
  } catch {
    /* statistics are best-effort and never fail the read */
  }
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
      const rows = snap.docs.slice(0, limit).map((d) => {
        const v = d.data();
        return {
          id: d.id,
          title: v.title,
          version: v.currentVersion,
          format: v.format ?? "html",
          visibility: visibilityOf(v as DocAclData),
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
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"));
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
        canEdit: canEdit(data, ctx.caller),
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
      },
    },
    async run(ctx, args) {
      const title = str(args, "title");
      const content = String(args.content ?? "");
      if (!title) throw new Error("title is required");
      if (!content.trim()) throw new Error("content is empty");
      const format = args.format === "html" ? "html" : "markdown";
      const filename = format === "html" ? "index.html" : "index.md";

      const extracted = extractBundle(Buffer.from(content, "utf8"), filename, MAX_BUNDLE_BYTES);
      if ("error" in extracted) throw new Error(extracted.error);

      const folder = str(args, "folder");
      let parentMembership = null as null | { members: string[]; editorMembers: string[] };
      if (folder) {
        const f = await ctx.db.collection("folders").doc(folder).get();
        if (!f.exists) throw new Error("destination folder not found");
        const fd = f.data() || {};
        if (!(Array.isArray(fd.editorMembers) && fd.editorMembers.includes(ctx.caller.emailLower))) {
          throw new Error("you cannot add to that folder");
        }
        parentMembership = {
          members: (fd.members as string[]) ?? [],
          editorMembers: (fd.editorMembers as string[]) ?? [],
        };
      }

      const compiled = compileBundle(extracted, title);
      // `via: "mcp"` is stamped here, from the endpoint, not from anything the
      // caller sent. Provenance survives the agent path (SPEC §17).
      return publishNewDocument({
        db: ctx.db,
        actor: ctx.actor,
        ownerEmail: ctx.caller.emailLower,
        ownerUid: ctx.caller.uid,
        compiled,
        title,
        folderId: folder || null,
        parentMembership,
        via: "mcp",
      });
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
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"));
      if (!canEdit(data, ctx.caller)) throw new Error("you cannot edit that document");
      const content = String(args.content ?? "");
      if (!content.trim()) throw new Error("content is empty");

      const baseVersion = String(data.currentVersion ?? "");
      const vSnap = await ref.collection("versions").doc(baseVersion).get();
      const format = vSnap.data()?.format === "markdown" ? "markdown" : "html";
      const filename = format === "html" ? "index.html" : "index.md";

      const extracted = extractBundle(Buffer.from(content, "utf8"), filename, MAX_BUNDLE_BYTES);
      if ("error" in extracted) throw new Error(extracted.error);

      const compiled = compileBundle(extracted, String(data.title ?? ref.id));
      return commitNewVersion({
        db: ctx.db,
        docRef: ref,
        compiled,
        actor: ctx.actor,
        authorEmail: ctx.caller.emailLower,
        baseVersion: baseVersion || null,
        via: "mcp",
      });
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
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"));
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
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"));
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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { commentId: commentRef.id, threadId, documentId: ref.id };
    },
  },
];

/** Tools an editor-only caller may still call, for the error message. */
export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Exported for the wiring test: the surface is six tools, not "some tools". */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

void isDocEditor;
