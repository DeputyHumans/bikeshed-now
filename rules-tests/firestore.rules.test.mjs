// SPDX-License-Identifier: Apache-2.0
// The Firestore rules are the real boundary; this is what proves it (SPEC §1, §5, §17).

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  deleteDoc,
} from "firebase/firestore";

import {
  renderFirestoreRules,
} from "../config/policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Emulator ports come from firebase.json, the one place they are configured.
 *
 * They are not the Firebase defaults: 8080 and 5000 are both commonly occupied
 * on a developer machine (5000 by macOS AirPlay), and an emulator that refuses
 * to start is a worse first impression than a port number nobody recognizes.
 */
const EMULATORS = JSON.parse(
  readFileSync(join(ROOT, "firebase.json"), "utf8"),
).emulators;

const TEMPLATE = readFileSync(
  join(ROOT, "config", "templates", "firestore.rules.tmpl"),
  "utf8",
);

const OWNER = { uid: "u-owner", email: "owner@example.com" };
const EDITOR = { uid: "u-editor", email: "ed@example.com" };
const VIEWER = { uid: "u-viewer", email: "viewer@example.com" };
const STRANGER = { uid: "u-stranger", email: "stranger@example.com" };
const SUGGESTER = { uid: "u-suggester", email: "sug@example.com" };
const APPROVER = { uid: "u-approver", email: "appr@example.com" };
const OUTSIDER = { uid: "u-outsider", email: "someone@evil.example.com" };
/** Opened the unlisted document with its current key. */
const GRANTED = { uid: "u-granted", email: "granted@example.com" };
/** Opened it with a key the owner has since rotated away. */
const STALE = { uid: "u-stale", email: "stale@example.com" };

/** A verified principal. */
const verified = (env, p) =>
  env.authenticatedContext(p.uid, { email: p.email, email_verified: true });

/** Verified in the token's own opinion, but with no address at all. */
const noEmail = (env) =>
  env.authenticatedContext("u-noemail", { email_verified: true });

const unverified = (env, p) =>
  env.authenticatedContext(p.uid, { email: p.email, email_verified: false });

function actorFor(p) {
  return { uid: p.uid, email: p.email, channel: "web" };
}

async function seed(env, mutate) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await mutate(ctx.firestore());
  });
}

