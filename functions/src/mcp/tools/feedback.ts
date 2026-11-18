// SPDX-License-Identifier: Apache-2.0
// The feedback tools: comments, threads and the change feed (SPEC §19).

import {
  freshReceiptId,
  readReceipt,
  recordReceipt,
  clearReceipt,
} from "../../lib/transaction-receipts";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { currentVersionRefusal, mutationVersion, selectedVersion } from "../../lib/versions";
import { actedThrough, type Actor } from "../../lib/actor";
import {
  canEdit,
  canManageSharing,
  canRead,
  canSuggest,
  expiryMs,
  isDocApprover,
  isDocEditor,
  isFrozen,
  visibilityOf,
  type DocAclData,
} from "../../lib/acl";
import { filedIn } from "../../lib/audience";
import {
  decodeCursor,
  encodeCursor,
  eventsAfter,
  readSavedCursor,
  saveCursor,
  type Cursor,
  eventVisibleTo,
  type EventActor,
} from "../../lib/events";
import { describeEvents, docReader } from "../../lib/changefeed";
import { grantTokenOf, linkGrantRef } from "../../lib/linkgrant";
import { ANNOTATION_COLOR } from "../../lib/suggestions";
import { safeSegment } from "../../lib/http";
import {
  COMMENT_LIMIT,
  CHANGE_PAGE,
  RETRY_AFTER_SECONDS,
  str,
  asArray,
  revisionOut,
  awaitsReply,
  causedBy,
  isMissingIndex,
  LINK_KEY_DESCRIPTION,
  loadDoc,
  locateInCurrentVersion,
  changeThread,
  refuseIfFrozen,
  withReaderAddress,
  threadAddress,
  withThreadAddress,
} from "./shared";
import type { ToolDefinition } from "./shared";

