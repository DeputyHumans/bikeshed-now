// SPDX-License-Identifier: Apache-2.0
// Suggested edits: what one is, and every change to its state (SPEC §22).

import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Actor } from "./actor";

/**
 * A suggestion is an ANNOTATION with one more field, so it inherits anchoring,
 * the thread under it, orphan detection, the comment email and the publish
 * gate rather than reinventing each. What makes it a suggestion is
 * `suggestion: { replacement, state, … }`, and nothing but this module ever
 * writes that field: the rules refuse any client write that names it, so a
 * reader cannot forge one, clear one, or decide one (SPEC §22).
 *
 * It is a TEXT replacement inside one block. Accepting it is an edit an
 * approver makes in their own editing session; the server never applies one,
 * because it has no DOM to apply it with (ADR 0013).
 */

type Db = admin.firestore.Firestore;
type DocRef = admin.firestore.DocumentReference;

export const SUGGESTION_LIMITS = {
  /** The quoted text, as a reader sees it. */
  exact: 5000,
  replacement: 5000,
  note: 5000,
  /** Prefix and suffix context, and the anchoring element's id. */
  context: 256,
  /** Pending suggestions one author may have open on one version (R7). */
  pendingPerAuthor: 20,
  /**
   * Times one suggestion may be changed. Each keeps what it replaced, so this
   * bounds the record: twenty at the text limits is about 200 KB, well inside
   * a Firestore document.
   */
  revisions: 20,
  /** How long an approver's claim keeps others off while they apply it. */
  claimMs: 2 * 60 * 1000,
} as const;

/** The annotation colour, as `TOKENS.annotation` in app/src/brand/tokens.ts. */
export const ANNOTATION_COLOR = "#b5257b";

/** A suggestion is drawn in the colour every other thread is. */
export const SUGGESTION_COLOR = ANNOTATION_COLOR;

export type SuggestionState = "pending" | "accepted" | "rejected" | "withdrawn";

/**
 * One change its author made to a pending suggestion: the replacement it
 * superseded, the note it superseded if it replaced one the author wrote, and
 * when and through which channel. Oldest first, so the replacement at index i
 * stood from the previous entry's `at` (or the annotation's `createdAt`) until
 * its own.
 */
export interface SuggestionRevision {
  replacement: string;
  note?: string;
  at: Timestamp;
  actor: Actor;
}

