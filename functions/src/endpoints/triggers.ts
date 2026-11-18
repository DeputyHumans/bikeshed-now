// SPDX-License-Identifier: Apache-2.0
// The functions nobody calls: Firestore triggers and the two schedules (SPEC §2, §4, §14, §19).

import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { REGION, RESEND_API_KEY } from "../config";
import { runMove, type MoveJob } from "../lib/accountmove";
import { purgeExpired } from "../lib/purge";
import { expireDue } from "../lib/expire";
import { normalizeEmail } from "../lib/access";
import { actedThrough, type Actor } from "../lib/actor";
import { refreshLatest } from "../lib/latest";
import { membershipOf } from "../lib/folders";
import { syncPublicProjection } from "../lib/publicdoc";
import { annotationEvents, commentEvents, recordTriggered, versionEvents } from "../lib/events";
import { db } from "./runtime";

// ---------------------------------------------------------------------------
// Comment notifications — the only non-HTTP function in the codebase
// ---------------------------------------------------------------------------

/**
 * Tell the people in a thread that somebody replied.
 *
 * Bounded BY CONSTRUCTION rather than by infrastructure: one trigger, a
 * recipient set of owner plus prior participants minus the author, and a
 * per-(recipient, document) cooldown stored on the user record. No queue, no
 * scheduler, no cron — because the moment this needs any of those, it has become
 * a notification system, and this product does not have one.
 */