describe("firestore rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-bikeshed",
      firestore: {
        // Rendered IN MEMORY from the same pure functions that produce the
        // committed artifact, so the suite can never test a stale file.
        rules: renderFirestoreRules({ allowedEmailDomains: [] }, TEMPLATE, "test"),
        host: "127.0.0.1",
        port: EMULATORS.firestore.port,
      },
    });
  });

  after(async () => {
    await env?.cleanup();
  });

  before(async () => {
    await env.clearFirestore();
    await seed(env, async (db) => {
      await setDoc(doc(db, "docs/private-doc"), {
        docId: "private-doc",
        title: "Private",
        ownerUid: OWNER.uid,
        ownerEmail: OWNER.email,
        currentVersion: "v1",
        viewers: [VIEWER.email],
        editors: [EDITOR.email],
        members: [OWNER.email, VIEWER.email, EDITOR.email],
        editorMembers: [OWNER.email, EDITOR.email],
        visibility: "private",
        createdAt: new Date(),
      });
      await setDoc(doc(db, "docs/private-doc/versions/v1"), { versionId: "v1" });
      await setDoc(doc(db, "docs/private-doc/versions/v1/annotations/a1"), {
        annId: "a1",
        authorUid: VIEWER.uid,
        authorEmail: VIEWER.email,
        actor: actorFor(VIEWER),
        anchor: { elementId: "s1", exact: "text", prefix: "", suffix: "", start: 0, end: 4 },
        color: "#b5257b",
        resolved: false,
        createdAt: new Date(),
      });
      await setDoc(doc(db, "docs/private-doc/viewers/u-viewer"), { uid: VIEWER.uid, views: 1 });
      await setDoc(doc(db, "docs/private-doc/views/s1"), { sessionId: "s1", uid: VIEWER.uid });
      await setDoc(doc(db, "docs/private-doc/acl/e1"), { at: new Date(), added: [] });

      // The four-role ladder (SPEC §13). The approver is deliberately NOT in
      // editorMembers here, so the direct `approvers` clause is what is tested.
      await setDoc(doc(db, "docs/ladder-doc"), {
        docId: "ladder-doc",
        ownerUid: OWNER.uid,
        ownerEmail: OWNER.email,
        currentVersion: "v1",
        viewers: [],
        suggesters: [SUGGESTER.email],
        editors: [],
        approvers: [APPROVER.email],
        members: [OWNER.email, SUGGESTER.email, APPROVER.email],
        suggesterMembers: [OWNER.email, SUGGESTER.email, APPROVER.email],
        editorMembers: [OWNER.email],
        approverMembers: [OWNER.email, APPROVER.email],
        visibility: "private",
        createdAt: new Date(),
      });
      await setDoc(doc(db, "docs/ladder-doc/viewers/u-suggester"), { uid: SUGGESTER.uid, views: 1 });

      // A suggestion, as only the server writes one, with its opening comment.
      await setDoc(doc(db, "docs/private-doc/versions/v1/annotations/sug1"), {
        annId: "sug1",
        authorUid: VIEWER.uid,
        authorEmail: VIEWER.email,
        actor: actorFor(VIEWER),
        anchor: { elementId: "s1", exact: "text", prefix: "", suffix: "", start: 0, end: 4 },
        color: "#b5257b",
        resolved: false,
        createdAt: new Date(),
        suggestion: { replacement: "words", state: "pending" },
      });
      await setDoc(doc(db, "docs/private-doc/versions/v1/annotations/sug1/comments/c1"), {
        commentId: "c1",
        body: "Suggested replacing “text” with “words”.",
        authorUid: VIEWER.uid,
        authorEmail: VIEWER.email,
        actor: actorFor(VIEWER),
        createdAt: new Date(),
        opensSuggestion: true,
        generated: true,
      });

      // What the server writes into a suggestion's thread: a decision, and an
      // opener in its author's own words.
      await setDoc(doc(db, "docs/private-doc/versions/v1/annotations/sug1/comments/c2"), {
        commentId: "c2",
        body: "Accepted.",
        authorUid: OWNER.uid,
        authorEmail: OWNER.email,
        actor: actorFor(OWNER),
        createdAt: new Date(),
        generated: true,
      });
      await setDoc(doc(db, "docs/private-doc/versions/v1/annotations/sug1/comments/c3"), {
        commentId: "c3",
        body: "This reads better.",
        authorUid: VIEWER.uid,
        authorEmail: VIEWER.email,
        actor: actorFor(VIEWER),
        createdAt: new Date(),
        opensSuggestion: true,
      });

      // A document whose members entry is stored with the wrong case.
      await setDoc(doc(db, "docs/mixedcase-doc"), {
        docId: "mixedcase-doc",
        ownerUid: null,
        ownerEmail: "Owner@Example.com",
        members: ["Viewer@Example.com"],
        visibility: "private",
        createdAt: new Date(),
      });

      await setDoc(doc(db, "docs/public-doc"), {
        docId: "public-doc",
        title: "Public",
        ownerUid: OWNER.uid,
        ownerEmail: OWNER.email,
        currentVersion: "v1",
        viewers: [],
        editors: [],
        members: [OWNER.email],
        editorMembers: [OWNER.email],
        visibility: "public",
        publicEdit: true,
        createdAt: new Date(),
      });
      await setDoc(doc(db, "docs/public-doc/versions/v1"), { versionId: "v1" });
      await setDoc(doc(db, "public/public-doc"), {
        docId: "public-doc",
        title: "Public",
        visibility: "public",
      });

      await setDoc(doc(db, "docs/unlisted-doc"), {
        docId: "unlisted-doc",
        title: "Unlisted",
        ownerUid: OWNER.uid,
        ownerEmail: OWNER.email,
        currentVersion: "v1",
        viewers: [],
        editors: [],
        members: [OWNER.email],
        editorMembers: [OWNER.email],
        visibility: "unlisted",
        linkToken: "tok-current",
        publicEdit: true,
        createdAt: new Date(),
      });
      await setDoc(doc(db, "docs/unlisted-doc/versions/v1"), { versionId: "v1" });
      await setDoc(doc(db, "docs/unlisted-doc/versions/v1/annotations/a1"), {
        annId: "a1",
        authorUid: OWNER.uid,
        authorEmail: OWNER.email,
        actor: actorFor(OWNER),
        anchor: { elementId: "s1", exact: "text", prefix: "", suffix: "", start: 0, end: 4 },
        color: "#b5257b",
        resolved: false,
        createdAt: new Date(),
      });
      await setDoc(doc(db, "docs/unlisted-doc/linkGrants/u-granted"), {
        uid: GRANTED.uid,
        token: "tok-current",
      });
      await setDoc(doc(db, "docs/unlisted-doc/linkGrants/u-stale"), {
        uid: STALE.uid,
        token: "tok-old",
      });
      // The public document is a fork of the unlisted one. Its readers may
      // not learn that from here: an unlisted id belongs to its link holders.
      await setDoc(doc(db, "forks/public-doc"), {
        parentId: "unlisted-doc",
        parentVersion: "v1",
        parentContentHash: "h1",
      });
      // A mirror left behind from before unlisted documents stopped being
      // projected. The rule must not serve it, whatever the server forgot.
      await setDoc(doc(db, "public/unlisted-doc"), {
        docId: "unlisted-doc",
        title: "Unlisted",
        visibility: "unlisted",
      });

      await setDoc(doc(db, "folders/f1"), {
        folderId: "f1",
        ownerUid: OWNER.uid,
        ownerEmail: OWNER.email,
        members: [OWNER.email, VIEWER.email],
        editorMembers: [OWNER.email],
        createdAt: new Date(),
      });

      await setDoc(doc(db, "teams/t1"), {
        teamId: "t1",
        name: "Design",
        ownerEmail: OWNER.email,
        admins: [OWNER.email],
        members: [OWNER.email, EDITOR.email],
        createdAt: new Date(),
      });

      await setDoc(doc(db, "users/u-owner"), {
        uid: OWNER.uid,
        email: OWNER.email,
        displayName: "Owner",
        verification: { hash: "secret", email: OWNER.email },
        emailCooldowns: { "private-doc": 1 },
      });
      await setDoc(doc(db, "users/u-owner/tokens/tok1"), { tokenId: "tok1", name: "cli" });
      await setDoc(doc(db, "tokens/tok1"), { tokenId: "tok1", uid: OWNER.uid, hash: "h" });
      // A connected app's grant and its pending code (SPEC §23).
      await setDoc(doc(db, "tokens/grant1"), {
        tokenId: "grant1",
        kind: "oauth",
        uid: OWNER.uid,
        accessHash: "a",
        refreshHash: "r",
        nonce: "n",
      });
      await setDoc(doc(db, "users/u-owner/tokens/grant1"), { tokenId: "grant1", kind: "oauth", name: "Claude" });
      await setDoc(doc(db, "oauthCodes/c1"), { uid: OWNER.uid, codeChallenge: "x" });
    });
  });

  // --- The identity gate ---------------------------------------------------

  it("an unauthenticated caller reads nothing", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "docs/private-doc")));
    await assertFails(getDoc(doc(db, "docs/public-doc")));
    await assertFails(getDoc(doc(db, "docs/public-doc/versions/v1")));
  });

  it("an unverified address reads nothing, even as the owner", async () => {
    const db = unverified(env, OWNER).firestore();
    await assertFails(getDoc(doc(db, "docs/private-doc")));
  });

  it("a token claiming verification with NO email claim is denied everywhere", async () => {
    // `email is string` is a real conjunct. Without it this principal reaches
    // the member checks and denies only by accident.
    const db = noEmail(env).firestore();
    await assertFails(getDoc(doc(db, "docs/private-doc")));
    await assertFails(getDoc(doc(db, "folders/f1")));
    await assertFails(getDoc(doc(db, "teams/t1")));
  });

  it("a verified account on ANY domain who is a member can read", async () => {
    // The capability this rebuild adds: there is no domain gate.
    const db = verified(env, VIEWER).firestore();
    await assertSucceeds(getDoc(doc(db, "docs/private-doc")));
  });

  it("a verified non-member cannot read a private document", async () => {
    const db = verified(env, STRANGER).firestore();
    await assertFails(getDoc(doc(db, "docs/private-doc")));
  });

  // --- The list rule -------------------------------------------------------

  it("the workspace query succeeds for a member", async () => {
    const db = verified(env, VIEWER).firestore();
    await assertSucceeds(
      getDocs(query(collection(db, "docs"), where("members", "array-contains", VIEWER.email))),
    );
  });

  it("a stranger cannot query for SOMEONE ELSE'S membership", async () => {
    // Proves the list rule compares against the caller's own token email rather
    // than trusting the filter value. A domain gate would have masked this
    // entirely, because the attacker would have been refused earlier.
    const db = verified(env, STRANGER).firestore();
    await assertFails(
      getDocs(query(collection(db, "docs"), where("members", "array-contains", OWNER.email))),
    );
  });

  it("an unfiltered listing of every document is refused", async () => {
    const db = verified(env, VIEWER).firestore();
    await assertFails(getDocs(collection(db, "docs")));
  });

  it("a mixed-case members entry grants neither get nor list", async () => {
    // Members are stored lowercased as an invariant, and the list rule cannot
    // call .lower() because it must be statically provable from the query. This
    // is what that invariant is protecting.
    const db = verified(env, VIEWER).firestore();
    await assertFails(getDoc(doc(db, "docs/mixedcase-doc")));
    await assertFails(
      getDocs(
        query(collection(db, "docs"), where("members", "array-contains", "Viewer@Example.com")),
      ),
    );
  });

  // --- Server-only writes --------------------------------------------------

  it("clients never write documents, versions, folders, teams or the projection", async () => {
    const db = verified(env, OWNER).firestore();
    await assertFails(setDoc(doc(db, "docs/private-doc"), { title: "hijacked" }));
    await assertFails(updateDoc(doc(db, "docs/private-doc"), { members: [STRANGER.email] }));
    await assertFails(setDoc(doc(db, "docs/private-doc/versions/v2"), { versionId: "v2" }));
    await assertFails(setDoc(doc(db, "folders/f1"), { name: "hijacked" }));
    await assertFails(setDoc(doc(db, "teams/t1"), { name: "hijacked" }));
    await assertFails(setDoc(doc(db, "public/public-doc"), { title: "hijacked" }));
    await assertFails(setDoc(doc(db, "docs/private-doc/acl/e2"), { at: new Date() }));
  });

  it("a brand-new collection is denied by default", async () => {
    // Guards against a rules suite going vacuous: if the catch-all ever
    // loosened, this is what notices.
    const db = verified(env, OWNER).firestore();
    await assertFails(getDoc(doc(db, "somethingNew/x")));
    await assertFails(setDoc(doc(db, "somethingNew/x"), { a: 1 }));
  });

  it("archived feedback is readable but every annotation and comment write is refused, even to its owner", async () => {
    const root = "docs/archive-guard";
    const ann = { annId: "a", anchor: { exact: "old text" }, authorUid: OWNER.uid,
      authorEmail: OWNER.email, actor: actorFor(OWNER), color: "pink", resolved: false, createdAt: serverTimestamp() };
    const comment = { commentId: "c", body: "archived feedback", authorUid: OWNER.uid,
      authorEmail: OWNER.email, actor: actorFor(OWNER), createdAt: serverTimestamp() };
    await seed(env, db => setDoc(doc(db, root), { ownerUid: OWNER.uid, ownerEmail: OWNER.email, currentVersion: "v1", visibility: "private" }));
    const db = verified(env, OWNER).firestore();
    const a = doc(db, `${root}/versions/v1/annotations/a`);
    const c = doc(db, `${root}/versions/v1/annotations/a/comments/c`);
    await assertSucceeds(setDoc(a, ann));
    await assertSucceeds(setDoc(c, comment));
    await assertSucceeds(updateDoc(a, { resolved: true, resolvedBy: actorFor(OWNER) }));
    await assertSucceeds(updateDoc(c, { body: "edited on latest" }));
    await seed(env, db => updateDoc(doc(db, root), { currentVersion: "v2" }));
    assert.equal((await assertSucceeds(getDoc(c))).data().body, "edited on latest");
    assert.equal((await assertSucceeds(getDoc(a))).data().resolved, true);
    await assertFails(setDoc(doc(db, `${root}/versions/v1/annotations/new`), { ...ann, annId: "new" }));
    await assertFails(setDoc(doc(db, `${root}/versions/v1/annotations/a/comments/new`), { ...comment, commentId: "new" }));
    await assertFails(updateDoc(a, { resolved: false, resolvedBy: actorFor(OWNER) }));
    await assertFails(updateDoc(c, { body: "late edit" }));
    await assertFails(deleteDoc(c));
    await assertFails(deleteDoc(a));
    assert.equal((await getDoc(c)).data().body, "edited on latest");
    assert.equal((await getDoc(a)).data().resolved, true);
  });

  // --- Annotations and comments -------------------------------------------

  it("a member creates an annotation authored by themselves", async () => {
    const db = verified(env, VIEWER).firestore();
    await assertSucceeds(
      setDoc(doc(db, "docs/private-doc/versions/v1/annotations/new1"), {
        annId: "new1",
        authorUid: VIEWER.uid,
        authorEmail: VIEWER.email,
        actor: actorFor(VIEWER),
        anchor: { elementId: "s1", exact: "x", prefix: "", suffix: "", start: 0, end: 1 },
        color: "#b5257b",
        resolved: false,
        createdAt: serverTimestamp(),
      }),
    );
  });

  it("an annotation cannot be authored as somebody else", async () => {
    const db = verified(env, VIEWER).firestore();
    await assertFails(
      setDoc(doc(db, "docs/private-doc/versions/v1/annotations/forged"), {
        annId: "forged",
        authorUid: OWNER.uid,
        authorEmail: OWNER.email,
        actor: actorFor(OWNER),
        anchor: {},
        color: "#b5257b",
        resolved: false,
        createdAt: serverTimestamp(),
      }),
    );
  });

  it("a client write cannot claim an automation channel", async () => {
    // A direct client write IS the web channel by definition; automation goes
    // through the Admin SDK, which bypasses these rules. Pinning it here is what
    // makes `channel` server-derived rather than self-reported (SPEC §17).
    const db = verified(env, VIEWER).firestore();
    await assertFails(
      setDoc(doc(db, "docs/private-doc/versions/v1/annotations/faked"), {
        annId: "faked",
        authorUid: VIEWER.uid,
        authorEmail: VIEWER.email,
        actor: { uid: VIEWER.uid, email: VIEWER.email, channel: "mcp" },
        anchor: {},
        color: "#b5257b",
        resolved: false,
        createdAt: serverTimestamp(),
      }),
    );
  });

  it("a reader may toggle resolved and nothing else", async () => {
    const db = verified(env, EDITOR).firestore();
    const ref = doc(db, "docs/private-doc/versions/v1/annotations/a1");
    const by = actorFor(EDITOR);
    await assertSucceeds(updateDoc(ref, { resolved: true, resolvedBy: by }));
    await assertFails(updateDoc(ref, { authorEmail: EDITOR.email }));
    await assertFails(updateDoc(ref, { anchor: { elementId: "moved" } }));
    await assertFails(updateDoc(ref, { actor: actorFor(EDITOR) }));
    // The pins above held the fields that existed; nothing stopped a resolve
    // from adding one beside them, or setting `resolved` to something that is
    // neither open nor closed.
    await assertFails(updateDoc(ref, { resolved: false, resolvedBy: by, note: "added on the side" }));
    await assertFails(updateDoc(ref, { "actor.tokenId": "tok_agent" }));
    await assertFails(updateDoc(ref, { resolved: "yes", resolvedBy: by }));
    await assertFails(updateDoc(ref, { resolved: deleteField(), resolvedBy: by }));
  });

  it("a resolve says who did it, and it can only be the caller, on the web", async () => {
    // The change log reports `resolvedBy` as who resolved or reopened a
    // thread, so a browser must not be able to put anybody else there, or say
    // nothing and leave the last resolver's name standing.
    const at = (p) => doc(verified(env, p).firestore(), "docs/private-doc/versions/v1/annotations/a1");
    await assertSucceeds(updateDoc(at(EDITOR), { resolved: true, resolvedBy: actorFor(EDITOR) }));
    // The owner reopens it: saying nothing would leave the editor's name on it.
    await assertFails(updateDoc(at(OWNER), { resolved: false }));
    await assertFails(updateDoc(at(OWNER), { resolved: false, resolvedBy: actorFor(EDITOR) }));
    await assertFails(updateDoc(at(OWNER), { resolved: false, resolvedBy: { ...actorFor(OWNER), channel: "mcp" } }));
    await assertFails(updateDoc(at(OWNER), { resolved: false, resolvedBy: { ...actorFor(OWNER), tokenId: "tok_agent" } }));
    await assertSucceeds(updateDoc(at(OWNER), { resolved: false, resolvedBy: actorFor(OWNER) }));
  });

  it("nobody but the server reads or writes a document's change log or a saved cursor", async () => {
    // Both are written through the Admin SDK only (ADR 0016); the catch-all
    // denies them, and this pins that it still does.
    const owner = verified(env, OWNER).firestore();
    await assertFails(getDoc(doc(owner, "docs/private-doc/events/e1")));
    await assertFails(getDocs(collection(owner, "docs/private-doc/events")));
    await assertFails(setDoc(doc(owner, "docs/private-doc/events/e2"), { type: "comment.added" }));
    await assertFails(getDoc(doc(owner, `users/${OWNER.uid}/cursors/t1~private-doc`)));
    await assertFails(setDoc(doc(owner, `users/${OWNER.uid}/cursors/t1~private-doc`), { cursor: "x" }));
  });

  // --- Feedback is exactly what the app writes (SPEC §6, §17) ---------------
  // A browser could otherwise sign its feedback with an agent's token id and
  // so hide it from that agent, date it whenever it liked, or leave out
  // `resolved` and slip past every count of open threads.

  const annotationBy = (p, annId) => ({
    annId,
    authorUid: p.uid,
    authorEmail: p.email,
    actor: actorFor(p),
    anchor: { elementId: "s1", exact: "x", prefix: "", suffix: "", start: 0, end: 1 },
    color: "#b5257b",
    resolved: false,
    createdAt: serverTimestamp(),
  });

  const commentBy = (p, commentId) => ({
    commentId,
    body: "Is this the dual-write fortnight?",
    authorUid: p.uid,
    authorEmail: p.email,
    actor: actorFor(p),
    createdAt: serverTimestamp(),
  });

  it("an annotation carries exactly the app's fields, open, on the server's clock", async () => {
    const db = verified(env, VIEWER).firestore();
    const at = (id) => doc(db, `docs/private-doc/versions/v1/annotations/${id}`);
    await assertSucceeds(setDoc(at("exact1"), annotationBy(VIEWER, "exact1")));
    await assertFails(setDoc(at("extra"), { ...annotationBy(VIEWER, "extra"), note: "x" }));
    const { resolved, ...unresolvable } = annotationBy(VIEWER, "noresolved");
    assert.equal(resolved, false);
    await assertFails(setDoc(at("noresolved"), unresolvable));
    await assertFails(setDoc(at("closed"), { ...annotationBy(VIEWER, "closed"), resolved: true }));
    await assertFails(setDoc(at("backdated"), { ...annotationBy(VIEWER, "backdated"), createdAt: new Date(0) }));
    await assertFails(setDoc(at("noanchor"), { ...annotationBy(VIEWER, "noanchor"), anchor: "s1" }));
  });

  it("a comment carries exactly the app's fields, on the server's clock", async () => {
    const db = verified(env, VIEWER).firestore();
    const at = (id) => doc(db, `docs/private-doc/versions/v1/annotations/a1/comments/${id}`);
    await assertSucceeds(setDoc(at("exact1"), commentBy(VIEWER, "exact1")));
    await assertFails(setDoc(at("extra"), { ...commentBy(VIEWER, "extra"), note: "x" }));
    await assertFails(setDoc(at("backdated"), { ...commentBy(VIEWER, "backdated"), createdAt: new Date(0) }));
    await assertFails(setDoc(at("nobody"), { ...commentBy(VIEWER, "nobody"), body: 42 }));
  });

  it("a browser cannot sign its feedback with an agent's token, client or agent name", async () => {
    const db = verified(env, VIEWER).firestore();
    for (const extra of [{ tokenId: "tok_agent" }, { client: "claude-code" }, { agent: "reviewer" }]) {
      const actor = { ...actorFor(VIEWER), ...extra };
      const key = Object.keys(extra)[0];
      await assertFails(
        setDoc(doc(db, `docs/private-doc/versions/v1/annotations/as-${key}`), {
          ...annotationBy(VIEWER, `as-${key}`),
          actor,
        }),
      );
      await assertFails(
        setDoc(doc(db, `docs/private-doc/versions/v1/annotations/a1/comments/as-${key}`), {
          ...commentBy(VIEWER, `as-${key}`),
          actor,
        }),
      );
    }
  });

  it("a comment's author rewords it, and nothing else", async () => {
    const db = verified(env, VIEWER).firestore();
    const at = doc(db, "docs/private-doc/versions/v1/annotations/a1/comments/mine");
    await assertSucceeds(setDoc(at, commentBy(VIEWER, "mine")));
    await assertSucceeds(updateDoc(at, { body: "Is this the two-week dual-write?" }));
    await assertFails(updateDoc(at, { body: "Earlier.", createdAt: new Date(0) }));
    await assertFails(updateDoc(at, { "actor.tokenId": "tok_agent" }));
    await assertFails(updateDoc(at, { note: "added on the side" }));
    await assertFails(updateDoc(at, { body: 42 }));
  });

  it("only the author deletes their annotation", async () => {
    const mine = verified(env, VIEWER).firestore();
    const theirs = verified(env, EDITOR).firestore();
    await assertFails(deleteDoc(doc(theirs, "docs/private-doc/versions/v1/annotations/a1")));
    await assertSucceeds(deleteDoc(doc(mine, "docs/private-doc/versions/v1/annotations/new1")));
  });

  // --- Suggestions (SPEC §22): POST /suggestion is the only writer ----------

  const plainAnnotation = (p, annId) => ({
    annId,
    authorUid: p.uid,
    authorEmail: p.email,
    actor: actorFor(p),
    anchor: { elementId: "s1", exact: "x", prefix: "", suffix: "", start: 0, end: 1 },
    color: "#b5257b",
    resolved: false,
    createdAt: serverTimestamp(),
  });

  // Every mutation is independently judged: a missing gate must fail its own
  // test instead of being hidden behind the first rejected create (SPEC §17).
  async function feedbackFixture(p, suffix, expiresAt) {
    const id = `feedback-expiry-${p.uid}-${suffix}`;
    const base = `docs/${id}/versions/v1/annotations`;
    await seed(env, async (db) => {
      await setDoc(doc(db, `docs/${id}`), {
        ownerUid: OWNER.uid, ownerEmail: OWNER.email, visibility: "private",
        members: [OWNER.email, VIEWER.email],
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      for (const key of ["change", "remove"]) {
        await setDoc(doc(db, `${base}/${key}`), { ...plainAnnotation(p, key), createdAt: new Date(0) });
      }
      for (const key of ["change", "remove"]) {
        await setDoc(doc(db, `${base}/change/comments/${key}`), {
          commentId: key, body: "original", authorUid: p.uid, authorEmail: p.email,
          actor: actorFor(p), createdAt: new Date(0),
        });
      }
    });
    const db = verified(env, p).firestore();
    return { id, db, base, writes: {
      "annotation create": () => setDoc(doc(db, `${base}/new`), plainAnnotation(p, "new")),
      "annotation update": () => updateDoc(doc(db, `${base}/change`), { resolved: true, resolvedBy: actorFor(p) }),
      "annotation delete": () => deleteDoc(doc(db, `${base}/remove`)),
      "comment create": () => setDoc(doc(db, `${base}/change/comments/new`), {
        commentId: "new", body: "new reply", authorUid: p.uid, authorEmail: p.email,
        actor: actorFor(p), createdAt: serverTimestamp(),
      }),
      "comment update": () => updateDoc(doc(db, `${base}/change/comments/change`), { body: "edited" }),
      "comment delete": () => deleteDoc(doc(db, `${base}/change/comments/remove`)),
    } };
  }

  for (const p of [OWNER, VIEWER]) {
    for (const operation of ["annotation create", "annotation update", "annotation delete", "comment create", "comment update", "comment delete"]) {
      it(`expiry freezes ${operation} by ${p === OWNER ? "the owner" : "a viewer"}, and clearing expiry restores it`, async () => {
        const f = await feedbackFixture(p, operation.replaceAll(" ", "-"), new Date(0));
        await assertFails(f.writes[operation]());
        // Existing comments and the workspace row remain readable: expiry is
        // a content freeze, not an incompatible query filter or deletion.
        await assertSucceeds(getDoc(doc(f.db, `docs/${f.id}`)));
        assert.equal((await assertSucceeds(getDoc(doc(f.db, `${f.base}/change/comments/change`)))).data().body, "original");
        await seed(env, (db) => updateDoc(doc(db, `docs/${f.id}`), { expiresAt: null }));
        await assertSucceeds(f.writes[operation]());
      });
    }
    for (const [kind, expiry] of [["absent", undefined], ["null", null], ["future", new Date(Date.now() + 3_600_000)]]) {
      it(`${kind} expiry permits every otherwise-authorized feedback mutation by ${p === OWNER ? "the owner" : "a viewer"}`, async () => {
        const f = await feedbackFixture(p, kind, expiry);
        for (const write of Object.values(f.writes)) await assertSucceeds(write());
      });
    }
  }

  it("clearing expiry does not give the owner another author's edit or delete rights", async () => {
    const f = await feedbackFixture(VIEWER, "ownership", null);
    const db = verified(env, OWNER).firestore();
    await assertFails(updateDoc(doc(db, `${f.base}/change/comments/change`), { body: "owner rewrite" }));
    await assertFails(deleteDoc(doc(db, `${f.base}/change/comments/change`)));
    await assertFails(deleteDoc(doc(db, `${f.base}/change`)));
  });

  it("no client creates a suggestion, though the same annotation without one is fine", async () => {
    const db = verified(env, VIEWER).firestore();
    const at = (id) => doc(db, `docs/private-doc/versions/v1/annotations/${id}`);
    await assertFails(
      setDoc(at("forged-sug"), {
        ...plainAnnotation(VIEWER, "forged-sug"),
        suggestion: { replacement: "y", state: "pending" },
      }),
    );
    await assertSucceeds(setDoc(at("control-sug"), plainAnnotation(VIEWER, "control-sug")));
  });

  it("nobody resolves a suggestion from a client, owner included", async () => {
    // `resolved` is what the publish gate counts. A reader flipping it on a
    // suggestion would lift the gate without anybody deciding anything.
    for (const p of [VIEWER, EDITOR, OWNER]) {
      const db = verified(env, p).firestore();
      await assertFails(
        updateDoc(doc(db, "docs/private-doc/versions/v1/annotations/sug1"), { resolved: true }),
      );
    }
  });

  it("nobody decides a suggestion by writing its state, owner included", async () => {
    const db = verified(env, OWNER).firestore();
    const ref = doc(db, "docs/private-doc/versions/v1/annotations/sug1");
    await assertFails(updateDoc(ref, { "suggestion.state": "accepted" }));
    await assertFails(updateDoc(ref, { "suggestion.replacement": "something else" }));
  });

  it("a suggestion cannot be stripped back into a plain annotation and resolved", async () => {
    // The one write the post-write check alone would let through: remove the
    // field and resolve in the same update, so the result no longer looks like
    // a suggestion at all.
    const db = verified(env, VIEWER).firestore();
    await assertFails(
      updateDoc(doc(db, "docs/private-doc/versions/v1/annotations/sug1"), {
        suggestion: deleteField(),
        resolved: true,
      }),
    );
  });

  it("a plain annotation cannot be turned into a suggestion", async () => {
    const db = verified(env, VIEWER).firestore();
    await assertFails(
      updateDoc(doc(db, "docs/private-doc/versions/v1/annotations/a1"), {
        suggestion: { replacement: "y", state: "pending" },
      }),
    );
  });

  it("its author withdraws a suggestion through the endpoint, not by deleting it", async () => {
    const db = verified(env, VIEWER).firestore();
    await assertFails(deleteDoc(doc(db, "docs/private-doc/versions/v1/annotations/sug1")));
  });

  it("anyone who reads it may discuss a suggestion", async () => {
    const db = verified(env, EDITOR).firestore();
    await assertSucceeds(
      setDoc(doc(db, "docs/private-doc/versions/v1/annotations/sug1/comments/r1"), {
        commentId: "r1",
        body: "Why this word?",
        authorUid: EDITOR.uid,
        authorEmail: EDITOR.email,
        actor: actorFor(EDITOR),
        createdAt: serverTimestamp(),
      }),
    );
  });

  it("no client writes a comment as the server's", async () => {
    const db = verified(env, EDITOR).firestore();
    const base = {
      body: "Accepted.",
      authorUid: EDITOR.uid,
      authorEmail: EDITOR.email,
      actor: actorFor(EDITOR),
      createdAt: serverTimestamp(),
    };
    const at = (id) => doc(db, `docs/private-doc/versions/v1/annotations/sug1/comments/${id}`);
    await assertFails(setDoc(at("g1"), { ...base, commentId: "g1", generated: true }));
    await assertFails(setDoc(at("g2"), { ...base, commentId: "g2", opensSuggestion: true }));
    // Nor by editing one of its own afterwards.
    await assertFails(updateDoc(at("r1"), { generated: true }));
    await assertSucceeds(updateDoc(at("r1"), { body: "Why this word, here?" }));
  });

  it("nobody rewrites or deletes what the server wrote in a thread, its stamped author included", async () => {
    // Each is stamped with the person it speaks for, so the comment rules let
    // that person edit and delete it: an approver could erase "Accepted.", and
    // an author rewrite their opener outside the revision history.
    const at = (db, id) => doc(db, `docs/private-doc/versions/v1/annotations/sug1/comments/${id}`);
    const owner = verified(env, OWNER).firestore();
    const author = verified(env, VIEWER).firestore();
    await assertFails(updateDoc(at(owner, "c2"), { body: "Never mind." }));
    await assertFails(deleteDoc(at(owner, "c2")));
    for (const id of ["c1", "c3"]) {
      await assertFails(updateDoc(at(author, id), { body: "Something else entirely." }));
      await assertFails(deleteDoc(at(author, id)));
    }
  });

  it("a person still edits and deletes their own reply in a suggestion's thread", async () => {
    const db = verified(env, EDITOR).firestore();
    const at = doc(db, "docs/private-doc/versions/v1/annotations/sug1/comments/r9");
    await assertSucceeds(
      setDoc(at, { commentId: "r9", body: "Hmm.", authorUid: EDITOR.uid, authorEmail: EDITOR.email, actor: actorFor(EDITOR), createdAt: serverTimestamp() }),
    );
    await assertSucceeds(updateDoc(at, { body: "Hmm, fine." }));
    await assertSucceeds(deleteDoc(at));
  });

  it("a non-member cannot read or write feedback", async () => {
    const db = verified(env, STRANGER).firestore();
    await assertFails(getDoc(doc(db, "docs/private-doc/versions/v1/annotations/a1")));
    await assertFails(
      setDoc(doc(db, "docs/private-doc/versions/v1/annotations/x"), { annId: "x" }),
    );
  });

  // --- Public documents ----------------------------------------------------

  it("anyone reads a PUBLIC projection, and nobody writes it", async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "public/public-doc")));
    await assertFails(setDoc(doc(anon, "public/public-doc"), { title: "x" }));
  });

  it("anonymous cannot read the SOURCE document of a public one", async () => {
    // Firestore rules cannot project fields, so the source record still carries
    // members, ownerEmail and stats. That is the whole reason the projection
    // exists.
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "docs/public-doc")));
  });

  it("a signed-in non-member reads a public document's versions and feedback", async () => {
    const db = verified(env, STRANGER).firestore();
    await assertSucceeds(getDoc(doc(db, "docs/public-doc/versions/v1")));
    await assertSucceeds(
      getDocs(collection(db, "docs/public-doc/versions/v1/annotations")),
    );
  });

  it("a signed-in non-member still cannot read the public document's own record", async () => {
    const db = verified(env, STRANGER).firestore();
    await assertFails(getDoc(doc(db, "docs/public-doc")));
  });

  // --- Unlisted documents need their link (SPEC §17) ------------------------

  it("an unlisted row in the projection is refused exactly as an absent id", async () => {
    // A readable row would tell a keyless visitor the title, and that the id
    // exists — the leak this rule was changed to close.
    for (const db of [env.unauthenticatedContext().firestore(), verified(env, STRANGER).firestore()]) {
      await assertFails(getDoc(doc(db, "public/unlisted-doc")));
      await assertFails(getDoc(doc(db, "public/no-such-doc")));
    }
  });

  it("the projection cannot be listed, even filtered to public rows", async () => {
    // Listing it once enumerated every unlisted document's id and title.
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(anon, "public")));
    await assertFails(getDocs(query(collection(anon, "public"), where("visibility", "==", "public"))));
    await assertFails(getDocs(collection(verified(env, STRANGER).firestore(), "public")));
  });

  it("a signed-in stranger without the link reads and writes nothing under an unlisted document", async () => {
    for (const who of [STRANGER, STALE]) {
      const db = verified(env, who).firestore();
      await assertFails(getDoc(doc(db, "docs/unlisted-doc/versions/v1")), who.uid);
      await assertFails(getDocs(collection(db, "docs/unlisted-doc/versions/v1/annotations")), who.uid);
      await assertFails(
        setDoc(doc(db, `docs/unlisted-doc/versions/v1/annotations/${who.uid}`), {
          annId: who.uid,
          authorUid: who.uid,
          authorEmail: who.email,
          actor: actorFor(who),
          anchor: { elementId: "s1", exact: "x", prefix: "", suffix: "", start: 0, end: 1 },
          color: "#b5257b",
          resolved: false,
          createdAt: serverTimestamp(),
        }),
        who.uid,
      );
      await assertFails(
        setDoc(doc(db, `docs/unlisted-doc/trust/${who.uid}`), { uid: who.uid, email: who.email }),
        who.uid,
      );
    }
  });

  it("a current link grant reads and writes feedback as itself", async () => {
    const db = verified(env, GRANTED).firestore();
    await assertSucceeds(getDoc(doc(db, "docs/unlisted-doc/versions/v1")));
    await assertSucceeds(getDocs(collection(db, "docs/unlisted-doc/versions/v1/annotations")));
    await assertSucceeds(
      setDoc(doc(db, "docs/unlisted-doc/versions/v1/annotations/g1"), {
        annId: "g1",
        authorUid: GRANTED.uid,
        authorEmail: GRANTED.email,
        actor: actorFor(GRANTED),
        anchor: { elementId: "s1", exact: "x", prefix: "", suffix: "", start: 0, end: 1 },
        color: "#b5257b",
        resolved: false,
        createdAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(
      setDoc(doc(db, "docs/unlisted-doc/versions/v1/annotations/a1/comments/c1"), {
        commentId: "c1",
        authorUid: GRANTED.uid,
        authorEmail: GRANTED.email,
        actor: actorFor(GRANTED),
        body: "Agreed.",
        createdAt: serverTimestamp(),
      }),
    );
  });

  it("a grant opens neither the record nor who read it", async () => {
    const db = verified(env, GRANTED).firestore();
    await assertFails(getDoc(doc(db, "docs/unlisted-doc")));
    await assertFails(getDocs(collection(db, "docs/unlisted-doc/viewers")));
    await assertFails(getDocs(collection(db, "docs/unlisted-doc/views")));
  });

  it("a client can neither mint a grant nor read one", async () => {
    // Minting would make the link unnecessary; reading would say who opened it.
    const stranger = verified(env, STRANGER).firestore();
    await assertFails(
      setDoc(doc(stranger, "docs/unlisted-doc/linkGrants/u-stranger"), {
        uid: STRANGER.uid,
        token: "tok-current",
      }),
    );
    const granted = verified(env, GRANTED).firestore();
    await assertFails(getDoc(doc(granted, "docs/unlisted-doc/linkGrants/u-granted")));
    await assertFails(getDocs(collection(granted, "docs/unlisted-doc/linkGrants")));
    const owner = verified(env, OWNER).firestore();
    await assertFails(getDocs(collection(owner, "docs/unlisted-doc/linkGrants")));
  });

  it("no client reads or writes where a fork came from, not even an owner at either end", async () => {
    // A docId is the slug of a title. Readable, this would hand an unlisted
    // original's address to everybody its fork is shared with (SPEC §21).
    for (const who of [OWNER, VIEWER, STRANGER, GRANTED]) {
      const db = verified(env, who).firestore();
      await assertFails(getDoc(doc(db, "forks/public-doc")));
      await assertFails(getDocs(collection(db, "forks")));
      await assertFails(
        getDocs(query(collection(db, "forks"), where("parentId", "==", "unlisted-doc"))),
      );
      await assertFails(setDoc(doc(db, "forks/public-doc"), { parentId: "elsewhere" }));
      await assertFails(setDoc(doc(db, "forks/a-new-fork"), { parentId: "public-doc" }));
    }
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "forks/public-doc")));
  });

  it("open editing does not expose per-person reading history", async () => {
    // publicEdit widens WHO may edit. It must not widen who may see who read.
    const db = verified(env, STRANGER).firestore();
    await assertFails(getDocs(collection(db, "docs/public-doc/viewers")));
    await assertFails(getDocs(collection(db, "docs/public-doc/views")));
  });

  // --- Statistics ----------------------------------------------------------

  it("per-person statistics are readable by editors and nobody else", async () => {
    const editor = verified(env, EDITOR).firestore();
    await assertSucceeds(getDoc(doc(editor, "docs/private-doc/viewers/u-viewer")));
    await assertSucceeds(getDoc(doc(editor, "docs/private-doc/views/s1")));

    const viewer = verified(env, VIEWER).firestore();
    await assertFails(getDoc(doc(viewer, "docs/private-doc/viewers/u-viewer")));
    await assertFails(getDoc(doc(viewer, "docs/private-doc/views/s1")));
  });

  it("an approver reads what editors read, and a suggester reads what viewers read", async () => {
    // An approver edits — accepting a suggestion is an edit (SPEC §13) — so the
    // rules must count a direct approver as an editor, exactly as acl.ts does.
    const approver = verified(env, APPROVER).firestore();
    await assertSucceeds(getDoc(doc(approver, "docs/ladder-doc/viewers/u-suggester")));
    const suggester = verified(env, SUGGESTER).firestore();
    await assertSucceeds(getDoc(doc(suggester, "docs/ladder-doc")));
    await assertFails(getDoc(doc(suggester, "docs/ladder-doc/viewers/u-suggester")));
  });

  it("nobody writes statistics from a client", async () => {
    const db = verified(env, OWNER).firestore();
    await assertFails(setDoc(doc(db, "docs/private-doc/viewers/u-owner"), { views: 999 }));
    await assertFails(setDoc(doc(db, "docs/private-doc/views/s2"), { ms: 999 }));
  });

  it("the ACL change log is editor-readable and never client-written", async () => {
    const editor = verified(env, EDITOR).firestore();
    await assertSucceeds(getDoc(doc(editor, "docs/private-doc/acl/e1")));
    const viewer = verified(env, VIEWER).firestore();
    await assertFails(getDoc(doc(viewer, "docs/private-doc/acl/e1")));
  });

  // --- Personal trust ------------------------------------------------------

  it("a member grants personal trust to themselves only", async () => {
    const db = verified(env, VIEWER).firestore();
    await assertSucceeds(
      setDoc(doc(db, "docs/private-doc/trust/u-viewer"), {
        uid: VIEWER.uid,
        email: VIEWER.email,
        trustedAt: new Date(),
      }),
    );
    await assertFails(
      setDoc(doc(db, "docs/private-doc/trust/u-owner"), {
        uid: OWNER.uid,
        email: OWNER.email,
        trustedAt: new Date(),
      }),
    );
  });

  it("personal trust is readable only by the account that granted it", async () => {
    const other = verified(env, EDITOR).firestore();
    await assertFails(getDoc(doc(other, "docs/private-doc/trust/u-viewer")));
  });

  it("a non-member cannot grant themselves trust on a document they cannot read", async () => {
    const db = verified(env, STRANGER).firestore();
    await assertFails(
      setDoc(doc(db, "docs/private-doc/trust/u-stranger"), {
        uid: STRANGER.uid,
        email: STRANGER.email,
        trustedAt: new Date(),
      }),
    );
  });

  // --- Folders and teams ---------------------------------------------------

  it("folder reads mirror document reads", async () => {
    await assertSucceeds(getDoc(doc(verified(env, VIEWER).firestore(), "folders/f1")));
    await assertFails(getDoc(doc(verified(env, STRANGER).firestore(), "folders/f1")));
  });

  it("a team is visible to its members and to nobody else", async () => {
    await assertSucceeds(getDoc(doc(verified(env, EDITOR).firestore(), "teams/t1")));
    await assertFails(getDoc(doc(verified(env, VIEWER).firestore(), "teams/t1")));
    await assertSucceeds(
      getDocs(
        query(
          collection(verified(env, EDITOR).firestore(), "teams"),
          where("members", "array-contains", EDITOR.email),
        ),
      ),
    );
  });

  // --- Accounts ------------------------------------------------------------

  it("a user record is self-only", async () => {
    await assertSucceeds(getDoc(doc(verified(env, OWNER).firestore(), "users/u-owner")));
    await assertFails(getDoc(doc(verified(env, VIEWER).firestore(), "users/u-owner")));
  });

  it("a user cannot mark their own address verified or clear their own cooldown", async () => {
    const db = verified(env, OWNER).firestore();
    await assertFails(updateDoc(doc(db, "users/u-owner"), { verification: null }));
    await assertFails(updateDoc(doc(db, "users/u-owner"), { emailCooldowns: {} }));
    await assertFails(updateDoc(doc(db, "users/u-owner"), { email: "other@example.com" }));
  });

  it("a user may set their own profile and preferences", async () => {
    const db = verified(env, OWNER).firestore();
    await assertSucceeds(
      updateDoc(doc(db, "users/u-owner"), {
        displayName: "New Name",
        emailNotifications: false,
        analyticsOptOut: true,
      }),
    );
  });

  it("token metadata is readable by its owner, and the secret store by nobody", async () => {
    await assertSucceeds(getDoc(doc(verified(env, OWNER).firestore(), "users/u-owner/tokens/tok1")));
    await assertFails(getDoc(doc(verified(env, VIEWER).firestore(), "users/u-owner/tokens/tok1")));
    await assertFails(getDoc(doc(verified(env, OWNER).firestore(), "tokens/tok1")));
    await assertFails(
      setDoc(doc(verified(env, OWNER).firestore(), "users/u-owner/tokens/tok2"), { name: "x" }),
    );
  });

  it("a connected app is listed to its owner, and its secrets and codes to nobody", async () => {
    // The grant's hashes and nonce live only in tokens/, and an authorization
    // code only in oauthCodes/. Both are reached through the Admin SDK alone
    // (SPEC §23); the owner sees the mirror the account screen lists.
    const owner = verified(env, OWNER).firestore();
    await assertSucceeds(getDoc(doc(owner, "users/u-owner/tokens/grant1")));
    await assertFails(getDoc(doc(owner, "tokens/grant1")));
    await assertFails(getDoc(doc(owner, "oauthCodes/c1")));
    await assertFails(getDoc(doc(verified(env, VIEWER).firestore(), "oauthCodes/c1")));
    await assertFails(setDoc(doc(owner, "oauthCodes/c2"), { uid: OWNER.uid }));
    await assertFails(
      setDoc(doc(owner, "users/u-owner/tokens/grant1"), { tokenId: "grant1", kind: "oauth", name: "Mine" }),
    );
  });
});