export interface SuggestionAnchor {
  elementId: string;
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

/**
 * A replacement may not carry structure. A line break would become a `<br>`
 * or a new paragraph when typed into the document, so "text inside one block"
 * would quietly stop being true; other control characters and bidirectional
 * overrides change what a reader sees without changing what they read.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/;

/** Why `text` may not be a replacement, or null when it may. */
export function replacementProblem(text: string, exact: string): string | null {
  if (text.length > SUGGESTION_LIMITS.replacement) {
    return `a replacement may be at most ${SUGGESTION_LIMITS.replacement} characters`;
  }
  if (FORBIDDEN.test(text)) {
    return "a replacement is text on one line: no line breaks, tabs or invisible direction marks";
  }
  if (text === exact) return "the replacement is the same as the text it replaces";
  return null;
}

/** The anchor from a request, or what is wrong with it. */
export function parseAnchor(raw: unknown): SuggestionAnchor | { error: string } {
  if (raw == null || typeof raw !== "object") return { error: "anchor must be an object" };
  const a = raw as Record<string, unknown>;
  const str = (k: string, max: number, required = false): string | { error: string } => {
    const v = a[k] ?? "";
    if (typeof v !== "string") return { error: `anchor.${k} must be a string` };
    if (required && v.length === 0) return { error: `anchor.${k} is empty` };
    if (v.length > max) return { error: `anchor.${k} may be at most ${max} characters` };
    return v;
  };
  const exact = str("exact", SUGGESTION_LIMITS.exact, true);
  // Nothing a browser could find, or a reader see, so nothing anyone could apply.
  if (typeof exact === "string" && exact.trim() === "") return { error: "anchor.exact is only whitespace" };
  const prefix = str("prefix", SUGGESTION_LIMITS.context);
  const suffix = str("suffix", SUGGESTION_LIMITS.context);
  const elementId = str("elementId", SUGGESTION_LIMITS.context);
  for (const v of [exact, prefix, suffix, elementId]) if (typeof v !== "string") return v;
  const int = (k: string) => (Number.isInteger(a[k]) && (a[k] as number) >= 0 ? (a[k] as number) : -1);
  const start = int("start");
  const end = int("end");
  if (start < 0 || end < start) return { error: "anchor.start and anchor.end must be offsets, start first" };
  return {
    elementId: elementId as string,
    exact: exact as string,
    prefix: prefix as string,
    suffix: suffix as string,
    start,
    end,
  };
}

/** The note, trimmed, or what is wrong with it. Absent is fine. */
export function parseNote(raw: unknown): string | { error: string } {
  if (raw == null) return "";
  if (typeof raw !== "string") return { error: "note must be a string" };
  const note = raw.trim();
  if (note.length > SUGGESTION_LIMITS.note) {
    return { error: `a note may be at most ${SUGGESTION_LIMITS.note} characters` };
  }
  return note;
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The opening comment's body when the author gave no note. It is shown where
 * the suggestion itself is not — an older client, an agent reading the thread —
 * so it says the whole change in words.
 */
export function describeChange(exact: string, replacement: string): string {
  return replacement === ""
    ? `Suggested deleting “${clip(exact)}”.`
    : `Suggested replacing “${clip(exact)}” with “${clip(replacement)}”.`;
}

export interface Author {
  uid: string;
  emailLower: string;
}

/** Who the server stamps on a comment it writes for someone. */
function commentFields(author: Author, actor: Actor) {
  return {
    authorUid: author.uid,
    authorEmail: author.emailLower,
    actor,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function annotations(docRef: DocRef, versionId: string) {
  return docRef.collection("versions").doc(versionId).collection("annotations");
}

export type Refusal = { status: 400 | 403 | 404 | 409; error: string; [k: string]: unknown };

/**
 * Write a new suggestion and its opening comment in one transaction.
 *
 * The caller has decided the author may suggest on this version. The opening
 * comment is what tells the owner and the approvers: the comment trigger sees
 * `opensSuggestion` and addresses it to them (SPEC §14).
 */
export async function createSuggestion(args: {
  db: Db;
  docRef: DocRef;
  versionId: string;
  anchor: SuggestionAnchor;
  replacement: string;
  note: string;
  author: Author;
  actor: Actor;
  color: string;
}): Promise<{ annId: string } | Refusal> {
  const { db, docRef, versionId, anchor, replacement, note, author, actor } = args;
  const problem = replacementProblem(replacement, anchor.exact);
  if (problem) return { status: 400, error: problem };

  const anns = annotations(docRef, versionId);
  const open = await anns
    .where("authorUid", "==", author.uid)
    .where("suggestion.state", "==", "pending")
    .count()
    .get();
  if (open.data().count >= SUGGESTION_LIMITS.pendingPerAuthor) {
    return {
      status: 409,
      error:
        `You already have ${SUGGESTION_LIMITS.pendingPerAuthor} suggestions waiting on this version. ` +
        "Wait for some to be decided, or withdraw one.",
    };
  }

  const annRef = anns.doc();
  const commentRef = annRef.collection("comments").doc();
  // In a transaction that reads the document, so this and a publish are
  // ordered: either the publish's own check sees this suggestion and refuses,
  // or this sees the newer version and refuses. Checked only before writing,
  // a publish landing in between left it pending on a version nobody reads.
  return db.runTransaction(async (tx): Promise<{ annId: string } | Refusal> => {
    const doc = await tx.get(docRef);
    const current = String(doc.data()?.currentVersion ?? "");
    if (current !== versionId) {
      return {
        status: 409,
        error: "This document has a newer version. Reload, then suggest the edit on it.",
        currentVersion: current,
      };
    }
    tx.create(annRef, {
      annId: annRef.id,
      anchor,
      ...commentFields(author, actor),
      color: args.color,
      resolved: false,
      suggestion: { replacement, state: "pending" as SuggestionState },
    });
    tx.create(commentRef, {
      commentId: commentRef.id,
      body: note || describeChange(anchor.exact, replacement),
      ...commentFields(author, actor),
      opensSuggestion: true,
      ...(note ? {} : { generated: true }),
    });
    return { annId: annRef.id };
  });
}

interface StoredSuggestion {
  authorUid?: string;
  anchor?: { exact?: string };
  suggestion?: {
    replacement?: string;
    state?: SuggestionState;
    claim?: { uid?: string; email?: string; until?: Timestamp };
    revisions?: SuggestionRevision[];
  };
}

/** A refusal when the approver is applying a replacement the author has since changed. */
function changedSince(s: StoredSuggestion, applying: string | undefined): Refusal | null {
  const now = String(s.suggestion?.replacement ?? "");
  if (applying === undefined || applying === now) return null;
  return {
    status: 409,
    error: "Its author has changed it since you opened it. Look at it again before you decide.",
    changed: true,
    replacement: now,
  };
}

/** The live claim on a suggestion, unless it is the caller's own or has lapsed. */
function claimedByOther(s: StoredSuggestion, uid: string, nowMs: number): string | null {
  const claim = s.suggestion?.claim;
  if (!claim || claim.uid === uid) return null;
  const until = claim.until?.toMillis?.() ?? 0;
  return until > nowMs ? String(claim.email ?? "someone else") : null;
}

export const DECISION_OPS = ["revise", "withdraw", "claim", "release", "accept", "reject"] as const;

export type DecisionOp = (typeof DECISION_OPS)[number];

export function isDecisionOp(v: unknown): v is DecisionOp {
  return typeof v === "string" && (DECISION_OPS as readonly string[]).includes(v);
}

/**
 * Change a suggestion's state, inside a transaction, for a caller the endpoint
 * has already authorized for `op`.
 *
 *   revise    author, pending, unclaimed      → new replacement and note; the old kept
 *   withdraw  author, pending, unclaimed      → withdrawn
 *   claim     approver, pending               → others are kept off for a while
 *   release   approver, their own claim       → the others let back on at once
 *   accept    approver, pending, not claimed by someone else → accepted
 *   reject    approver, pending, not claimed by someone else → rejected
 *
 * `replacement` is the new text for a revise. For a claim or an accept it is
 * what the approver is applying, when they say: either is refused if the
 * author has changed it since, so the text put into the draft and the text
 * recorded as accepted cannot differ.
 *
 * Withdraw, accept and reject each close the thread for good and are
 * idempotent for their own outcome, so a retry after a dropped response
 * reports success rather than a confusing conflict. Each writes a short note
 * into the thread, which is how the others hear. A withdrawn suggestion is
 * kept, thread and all, rather than deleted: what somebody proposed and took
 * back is part of the document's record (SPEC §22).
 */
export async function changeSuggestion(args: {
  db: Db;
  docRef: DocRef;
  versionId: string;
  annId: string;
  op: DecisionOp;
  caller: Author;
  actor: Actor;
  replacement?: string;
  note?: string;
  reason?: string;
  nowMs?: number;
}): Promise<{ state: SuggestionState } | Refusal> {
  const { db, docRef, versionId, annId, op, caller, actor } = args;
  const nowMs = args.nowMs ?? Date.now();
  const annRef = annotations(docRef, versionId).doc(annId);

  return db.runTransaction(async (tx) => {
    // Every read before any write, as a transaction requires: the record, and
    // for a revision the opening comment whose words may have to follow it.
    const snap = await tx.get(annRef);
    const opener =
      op === "revise"
        ? await tx.get(annRef.collection("comments").where("opensSuggestion", "==", true).limit(1))
        : null;
    const s = snap.data() as StoredSuggestion | undefined;
    if (!snap.exists || !s?.suggestion) return { status: 404, error: "no such suggestion" };
    const state = s.suggestion.state ?? "pending";

    // Idempotent outcomes first, so a retried decision is not a conflict.
    if (
      (op === "accept" && state === "accepted") ||
      (op === "reject" && state === "rejected") ||
      (op === "withdraw" && state === "withdrawn") ||
      // Nothing to let go of once it is decided: a release is never a conflict.
      (op === "release" && state !== "pending")
    ) {
      return { state };
    }
    if (state !== "pending") return { status: 409, error: `it has already been ${state}`, state };

    const other = claimedByOther(s, caller.uid, nowMs);
    if (other) return { status: 409, error: `${other} is applying it right now`, claimedBy: other };

    switch (op) {
      case "revise": {
        if (s.authorUid !== caller.uid) {
          return { status: 403, error: "only the person who suggested it can change it" };
        }
        const replacement = args.replacement ?? "";
        const problem = replacementProblem(replacement, String(s.anchor?.exact ?? ""));
        if (problem) return { status: 400, error: problem };
        const revisions = s.suggestion.revisions ?? [];
        if (revisions.length >= SUGGESTION_LIMITS.revisions) {
          return {
            status: 409,
            error: `This suggestion has been changed ${SUGGESTION_LIMITS.revisions} times. Withdraw it and suggest it again.`,
          };
        }
        const first = opener?.docs[0];
        const note = args.note ?? "";
        // What this change replaces is kept, never overwritten: the text, and
        // the author's own note when a new one replaces it. A generated opener
        // only restated the old text, which the entry already holds.
        const replacedNote = note && first && first.data().generated !== true ? String(first.data().body ?? "") : "";
        const revision: SuggestionRevision = {
          replacement: String(s.suggestion.replacement ?? ""),
          ...(replacedNote ? { note: replacedNote } : {}),
          // A server timestamp may not sit inside an array.
          at: Timestamp.fromMillis(nowMs),
          actor,
        };
        tx.update(annRef, {
          "suggestion.replacement": replacement,
          "suggestion.revisions": [...revisions, revision],
        });
        // The opening comment says the change in words when there was no note,
        // so it has to say the new one; a note the author wrote is theirs, and
        // is replaced only when they send a new one.
        if (first) {
          if (note) tx.update(first.ref, { body: note, generated: FieldValue.delete() });
          else if (first.data().generated === true) {
            tx.update(first.ref, { body: describeChange(String(s.anchor?.exact ?? ""), replacement) });
          }
        }
        return { state: "pending" };
      }
      case "withdraw": {
        if (s.authorUid !== caller.uid) {
          return { status: 403, error: "only the person who suggested it can withdraw it" };
        }
        // Closed as a decision is, so it stops holding back a new version
        // (SPEC §6a); the thread stays, and says what happened.
        tx.update(annRef, {
          "suggestion.state": "withdrawn",
          "suggestion.decidedBy": actor,
          "suggestion.decidedAt": FieldValue.serverTimestamp(),
          "suggestion.claim": FieldValue.delete(),
          resolved: true,
        });
        const noteRef = annRef.collection("comments").doc();
        tx.create(noteRef, {
          commentId: noteRef.id,
          body: "Withdrawn.",
          ...commentFields(caller, actor),
          generated: true,
        });
        return { state: "withdrawn" as SuggestionState };
      }
      case "claim": {
        const changed = changedSince(s, args.replacement);
        if (changed) return changed;
        tx.update(annRef, {
          "suggestion.claim": {
            uid: caller.uid,
            email: caller.emailLower,
            until: Timestamp.fromMillis(nowMs + SUGGESTION_LIMITS.claimMs),
          },
        });
        return { state: "pending" };
      }
      case "release": {
        // `claimedByOther` above has refused anybody else's live claim.
        if (s.suggestion.claim) tx.update(annRef, { "suggestion.claim": FieldValue.delete() });
        return { state: "pending" };
      }
      case "accept":
      case "reject": {
        if (op === "accept") {
          const changed = changedSince(s, args.replacement);
          if (changed) return changed;
        }
        const next: SuggestionState = op === "accept" ? "accepted" : "rejected";
        tx.update(annRef, {
          "suggestion.state": next,
          "suggestion.decidedBy": actor,
          "suggestion.decidedAt": FieldValue.serverTimestamp(),
          "suggestion.claim": FieldValue.delete(),
          resolved: true,
        });
        const reason = (args.reason ?? "").trim().slice(0, SUGGESTION_LIMITS.note);
        const noteRef = annRef.collection("comments").doc();
        tx.create(noteRef, {
          commentId: noteRef.id,
          body: op === "accept" ? "Accepted." : reason ? `Rejected: ${reason}` : "Rejected.",
          ...commentFields(caller, actor),
          generated: true,
        });
        return { state: next };
      }
      default:
        return { status: 400, error: "unknown op" };
    }
  });
}