export const onCommentCreated = onDocumentCreated(
  {
    document:
      "docs/{docId}/versions/{versionId}/annotations/{annId}/comments/{commentId}",
    region: REGION,
    secrets: [RESEND_API_KEY],
  },
  async (event) => {
    const comment = event.data?.data();
    if (!comment) return;
    const { docId, versionId, annId } = event.params;

    const authorEmail = normalizeEmail(String(comment.authorEmail || ""));
    const actor = comment.actor as Actor | undefined;

    const docRef = db().collection("docs").doc(docId);
    const [docSnap, annSnap, siblingSnap] = await Promise.all([
      docRef.get(),
      docRef
        .collection("versions")
        .doc(versionId)
        .collection("annotations")
        .doc(annId)
        .get(),
      docRef
        .collection("versions")
        .doc(versionId)
        .collection("annotations")
        .doc(annId)
        .collection("comments")
        .get(),
    ]);
    if (!docSnap.exists) return;
    const doc = docSnap.data() || {};

    const recipients = new Set<string>();
    const owner = normalizeEmail(String(doc.ownerEmail || ""));
    if (owner) recipients.add(owner);
    // A new suggestion is for the people who can decide it: only they can
    // clear it, and until they do it holds back the next version (SPEC §22).
    const suggestion = comment.opensSuggestion === true ? annSnap.data()?.suggestion : null;
    const deciders = suggestion ? membershipOf(doc).approverMembers : [];
    for (const e of deciders) recipients.add(normalizeEmail(e));
    // People are found by account where a comment names one, and by address
    // only where it does not: an address somebody has since moved from (SPEC
    // §14) finds nobody, so they would stop hearing about the thread, and the
    // author's own stale address would not exclude them from their own notice.
    const uidOf = (c: Record<string, unknown>): string | null => {
      const uid = c.authorUid ?? (c.actor as { uid?: unknown } | undefined)?.uid;
      return typeof uid === "string" && uid ? uid : null;
    };
    const authorUid = uidOf(comment);
    const uids = new Set<string>(authorUid ? [authorUid] : []);
    for (const c of siblingSnap.docs) {
      const d = c.data() ?? {};
      const uid = uidOf(d);
      if (uid) {
        uids.add(uid);
        continue;
      }
      const e = normalizeEmail(String(d.authorEmail || ""));
      if (e) recipients.add(e);
    }
    const accounts = uids.size
      ? await db().getAll(...[...uids].map((uid) => db().collection("users").doc(uid)))
      : [];
    let authorNow = "";
    for (const account of accounts) {
      const e = normalizeEmail(String(account.data()?.email || ""));
      if (!e) continue;
      if (account.id === authorUid) authorNow = e;
      else recipients.add(e);
    }
    recipients.delete(authorEmail);
    if (authorNow) recipients.delete(authorNow);
    if (recipients.size === 0) return;

    const quote = String(annSnap.data()?.anchor?.exact ?? "").slice(0, 300);
    // A generated opener restates the change, which the notice shows as the
    // change itself; only a note the author wrote is worth repeating.
    const body =
      suggestion && comment.generated === true ? "" : String(comment.body ?? "").slice(0, 2000);
    const title = typeof doc.title === "string" ? doc.title : docId;
    // What it came through, in the words stored with it (lib/actor.ts).
    const via = actedThrough(actor).via;

    const { claimCommentCooldown, sendCommentNotice, uidForEmail } = await import("../email/notify");
    for (const email of recipients) {
      const uid = await uidForEmail(db(), email);
      // No account yet means no cooldown record and no preference to honour.
      // Staying silent is the right default: they were never told about the
      // document either.
      if (!uid) continue;
      if (!(await claimCommentCooldown(db(), uid, docId, suggestion ? "suggestion" : "comment"))) continue;
      await sendCommentNotice(email, {
        authorEmail,
        docTitle: title,
        quote,
        body,
        via,
        docId,
        versionId,
        // "Reply in context" opens the document on this thread (SPEC §14).
        threadId: annId,
        ...(suggestion
          ? { suggestion: { replacement: String(suggestion.replacement ?? "").slice(0, 300) } }
          : {}),
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Moving an account (SPEC §14, ADR 0020)
// ---------------------------------------------------------------------------

/**
 * Finish moving an account to the address Google renamed it to.
 *
 * Fires when a job becomes `pending`, and on nothing else: its own `done` or
 * `blocked` is a write to the same record. `retry: true` because a move left
 * half done is the one outcome worse than not starting, and `runMove` resumes
 * from wherever a failed attempt stopped. The long timeout is the point of
 * being a trigger: the work is a recompute of everything the person can see.
 */
export const moveAccount = onDocumentWritten(
  { document: "accountMoves/{jobId}", region: REGION, retry: true, timeoutSeconds: 540, memory: "512MiB" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data() as MoveJob | undefined;
    if (!after || after.state !== "pending" || before?.state === "pending") return;
    await runMove(db(), event.params.jobId, after);
  },
);

// ---------------------------------------------------------------------------
// The Trash's daily job (SPEC §4, ADR 0025)
// ---------------------------------------------------------------------------

/**
 * Once a day, delete forever whatever has been in the Trash for 30 days, and
 * finish any purge a run left part way. One of two scheduled jobs here, with
 * the hourly expiry below: every notice is still decided when something is
 * read or written, and this exists only because nothing reads a Trash nobody
 * opens. A run stops short of its timeout and says `more`, and the next
 * carries on.
 *
 * Its counts go to its own log as `trash_purge`, the event
 * docs/operations/monitoring.md names. Private: Cloud Scheduler calls it
 * with its own identity, and setup grants no one else the invoker role.
 */
export const purgeExpiredTrash = onSchedule(
  { schedule: "every day 03:17", timeZone: "Etc/UTC", region: REGION, timeoutSeconds: 540, retryCount: 0 },
  async () => {
    const started = Date.now();
    const report = await purgeExpired(db(), started);
    logger.info("trash_purge", { event: "trash_purge", ...report, ms: Date.now() - started });
  },
);

// ---------------------------------------------------------------------------
// The hourly expiry (SPEC §17, ADR 0029)
// ---------------------------------------------------------------------------

/**
 * Once an hour, make private every document and folder whose date has passed,
 * and clear the date (lib/expire.ts). Until it runs, a passed date freezes as
 * it always has, owner-only, so the hour can delay access but never widen it.
 * No minimum instances: an idle hour costs nothing.
 *
 * Its counts go to its own log as `expiry_applied`, the event
 * docs/operations/monitoring.md names. Private, as the Trash's job is: Cloud
 * Scheduler calls it with its own identity.
 */
export const applyExpiries = onSchedule(
  { schedule: "every 60 minutes", timeZone: "Etc/UTC", region: REGION, timeoutSeconds: 540, retryCount: 0 },
  async () => {
    const started = Date.now();
    const report = await expireDue(db(), started);
    logger.info("expiry_applied", { event: "expiry_applied", ...report, ms: Date.now() - started });
  },
);

// ---------------------------------------------------------------------------
// The change log (SPEC §4, §19, ADR 0016)
// ---------------------------------------------------------------------------

/**
 * Three triggers record the changes that many paths make: a version (every
 * publisher, the in-app commit, the operator's withdrawal), a thread (the
 * browser directly, and the server), and a comment. A trigger on the
 * collection catches every writer, including ones added later.
 *
 * `retry: true`, which `onCommentCreated` does not have: a thrown error there
 * loses an email, which it would rather do than send one twice, but a lost
 * event here is the one failure the log cannot report. Retrying is safe
 * because recording is idempotent: each event is created under the
 * CloudEvent's id, so a redelivery finds it and writes nothing.
 */
export const recordVersionEvent = onDocumentWritten(
  { document: "docs/{docId}/versions/{versionId}", region: REGION, retry: true },
  async (event) => {
    const { docId, versionId } = event.params;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    // The count refreshLatest writes back onto the version moves nothing more.
    if (before && after && typeof before.words !== "number" && typeof after.words === "number") return;
    await recordTriggered(db(), docId, event.id, versionEvents(versionId, before, after));
    // The same write moves what the document says about its current version:
    // the card's "Updated", by whom and through what, and its reading time.
    const moved = await refreshLatest(db(), docId, versionId, after);
    // And what its public mirror says of when and how long. A document neither
    // public nor in a folder, whose reach might be public, has no mirror.
    if (moved && (moved.visibility === "public" || (typeof moved.folderId === "string" && moved.folderId))) {
      await syncPublicProjection(db(), docId);
    }
  },
);

export const recordThreadEvent = onDocumentWritten(
  { document: "docs/{docId}/versions/{versionId}/annotations/{annId}", region: REGION, retry: true },
  async (event) => {
    const { docId, versionId, annId } = event.params;
    await recordTriggered(
      db(),
      docId,
      event.id,
      annotationEvents(versionId, annId, event.data?.before?.data(), event.data?.after?.data()),
    );
  },
);

export const recordCommentEvent = onDocumentCreated(
  {
    document: "docs/{docId}/versions/{versionId}/annotations/{annId}/comments/{commentId}",
    region: REGION,
    retry: true,
  },
  async (event) => {
    const { docId, versionId, annId, commentId } = event.params;
    await recordTriggered(db(), docId, event.id, commentEvents(versionId, annId, commentId, event.data?.data()));
  },
);