export const FEEDBACK_TOOLS: ToolDefinition[] = [
  {
    name: "get_comments",
    description:
      "Unresolved feedback on a document, oldest thread first, each with the exact passage it is anchored to. " +
      `At most ${COMMENT_LIMIT} threads, and \`truncated\` says when there were more. ` +
      "`awaitingReply` marks an open thread whose latest comment a person wrote in the app; `threads` fetches only the ids you name. " +
      "Threads belong to the version they were opened on; name an earlier version to read its threads. " +
      "Each thread's `url` opens the document on that thread; give it to a person when you tell them about one.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        version: { type: "string", description: "A specific version, e.g. v3. Defaults to current." },
        includeResolved: { type: "boolean", description: "Default false." },
        threads: {
          type: "array",
          items: { type: "string" },
          description: `Only these thread ids, whatever their state; at most ${COMMENT_LIMIT}.`,
        },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
      // Reading an earlier version's threads is what a reader of /d/{id}/{v}
      // does in the app; access is the document's, as the rules have it.
      const versionId = selectedVersion(args.version, data.currentVersion);
      if (!safeSegment(versionId) || !(await ref.collection("versions").doc(versionId).get()).exists) {
        throw new Error(`no version "${versionId}"`);
      }
      const annRef = ref.collection("versions").doc(versionId).collection("annotations");
      const named = asArray(args.threads).filter((t) => typeof t === "string" && safeSegment(t));
      let annDocs: admin.firestore.DocumentSnapshot[];
      let truncated = false;
      if (named.length > 0) {
        const snaps = await ctx.db.getAll(...named.slice(0, COMMENT_LIMIT).map((t) => annRef.doc(t)));
        annDocs = snaps.filter((a) => a.exists);
      } else {
        // Oldest first, so a cut drops the newest threads, never a random set;
        // and one more than the limit is read, so a cut is said rather than
        // silent. createdAt is the server's clock on every thread (SPEC §4).
        let found: admin.firestore.DocumentSnapshot[];
        if (args.includeResolved === true) {
          found = (await annRef.orderBy("createdAt", "asc").limit(COMMENT_LIMIT + 1).get()).docs;
        } else {
          try {
            found = (
              await annRef.where("resolved", "==", false).orderBy("createdAt", "asc").limit(COMMENT_LIMIT + 1).get()
            ).docs;
          } catch (e) {
            // The (resolved, createdAt) index is created by the same deploy
            // that ships this query, after the functions, and takes minutes to
            // build. Until it is ready, read every thread in order and drop the
            // resolved ones here: the same answer, at more reads.
            if (!isMissingIndex(e)) throw e;
            found = (await annRef.orderBy("createdAt", "asc").get()).docs
              .filter((a) => a.data()?.resolved === false)
              .slice(0, COMMENT_LIMIT + 1);
          }
        }
        truncated = found.length > COMMENT_LIMIT;
        annDocs = found.slice(0, COMMENT_LIMIT);
      }
      // Only a thread on the current version can be answered (reply_to_comment).
      const answerable = versionId === String(data.currentVersion ?? "");

      const threads = [];
      for (const a of annDocs) {
        const ann = a.data() ?? {};
        const comments = await a.ref.collection("comments").orderBy("createdAt", "asc").get();
        const shown = comments.docs
          // The server's restatement of a suggestion says nothing the
          // `suggestion` field does not; a note its author wrote, and every
          // decision, are kept.
          .filter((c) => !(c.data().opensSuggestion === true && c.data().generated === true));
        const url = threadAddress(ref.id, versionId, a.id, str(args, "k") || undefined);
        threads.push({
          threadId: a.id,
          ...(url ? { url } : {}),
          quote: String(ann.anchor?.exact ?? ""),
          section: String(ann.anchor?.elementId ?? ""),
          resolved: ann.resolved === true,
          // A suggested edit: what the quote would become ("" deletes it),
          // whether it is still open, and what its author proposed before
          // changing it, oldest first (SPEC §22).
          ...(ann.suggestion
            ? {
                suggestion: {
                  replacement: String(ann.suggestion.replacement ?? ""),
                  state: String(ann.suggestion.state ?? "pending"),
                  ...(Array.isArray(ann.suggestion.revisions) && ann.suggestion.revisions.length
                    ? { revisions: ann.suggestion.revisions.map(revisionOut) }
                    : {}),
                },
              }
            : {}),
          // A person, in the app, spoke last in an open thread you can answer.
          // Never set by an agent's comment, so two agents watching one
          // document cannot keep answering each other.
          awaitingReply: answerable && awaitsReply(ann, shown),
          comments: shown.map((c) => {
            const v = c.data();
            return {
              id: c.id,
              at: (v.createdAt as admin.firestore.Timestamp | undefined)?.toDate?.().toISOString() ?? null,
              author: v.authorEmail,
              ...actedThrough(v.actor as Actor | undefined),
              body: v.body,
            };
          }),
        });
      }
      return withReaderAddress({ id: ref.id, version: versionId, currentVersion: data.currentVersion, isCurrent: answerable, canComment: answerable && !isFrozen(data, Date.now()), truncated, threads }, ref.id, args.version === undefined ? undefined : versionId, str(args, "k") || undefined);
    },
  },

  {
    name: "get_changes",
    description:
      "What happened on a document since a cursor, in the order it was recorded: comments, threads opened, resolved and reopened, " +
      "suggestions opened, revised and decided, versions published and withdrawn, and changes to its title, folder, visibility, expiry, trust and sharing, including doc.expired when its date made it private. " +
      "`since` is REQUIRED: a cursor from an earlier result, \"last\" for the one this credential was last given for this document, or \"all\". " +
      "Replace the cursor you hold with the one this returns, and with no other result's. `more: true` means call again now. " +
      "Events you caused are left out unless includeMine. `needsReply` names the threads a person is waiting on; `state` is the document as it is now.",
    inputSchema: {
      type: "object",
      required: ["id", "since"],
      properties: {
        id: { type: "string", description: "The document id." },
        since: {
          type: "string",
          description: 'A cursor from an earlier result (publish_document, fork_document, get_document or get_changes), "last", or "all".',
        },
        includeMine: { type: "boolean", description: "Include events this credential caused. Default false." },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      const { ref, data, proof } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
      const since = str(args, "since");
      const start: Cursor = { docId: ref.id, at: null, id: null };
      let from: Cursor;
      let resumedFrom: "start" | undefined;
      if (since === "all") {
        from = start;
      } else if (since === "last") {
        const saved = ctx.caller.tokenId ? await readSavedCursor(ctx.db, ctx.caller.uid, ctx.caller.tokenId, ref.id) : null;
        const decoded = saved ? decodeCursor(saved, ref.id) : null;
        // Nothing saved: answer from the start, and say so. Too much, never too little.
        if (!decoded || "error" in decoded) resumedFrom = "start";
        from = decoded && !("error" in decoded) ? decoded : start;
      } else {
        const decoded = decodeCursor(since, ref.id);
        if ("error" in decoded) {
          throw new Error(`since: ${decoded.error}. Pass a cursor from an earlier result, "last" or "all"`);
        }
        from = decoded;
      }

      const raw = await eventsAfter(ref, from, CHANGE_PAGE);
      const more = raw.length > CHANGE_PAGE;
      const page = raw.slice(0, CHANGE_PAGE);
      // The position after the last event READ, whoever may see it, so a page
      // of events this caller may not see still moves them past it.
      const last = page[page.length - 1];
      const cursor = encodeCursor(last ? { docId: ref.id, at: last.data().at, id: last.id } : from);

      const editor = isDocEditor(data, ctx.caller.uid, ctx.caller.emailLower);
      const owner = canManageSharing(data, ctx.caller.emailLower);
      const includeMine = args.includeMine === true;
      const visible = page.filter((e) => {
        const v = e.data();
        if (!eventVisibleTo(v, { editor, owner })) return false;
        return includeMine || !causedBy(v.actor as EventActor | undefined, ctx.caller);
      });

      const current = String(data.currentVersion ?? "");
      const read = docReader(ctx.db);
      const threadPath = (version: string, threadId: string) => `docs/${ref.id}/versions/${version}/annotations/${threadId}`;
      const events = await describeEvents(ctx.db, ref, ctx.caller, visible, read);

      // Threads in this page a person is waiting on, which this caller can
      // still answer: the current version only, as reply_to_comment has it.
      const needsReply: string[] = [];
      for (const threadId of new Set(events.filter((e) => e.version === current && e.threadId).map((e) => String(e.threadId)))) {
        const thread = (await read(threadPath(current, threadId))).data();
        if (!thread) continue;
        const comments = await ctx.db.doc(threadPath(current, threadId)).collection("comments").orderBy("createdAt", "asc").get();
        if (awaitsReply(thread, comments.docs)) needsReply.push(threadId);
      }

      const annotations = ref.collection("versions").doc(current).collection("annotations");
      const [open, pending, where] = await Promise.all([
        annotations.where("resolved", "==", false).count().get(),
        annotations.where("suggestion.state", "==", "pending").count().get(),
        filedIn(ctx.db, ctx.caller, [typeof data.folderId === "string" ? data.folderId : null]),
      ]);
      const draft = data.draft as { updatedByEmail?: unknown; updatedAt?: admin.firestore.Timestamp } | undefined;
      const state = {
        version: current,
        title: data.title,
        filedIn: (typeof data.folderId === "string" && where.get(data.folderId)) || null,
        readers: new Set(asArray(data.members)).size,
        visibility: visibilityOf(data),
        expiresAt: expiryMs(data),
        trusted: data.trusted === true,
        openThreads: open.data().count,
        pendingSuggestions: pending.data().count,
        // As the app shows it: an unsaved draft is an editor's business.
        ...(editor
          ? {
              draft: draft
                ? { exists: true, lastEditedBy: draft.updatedByEmail ?? null, lastEditedAt: draft.updatedAt?.toDate?.().toISOString() ?? null }
                : { exists: false },
            }
          : {}),
        canEdit: canEdit(data, ctx.caller, proof) && !isFrozen(data, Date.now()),
        canSuggest: canSuggest(data, ctx.caller, proof) && !isFrozen(data, Date.now()),
        canDecide: isDocApprover(data, ctx.caller.uid, ctx.caller.emailLower) && !isFrozen(data, Date.now()),
      };

      if (ctx.caller.tokenId) await saveCursor(ctx.db, ctx.caller.uid, ctx.caller.tokenId, ref.id, cursor);
      return {
        id: ref.id,
        ...withReaderAddress({}, ref.id),
        cursor,
        more,
        // There is no rate limiter, by decision; this is how often to ask.
        retryAfter: RETRY_AFTER_SECONDS,
        ...(resumedFrom ? { resumedFrom } : {}),
        state,
        events,
        needsReply,
      };
    },
  },

  {
    name: "add_comment",
    description:
      "Start a new comment thread on a passage of a document's current version. " +
      "Quote the passage exactly as a reader sees it — no Markdown or HTML — within one paragraph. " +
      "If it occurs more than once, add a few words before it (prefix) or after it (suffix). " +
      "A thread belongs to the version it was opened on: once a new version is published, get_comments lists it only when asked for that version. " +
      "Once its point is dealt with, resolve_thread closes it. " +
      "`threadUrl` in the result opens the document on the new thread. " +
      "To answer a thread that already exists, use reply_to_comment.",
    inputSchema: {
      type: "object",
      required: ["id", "exact", "body"],
      properties: {
        version: { type: "string", description: "The version you read. Must still be current; historical versions are read-only." },
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
      refuseIfFrozen(data);
      mutationVersion(args.version, data);
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
      // The anchor was found on the observed head. Recheck that head and the
      // reader's authority atomically with both writes, so a racing publish
      // either sees this open thread or makes this attempt retry and refuse.
      const receipt = freshReceiptId();
      await ctx.db.runTransaction(async (tx) => {
        const current = await tx.get(ref);
        // Feedback rows remain author-deletable. Their later deletion cannot
        // erase this operation's acknowledgement or make its retry recreate them.
        if (readReceipt(current, receipt).found) return;
        const currentData = (current.data() ?? {}) as DocAclData & { currentVersion?: string };
        let proof = { k: str(args, "k"), grantToken: null as string | null };
        if (current.exists && !canRead(currentData, ctx.caller, proof)
          && visibilityOf(currentData) === "unlisted" && ctx.caller.uid) {
          proof = { ...proof, grantToken: grantTokenOf(await tx.get(linkGrantRef(ref, ctx.caller.uid))) };
        }
        if (!current.exists || !canRead(currentData, ctx.caller, proof)
          || (isFrozen(currentData, Date.now()) && !canManageSharing(currentData, ctx.caller.emailLower))) {
          throw new Error(`no document with id "${ref.id}"`);
        }
        refuseIfFrozen(currentData);
        if (currentData.currentVersion !== versionId) throw new Error("This document has a newer version. Reload, then comment on it.");
        recordReceipt(tx, ref, current, receipt, true);
        tx.create(annRef, {
          annId: annRef.id,
          anchor: { ...anchor, strict: true },
          ...author,
          color: ANNOTATION_COLOR,
          resolved: false,
        });
        tx.create(commentRef, { commentId: commentRef.id, body, ...author });
      // Concurrent comments write independent feedback but share this document's
      // receipt record. Keep native backoff and atomic retries, with room beyond
      // the default five attempts for a burst of reviewers (SPEC §17).
      }, { maxAttempts: 10 });
      await clearReceipt(ref, receipt);
      return withThreadAddress(
        withReaderAddress({ threadId: annRef.id, version: versionId, quote: anchor.exact }, ref.id),
        ref.id,
        versionId,
        annRef.id,
        str(args, "k") || undefined,
      );
    },
  },

  {
    name: "reply_to_comment",
    description: "Add a reply to an existing comment thread. To start a new one, use add_comment.",
    inputSchema: {
      type: "object",
      required: ["id", "threadId", "body"],
      properties: {
        version: { type: "string", description: "The version you read. Must still be current; historical versions are read-only." },
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
      const { ref, data, proof } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
      refuseIfFrozen(data);
      mutationVersion(args.version, data);
      const threadId = str(args, "threadId");
      const body = String(args.body ?? "").slice(0, 5000);
      if (!body.trim()) throw new Error("body is empty");

      const versionId = String(data.currentVersion ?? "");
      const annRef = ref
        .collection("versions")
        .doc(versionId)
        .collection("annotations")
        .doc(threadId);
      const commentRef = annRef.collection("comments").doc();
      await ctx.db.runTransaction(async (tx) => {
        const fresh = (await tx.get(ref)).data();
        if (!fresh || !canRead(fresh, ctx.caller, proof)) throw new Error("no such document");
        refuseIfFrozen(fresh);
        const refusal = currentVersionRefusal(fresh, versionId);
        if (refusal) throw new Error(refusal.error);
        if (!(await tx.get(annRef)).exists) throw new Error("no such thread");
        tx.create(commentRef, {
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
      });
      return withThreadAddress({ commentId: commentRef.id, threadId, documentId: ref.id }, ref.id, versionId, threadId, str(args, "k") || undefined);
    },
  },

  {
    name: "resolve_thread",
    description:
      "Close a comment thread on a document's current version once its point is dealt with: it is hidden " +
      "until someone asks for resolved threads. Say what you did in the thread first, with reply_to_comment. " +
      "A note saying you resolved it is added, and its author is told. A suggested edit is not resolved but decided.",
    inputSchema: {
      type: "object",
      required: ["id", "threadId"],
      properties: {
        version: { type: "string", description: "The version you read. Must still be current; historical versions are read-only." },
        id: { type: "string" },
        threadId: { type: "string", description: "From get_comments." },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      return changeThread(ctx, args, true);
    },
  },

  {
    name: "reopen_thread",
    description:
      "Open a resolved comment thread on a document's current version again, when its point turns out not to be dealt with. " +
      "A note saying you reopened it is added.",
    inputSchema: {
      type: "object",
      required: ["id", "threadId"],
      properties: {
        version: { type: "string", description: "The version you read. Must still be current; historical versions are read-only." },
        id: { type: "string" },
        threadId: { type: "string", description: "From get_comments with includeResolved." },
        k: {
          type: "string",
          description: LINK_KEY_DESCRIPTION,
        },
      },
    },
    async run(ctx, args) {
      return changeThread(ctx, args, false);
    },
  },
];
