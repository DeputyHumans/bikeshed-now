// SPDX-License-Identifier: Apache-2.0
// Who gets told what, and how often (SPEC §14).

import * as admin from "firebase-admin";
import { randomUUID } from "node:crypto";
import * as React from "react";
import { COMMENT_EMAIL_COOLDOWN_MS, publicOrigin } from "../config";
import type { Role } from "../lib/access";
import { canRead, canManageSharing, isFrozen, isMember, visibilityOf } from "../lib/acl";
import { grantTokenOf, linkGrantRef } from "../lib/linkgrant";
import { documentUrl, sendEmail } from "./send";
import { Invite, inviteText, type InviteProps } from "./templates/Invite";
import { Verify, verifyText } from "./templates/Verify";
import { PurgeCode, purgeCodeText } from "./templates/PurgeCode";
import {
  CommentNotice,
  commentNoticeText,
  type CommentNoticeProps,
} from "./templates/CommentNotice";

type Db = admin.firestore.Firestore;

/**
 * Per-recipient, per-document cooldown.
 *
 * Stored on the user record rather than in a queue or a scheduler, because the
 * only thing that needs remembering is "when did we last tell this person about
 * this document", and that is one map field. Bounding the comment email by
 * construction is what keeps it from becoming a notification subsystem.
 *
 * The map is pruned opportunistically: entries older than the window carry no
 * information, and a user who reviews a thousand documents should not accumulate
 * a thousand keys.
 *
 * Comments and suggestions are limited APART. A waiting suggestion holds back
 * the next version until somebody decides it, so a comment email a minute
 * earlier must not delay the notice of one (SPEC §22); and suggestions are
 * still limited among themselves, because an agent may leave twenty at once.
 */
export type NoticeKind = "comment" | "suggestion";

/** A docId is lowercase letters, digits and hyphens, so `:` cannot collide. */
const cooldownKey = (docId: string, kind: NoticeKind) =>
  kind === "suggestion" ? `${docId}:suggestions` : docId;

export async function claimCommentCooldown(
  db: Db,
  uid: string,
  docId: string,
  kind: NoticeKind = "comment",
  now = Date.now(),
): Promise<boolean> {
  const ref = db.collection("users").doc(uid);
  const own = cooldownKey(docId, kind);
  const claimId = randomUUID();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data() || {};
    if (data.emailNotifications === false) return false;

    // A comment contains document bytes and reviewer identities. Check the
    // current read boundary with the cooldown, not the trigger's earlier
    // recipient snapshot: revocation or link rotation must also stop email.
    const emailLower = typeof data.email === "string" ? data.email.toLowerCase() : "";
    if (!emailLower) return false;
    const docRef = db.collection("docs").doc(docId);
    const docSnap = await tx.get(docRef);
    if (!docSnap.exists) return false;
    const doc = docSnap.data() || {};
    const caller = { uid, emailLower };
    const grant = visibilityOf(doc) === "unlisted" && !isMember(doc, uid, emailLower)
      ? await tx.get(linkGrantRef(docRef, uid))
      : null;
    if (!canRead(doc, caller, { grantToken: grantTokenOf(grant) })) return false;
    if (isFrozen(doc, Date.now()) && !canManageSharing(doc, emailLower)) return false;

    const cooldowns = (data.emailCooldowns as Record<string, number>) || {};
    const claims = (data.emailCooldownClaims as Record<string, string>) || {};
    // A numeric timestamp alone is not a receipt: two different trigger calls
    // may start in the same millisecond. Keep each winning claim unique while
    // retaining the existing numeric cooldown format and current read checks.
    if (claims[own] === claimId && cooldowns[own] === now) return true;
    const last = Number(cooldowns[own] ?? 0);
    if (now - last < COMMENT_EMAIL_COOLDOWN_MS) return false;

    const pruned: Record<string, number> = { [own]: now };
    const retainedClaims: Record<string, string> = { [own]: claimId };
    for (const [key, at] of Object.entries(cooldowns)) {
      if (key !== own && now - Number(at) < COMMENT_EMAIL_COOLDOWN_MS) {
        pruned[key] = Number(at);
        if (typeof claims[key] === "string") retainedClaims[key] = claims[key];
      }
    }
    // `update`, not a merging `set`: a merge combines maps key by key, so the
    // expired keys this just dropped would survive the write, and the map would
    // only ever grow. The record exists; `snap.exists` was checked above.
    tx.update(ref, { emailCooldowns: pruned, emailCooldownClaims: retainedClaims });
    return true;
  });
}

/** Look up the account for an email address, if one exists yet. */
export async function uidForEmail(
  db: Db,
  emailLower: string,
): Promise<string | null> {
  const snap = await db
    .collection("users")
    .where("email", "==", emailLower)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

export interface InviteTarget {
  email: string;
  role: Role;
}

/**
 * Tell newly granted people they have access.
 *
 * Only NEW grants, never a re-grant: `setAccess` is idempotent and a UI that
 * re-saves the same list must not re-send. The caller computes the difference,
 * which is the only place that knows what "new" means.
 */
export async function sendInvitations(
  inviterEmail: string,
  targets: readonly InviteTarget[],
  subject: { title: string; kind: "document" | "folder" | "team"; url: string },
): Promise<void> {
  const origin = publicOrigin();
  for (const target of targets) {
    const props: InviteProps = {
      origin,
      inviterEmail,
      subjectTitle: subject.title,
      kind: subject.kind,
      role: target.role,
      url: subject.url,
    };
    await sendEmail({
      to: target.email,
      subject: `${inviterEmail} shared “${subject.title}” with you`,
      body: React.createElement(Invite, props),
      text: inviteText(props),
    });
  }
}

export async function sendVerificationCode(
  email: string,
  code: string,
  minutes: number,
): Promise<void> {
  const origin = publicOrigin();
  await sendEmail({
    to: email,
    subject: `${code} is your Bikeshed verification code`,
    body: React.createElement(Verify, { origin, code, minutes }),
    text: verifyText({ origin, code, minutes }),
  });
}

/** The code that confirms deleting `what` forever, to the account's own address. */
export async function sendPurgeCode(
  email: string,
  code: string,
  minutes: number,
  what: string,
): Promise<boolean> {
  const origin = publicOrigin();
  const result = await sendEmail({
    to: email,
    subject: `${code} is your code to delete from your Trash`,
    body: React.createElement(PurgeCode, { origin, code, minutes, what }),
    text: purgeCodeText({ origin, code, minutes, what }),
  });
  return result.sent;
}

export async function sendCommentNotice(
  to: string,
  props: Omit<CommentNoticeProps, "origin" | "url"> & {
    docId: string;
    versionId: string;
  },
): Promise<void> {
  const origin = publicOrigin();
  const full: CommentNoticeProps = {
    origin,
    url: documentUrl(props.docId, props.versionId),
    authorEmail: props.authorEmail,
    docTitle: props.docTitle,
    quote: props.quote,
    body: props.body,
    via: props.via,
    suggestion: props.suggestion,
  };
  await sendEmail({
    to,
    subject: props.suggestion
      ? `${props.authorEmail} suggested an edit to “${props.docTitle}”`
      : `${props.authorEmail} commented on “${props.docTitle}”`,
    body: React.createElement(CommentNotice, full),
    text: commentNoticeText(full),
  });
}
