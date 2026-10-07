// SPDX-License-Identifier: Apache-2.0
// Who gets told what, and how often (SPEC §14).

import * as admin from "firebase-admin";
import * as React from "react";
import { COMMENT_EMAIL_COOLDOWN_MS, publicOrigin } from "../config";
import type { Role } from "../lib/access";
import { documentUrl, sendEmail } from "./send";
import { Invite, inviteText, type InviteProps } from "./templates/Invite";
import { Verify, verifyText } from "./templates/Verify";
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
 */
export async function claimCommentCooldown(
  db: Db,
  uid: string,
  docId: string,
  now = Date.now(),
): Promise<boolean> {
  const ref = db.collection("users").doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data() || {};
    if (data.emailNotifications === false) return false;

    const cooldowns = (data.emailCooldowns as Record<string, number>) || {};
    const last = Number(cooldowns[docId] ?? 0);
    if (now - last < COMMENT_EMAIL_COOLDOWN_MS) return false;

    const pruned: Record<string, number> = { [docId]: now };
    for (const [key, at] of Object.entries(cooldowns)) {
      if (key !== docId && now - Number(at) < COMMENT_EMAIL_COOLDOWN_MS) {
        pruned[key] = Number(at);
      }
    }
    tx.set(ref, { emailCooldowns: pruned }, { merge: true });
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
    viaChannel: props.viaChannel,
  };
  await sendEmail({
    to,
    subject: `${props.authorEmail} commented on “${props.docTitle}”`,
    body: React.createElement(CommentNotice, full),
    text: commentNoticeText(full),
  });
}