describe("firestore rules with a domain allowlist", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-bikeshed-allowlist",
      firestore: {
        // Rendered in memory from the SAME pure renderer, so allowlist mode is
        // tested without a temp file or a second committed fixture that could
        // itself drift.
        rules: renderFirestoreRules(
          { allowedEmailDomains: ["example.com"] },
          TEMPLATE,
          "test",
        ),
        host: "127.0.0.1",
        port: EMULATORS.firestore.port,
      },
    });
    await env.clearFirestore();
    await seed(env, async (db) => {
      await setDoc(doc(db, "docs/d1"), {
        docId: "d1",
        ownerUid: OWNER.uid,
        ownerEmail: OWNER.email,
        members: [OWNER.email, OUTSIDER.email],
        visibility: "private",
        createdAt: serverTimestamp(),
      });
    });
  });

  after(async () => {
    await env?.cleanup();
  });

  it("an allowed domain still reads normally", async () => {
    await assertSucceeds(getDoc(doc(verified(env, OWNER).firestore(), "docs/d1")));
  });

  it("a subdomain of an allowed domain is NOT allowed", async () => {
    // The matcher is anchored. An unanchored pattern would accept
    // someone@evil.example.com, and membership alone would then let them in.
    await assertFails(getDoc(doc(verified(env, OUTSIDER).firestore(), "docs/d1")));
  });
});
