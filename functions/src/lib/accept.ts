// SPDX-License-Identifier: Apache-2.0
// Accepting a suggestion through a token: the change made in the draft, then recorded (SPEC §22).

import * as admin from "firebase-admin";
import type { Actor } from "./actor";
import { applyToHtml, applyToMarkdown, type ApplyRefusal } from "./apply";
import { readWorkingCopy, writeDraft } from "./draft";
import { renderMarkdown } from "./markdown/render";
import { clearEditLog, editorsRefusal } from "./presence";
import { changeSuggestion, type Author, type Refusal } from "./suggestions";

/**
 * The app accepts in four steps: claim, so no other approver applies it too;
 * make the change in the draft; save the draft; record the decision. This is
 * the same four, with the change made in the source by `lib/apply.ts` rather
 * than typed into a page, so what is recorded as accepted is always already in
 * the draft (ADR 0015).
 *
 * The draft is shared with whoever has the editor open, and their live log
 * wins over the stored draft. So nothing is written while anybody is in the
 * editor; a log nobody is using is dropped with the write, which its contract
 * allows. A version is never minted here: the draft gathers a review, and
 * `commit_draft`, or a person in the app, publishes it.
 */

const IN_THE_APP = "Ask somebody who can approve to accept it in the app, where it is made against the page.";

const REFUSALS: Record<ApplyRefusal, string> = {
  stale:
    "This suggestion is stale: its passage is no longer in the document exactly as it was quoted, so it can only be rejected.",
  unplaced: `Its passage cannot be placed for certain without the page: the words around it have changed, or it repeats. ${IN_THE_APP}`,
  markup: `Its passage runs across formatting or markup, which only the editor can replace. ${IN_THE_APP}`,
  "not-verbatim": `In this Markdown document its passage is not written out plainly in the source. ${IN_THE_APP}`,
  unverified: `The change could not be made exactly as suggested. ${IN_THE_APP}`,
};

export async function acceptSuggestion(args: {
  db: admin.firestore.Firestore;
  docRef: admin.firestore.DocumentReference;
  data: Record<string, unknown>;
  annId: string;
  caller: Author;
  actor: Actor;
}): Promise<{ state: "accepted"; changed: boolean } | Refusal> {
  const { db, docRef, data, annId, caller, actor } = args;
  const versionId = String(data.currentVersion ?? "");
  const annSnap = await docRef.collection("versions").doc(versionId).collection("annotations").doc(annId).get();
  const ann = annSnap.data() as
    | { anchor?: { exact?: unknown; prefix?: unknown; suffix?: unknown }; suggestion?: { state?: unknown; replacement?: unknown } }
    | undefined;
  if (!annSnap.exists || !ann?.suggestion) return { status: 404, error: "no such suggestion" };
  const state = String(ann.suggestion.state ?? "pending");
  // A retry after a dropped response reports the outcome; anything else is settled.
  if (state === "accepted") return { state: "accepted", changed: false };
  if (state !== "pending") return { status: 409, error: `it has already been ${state}`, state };

  const anchor = {
    exact: String(ann.anchor?.exact ?? ""),
    prefix: String(ann.anchor?.prefix ?? ""),
    suffix: String(ann.anchor?.suffix ?? ""),
  };
  const replacement = String(ann.suggestion.replacement ?? "");

  const editors = await editorsRefusal(docRef.id, "accepted");
  if ("refusal" in editors) return editors.refusal;

  const working = await readWorkingCopy(docRef, data as Parameters<typeof readWorkingCopy>[1]);
  if (!working) return { status: 409, error: "Could not read the document to make the change in it." };
  const title = typeof data.title === "string" ? data.title : undefined;
  const made =
    working.format === "html"
      ? applyToHtml(working.html, anchor, replacement)
      : applyToMarkdown(working.markdown, anchor, replacement, (md) => renderMarkdown(md, { title }).html);
  if (made.state === "refused") return { status: 409, error: REFUSALS[made.reason], refused: made.reason };

  const change = (op: "claim" | "release" | "accept") =>
    changeSuggestion({
      db,
      docRef,
      versionId,
      annId,
      op,
      caller,
      actor,
      maySuggest: false,
      // What is being applied: refused if its author has changed it since it was read.
      replacement,
    });

  const claimed = await change("claim");
  if ("status" in claimed) return claimed;
  try {
    if (made.state === "applied") {
      if (editors.log) await clearEditLog(docRef.id);
      await writeDraft({
        docRef,
        baseVersion: working.baseVersion,
        version: working.version,
        content: made.markdown !== undefined ? { markdown: made.markdown, html: made.html } : { html: made.html },
        existingSessions: (data.draft as { editSessions?: unknown } | undefined)?.editSessions,
        emailLower: caller.emailLower,
        actor,
      });
    }
  } catch (e) {
    await change("release").catch(() => undefined);
    throw e;
  }
  const recorded = await change("accept");
  if ("status" in recorded) return recorded;
  return { state: "accepted", changed: made.state === "applied" };
}
