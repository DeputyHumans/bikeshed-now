// SPDX-License-Identifier: Apache-2.0
// Presence is gated by a server-maintained mirror, not by the identity gate (SPEC §16).

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
import { ref, get, set, serverTimestamp, onDisconnect, goOffline } from "firebase/database";

import { renderDatabaseRules } from "../config/policy.mjs";

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
  join(ROOT, "config", "templates", "database.rules.json.tmpl"),
  "utf8",
);

const MEMBER = { uid: "u-member", email: "member@example.com" };
const OTHER = { uid: "u-other", email: "other@example.com" };
const STRANGER = { uid: "u-stranger", email: "stranger@example.com" };

const key = (email) => email.split(".").join(",");
const verified = (env, p) =>
  env.authenticatedContext(p.uid, { email: p.email, email_verified: true });

describe("realtime database rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-bikeshed",
      database: {
        rules: renderDatabaseRules({ allowedEmailDomains: [] }, TEMPLATE, "test"),
        host: "127.0.0.1",
        port: EMULATORS.database.port,
      },
    });
    await env.clearDatabase();
    // The mirror is server-written; clients can neither read nor write it.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, `presenceAccess/doc1/${key(MEMBER.email)}`), true);
      await set(ref(db, `presenceAccess/doc1/${key(OTHER.email)}`), true);
      // MEMBER may edit; OTHER may only read. `editAccess` mirrors
      // `editorMembers` and `presenceAccess` mirrors `members`, and the whole
      // reason there are two is that this asymmetry has to be enforceable.
      await set(ref(db, `editAccess/doc1/${key(MEMBER.email)}`), true);
    });
  });

  after(async () => {
    await env?.cleanup();
  });

  it("a member of the document may read presence", async () => {
    const db = verified(env, MEMBER).database();
    await assertSucceeds(get(ref(db, "status/doc1/peers")));
  });

  it("a signed-in stranger reads nothing, which is the whole point", async () => {
    // Without the mirror, any signed-in account could walk the slug space and
    // learn who reads what — and the payload carries a live selection stream,
    // which is considerably more than a name.
    const db = verified(env, STRANGER).database();
    await assertFails(get(ref(db, "status/doc1")));
  });

  it("presence on an unknown document is dark, not open", async () => {
    // Fails CLOSED: a missing mirror entry means presence goes dark, never that
    // a stranger gets in.
    const db = verified(env, MEMBER).database();
    await assertFails(get(ref(db, "status/doc-nobody-mirrored")));
  });

  it("the mirror itself is unreadable and unwritable by clients", async () => {
    const db = verified(env, MEMBER).database();
    await assertFails(get(ref(db, "presenceAccess/doc1")));
    await assertFails(set(ref(db, `presenceAccess/doc1/${key(STRANGER.email)}`), true));
  });

  it("a member writes their own presence node and nobody else's", async () => {
    const db = verified(env, MEMBER).database();
    await assertSucceeds(
      set(ref(db, `status/doc1/peers/${MEMBER.uid}`), {
        email: MEMBER.email,
        name: "Member",
        mode: "view",
        lastChanged: serverTimestamp(),
      }),
    );
    await assertFails(
      set(ref(db, `status/doc1/peers/${OTHER.uid}`), {
        email: OTHER.email,
        name: "Forged",
        mode: "view",
        lastChanged: serverTimestamp(),
      }),
    );
  });

  it("session records have immutable authenticated ownership while sibling tabs remain independent", async () => {
    const memberDb = verified(env, MEMBER).database();
    const otherDb = verified(env, OTHER).database();
    const payload = (uid, email, mode = "edit") => ({ uid, email, mode, lastChanged: serverTimestamp() });
    await assertSucceeds(set(ref(memberDb, "status/doc1/peers/session-a"), payload(MEMBER.uid, MEMBER.email)));
    await assertSucceeds(set(ref(memberDb, "status/doc1/peers/session-b"), payload(MEMBER.uid, MEMBER.email, "view")));
    await assertFails(set(ref(otherDb, "status/doc1/peers/session-a"), payload(OTHER.uid, OTHER.email, "view")));
    await assertFails(set(ref(otherDb, "status/doc1/peers/session-a"), null));
    await assertFails(set(ref(memberDb, "status/doc1/peers/session-forged"), payload(OTHER.uid, MEMBER.email)));
    await assertFails(set(ref(memberDb, "status/doc1/peers/session-anonymous"), { email: MEMBER.email, mode: "view", lastChanged: serverTimestamp() }));
    await assertSucceeds(set(ref(memberDb, "status/doc1/peers/session-b"), null));
    await assertSucceeds(get(ref(memberDb, "status/doc1/peers/session-a")));
    const a = await get(ref(memberDb, "status/doc1/peers/session-a"));
    if (a.val()?.mode !== "edit") throw new Error("the other tab's editor record must survive");
  });

  it("a new session can arm disconnect cleanup before its first presence write", async () => {
    const db = verified(env, MEMBER).database();
    const path = "status/doc1/peers/armed-before-write";
    await assertSucceeds(onDisconnect(ref(db, path)).remove());
    await assertSucceeds(set(ref(db, path), { uid: MEMBER.uid, email: MEMBER.email, mode: "view", lastChanged: serverTimestamp() }));
    goOffline(db);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const adminDb = ctx.database();
      const deadline = Date.now() + 5000;
      while ((await get(ref(adminDb, path))).exists() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal((await get(ref(adminDb, path))).exists(), false, "disconnect removes the newly announced reader");
    });
  });

  it("disconnect cleanup rechecks ownership after an absent path is claimed by another account", async () => {
    const attacker = verified(env, OTHER).database();
    const member = verified(env, MEMBER).database();
    const victim = "status/doc1/peers/claimed-after-arm";
    const marker = "status/doc1/peers/disconnect-marker";
    await assertSucceeds(onDisconnect(ref(attacker, victim)).remove());
    await set(ref(member, victim), { uid: MEMBER.uid, email: MEMBER.email, mode: "view", lastChanged: serverTimestamp() });
    await onDisconnect(ref(attacker, marker)).remove();
    await set(ref(attacker, marker), { uid: OTHER.uid, email: OTHER.email, mode: "view", lastChanged: serverTimestamp() });
    goOffline(attacker);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const adminDb = ctx.database();
      const deadline = Date.now() + 5000;
      while ((await get(ref(adminDb, marker))).exists() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal((await get(ref(adminDb, marker))).exists(), false, "the disconnect request reached the server");
      assert.equal((await get(ref(adminDb, victim))).val()?.uid, MEMBER.uid, "a queued cleanup cannot remove another person's session");
    });
  });

  it("revocation and expiry allow only deleting one's existing session or legacy record", async () => {
    const doc = "revoked-presence";
    const db = verified(env, MEMBER).database();
    const otherDb = verified(env, OTHER).database();
    const payload = { uid: MEMBER.uid, email: MEMBER.email, mode: "edit", lastChanged: serverTimestamp() };
    await env.withSecurityRulesDisabled(async (ctx) => {
      const adminDb = ctx.database();
      await set(ref(adminDb, `presenceAccess/${doc}`), { [key(MEMBER.email)]: true, [key(OTHER.email)]: true, __expiresAt: Date.now() - 1 });
      await set(ref(adminDb, `status/${doc}/peers/session`), { ...payload, lastChanged: 1 });
      await set(ref(adminDb, `status/${doc}/peers/${MEMBER.uid}`), { email: MEMBER.email, mode: "edit", lastChanged: 1 });
      await set(ref(adminDb, `status/${doc}/peers/${OTHER.uid}`), { uid: MEMBER.uid, email: MEMBER.email, mode: "edit", lastChanged: 1 });
    });
    await assertFails(set(ref(db, `status/${doc}/peers/session`), payload));
    await assertFails(set(ref(otherDb, `status/${doc}/peers/${OTHER.uid}`), null));
    await assertFails(set(ref(otherDb, `status/${doc}/peers/session`), null));
    await assertSucceeds(set(ref(db, `status/${doc}/peers/session`), null));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), `presenceAccess/${doc}/${key(MEMBER.email)}`), null);
    });
    await assertFails(set(ref(db, `status/${doc}/peers/new-session`), payload));
    await assertSucceeds(set(ref(db, `status/${doc}/peers/${MEMBER.uid}`), null));
  });

  it("only current editors may announce edit, including after a same-person tab is downgraded", async () => {
    const viewerDb = verified(env, OTHER).database();
    const payload = { uid: OTHER.uid, email: OTHER.email, mode: "view", lastChanged: serverTimestamp() };
    await assertSucceeds(set(ref(viewerDb, "status/doc1/peers/viewer-tab"), payload));
    await assertFails(set(ref(viewerDb, "status/doc1/peers/viewer-tab"), { ...payload, mode: "edit" }));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), `editAccess/doc1/${key(OTHER.email)}`), true);
    });
    await assertSucceeds(set(ref(viewerDb, "status/doc1/peers/editor-tab"), { ...payload, mode: "edit" }));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), `editAccess/doc1/${key(OTHER.email)}`), null);
    });
    await assertFails(set(ref(viewerDb, "status/doc1/peers/editor-tab"), { ...payload, mode: "edit" }));
    await assertSucceeds(set(ref(viewerDb, "status/doc1/peers/viewer-tab"), payload));
    await assertSucceeds(set(ref(viewerDb, "status/doc1/peers/editor-tab"), null));
  });

  it("a presence payload cannot lie about its address or its mode", async () => {
    const db = verified(env, MEMBER).database();
    await assertFails(
      set(ref(db, `status/doc1/peers/${MEMBER.uid}`), {
        email: OTHER.email,
        mode: "view",
        lastChanged: serverTimestamp(),
      }),
    );
    await assertFails(
      set(ref(db, `status/doc1/peers/${MEMBER.uid}`), {
        email: MEMBER.email,
        mode: "admin",
        lastChanged: serverTimestamp(),
      }),
    );
  });

  it("presence cannot be used as general-purpose storage", async () => {
    const db = verified(env, MEMBER).database();
    await assertFails(
      set(ref(db, `status/doc1/peers/${MEMBER.uid}`), {
        email: MEMBER.email,
        mode: "view",
        lastChanged: serverTimestamp(),
        payload: "x".repeat(5000),
      }),
    );
    await assertFails(
      set(ref(db, `status/doc1/peers/${MEMBER.uid}/focus`), {
        exact: "x".repeat(2000),
      }),
    );
  });

  it("an editor may append to the shared document", async () => {
    const db = verified(env, MEMBER).database();
    await assertSucceeds(set(ref(db, "status/doc1/y/initial/e1"), "AQIDBA=="));
  });

  it("a READ-ONLY member may not, which is the escalation this gate exists for", async () => {
    // OTHER is in `presenceAccess` and may watch the document, but is not in
    // `editAccess`. Gating document state on the presence mirror would let them
    // push content into an editor's browser, which that editor then autosaves
    // and publishes: read escalated to write through a channel nobody audits.
    const db = verified(env, OTHER).database();
    await assertFails(set(ref(db, "status/doc1/y/initial/e2"), "AQIDBA=="));
  });

  it("an open-editing document admits any verified account", async () => {
    // `publicEdit` widens who may edit to accounts that are by definition not
    // in `editorMembers`. Without the `*` key they would be the one class of
    // editor the shared document locks out — which is how the withdrawn edit
    // lock behaved, and it was a defect there too.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, `presenceAccess/doc2/${key(OTHER.email)}`), true);
      await set(ref(db, "editAccess/doc2/*"), true);
    });
    const db = verified(env, OTHER).database();
    await assertSucceeds(set(ref(db, "status/doc2/y/initial/e1"), "AQIDBA=="));
  });

  it("a viewer reads presence but cannot read the unpublished shared document", async () => {
    const db = verified(env, OTHER).database();
    await assertSucceeds(get(ref(db, "status/doc1/peers")));
    await assertFails(get(ref(db, "status/doc1/y/initial")));
    await assertFails(get(ref(db, "status/doc1")), "a parent read cannot bypass the draft boundary");
  });

  it("a public open editor reads the shared log without learning peer presence", async () => {
    const db = verified(env, STRANGER).database();
    await assertSucceeds(set(ref(db, "status/doc2/y/initial/stranger"), "AQIDBA=="));
    await assertSucceeds(get(ref(db, "status/doc2/y/initial")));
    await assertFails(get(ref(db, "status/doc2/peers")));
    await assertFails(get(ref(db, "status/doc2")));
  });

  it("the server clock freezes the log at expiry; only its owner still reads, and clearing restores access", async () => {
    const expiry = Date.now() + 2_000;
    const maps = { __revision: "000000000001:000000000", __expiresAt: expiry, __owner: MEMBER.email, [key(MEMBER.email)]: true, [key(OTHER.email)]: true };
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, "presenceAccess/expiring"), maps);
      await set(ref(db, "editAccess/expiring"), { ...maps, "*": true });
    });
    const ownerDb = verified(env, MEMBER).database();
    const editorDb = verified(env, OTHER).database();
    const publicDb = verified(env, STRANGER).database();
    await assertSucceeds(set(ref(editorDb, "status/expiring/y/initial/before"), "AQIDBA=="));
    await assertSucceeds(get(ref(editorDb, "status/expiring/y/initial")));
    await assertSucceeds(get(ref(publicDb, "status/expiring/y/initial")));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiry + 100 - Date.now())));
    await assertFails(set(ref(editorDb, "status/expiring/y/initial/after"), "AQIDBA=="));
    await assertFails(set(ref(ownerDb, "status/expiring/y/initial/after"), "AQIDBA=="));
    await assertFails(set(ref(ownerDb, "status/expiring/y/initial"), null));
    await assertFails(set(ref(publicDb, "status/expiring/y/initial/after"), "AQIDBA=="));
    await assertFails(get(ref(editorDb, "status/expiring/y/initial")));
    await assertFails(get(ref(editorDb, "status/expiring/peers")));
    await assertFails(get(ref(publicDb, "status/expiring/y/initial")));
    await assertSucceeds(get(ref(ownerDb, "status/expiring/y/initial")));
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, "presenceAccess/expiring/__expiresAt"), 0);
      await set(ref(db, "editAccess/expiring/__expiresAt"), 0);
    });
    await assertSucceeds(set(ref(editorDb, "status/expiring/y/initial/restored"), "AQIDBA=="));
    await assertSucceeds(get(ref(editorDb, "status/expiring/y/initial")));
  });

  it("a stranger may neither read nor write the shared document", async () => {
    const db = verified(env, STRANGER).database();
    await assertFails(get(ref(db, "status/doc1/y/initial")));
    await assertFails(set(ref(db, "status/doc1/y/initial/e3"), "AQIDBA=="));
  });

  it("an editor may remove entries, because compaction has to", async () => {
    const db = verified(env, MEMBER).database();
    await assertSucceeds(set(ref(db, "status/doc1/y/initial/e4"), "AQIDBA=="));
    await assertSucceeds(set(ref(db, "status/doc1/y/initial/e4"), null));
  });

  it("an editor can retire the entire log but cannot replace it; a viewer cannot retire it", async () => {
    const editorDb = verified(env, MEMBER).database();
    const viewerDb = verified(env, OTHER).database();
    await assertSucceeds(set(ref(editorDb, "status/doc1/y/initial/retire"), "AQIDBA=="));
    await assertFails(set(ref(viewerDb, "status/doc1/y/initial"), null));
    await assertFails(set(ref(editorDb, "status/doc1/y/initial"), { replacement: "AQIDBA==" }));
    await assertSucceeds(set(ref(editorDb, "status/doc1/y/initial"), null));
  });

  it("epoch rotation rejects delayed writes and editor claims while retirement preserves the new log", async () => {
    const doc = "epoch-fence";
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, `editAccess/${doc}`), { [key(MEMBER.email)]: true, __liveEpoch: "initial" });
      await set(ref(db, `presenceAccess/${doc}`), { [key(MEMBER.email)]: true });
    });
    const db = verified(env, MEMBER).database();
    await assertSucceeds(set(ref(db, `status/${doc}/y/initial/_seed`), "seed"));
    await assertSucceeds(set(ref(db, `status/${doc}/y/initial/delta`), "delta"));
    await assertFails(set(ref(db, `status/${doc}/y/initial/_seed`), "different"));
    await assertFails(set(ref(db, `status/${doc}/y/initial/_seed`), null));
    const peer = (liveEpoch) => ({ uid: MEMBER.uid, email: MEMBER.email, mode: "edit", liveEpoch, lastChanged: serverTimestamp() });
    await assertSucceeds(set(ref(db, `status/${doc}/peers/tab`), peer("initial")));
    await env.withSecurityRulesDisabled(async (ctx) => set(ref(ctx.database(), `editAccess/${doc}/__liveEpoch`), "next"));
    await assertFails(set(ref(db, `status/${doc}/y/initial/late`), "late"));
    await assertFails(set(ref(db, `status/${doc}/y/initial/delta`), null));
    await assertFails(set(ref(db, `status/${doc}/y/flat`), "legacy"));
    await assertFails(set(ref(db, `status/${doc}/peers/tab`), peer("initial")));
    await assertSucceeds(set(ref(db, `status/${doc}/peers/tab`), peer("next")));
    await assertSucceeds(set(ref(db, `status/${doc}/y/next/_seed`), "current"));
    await assertSucceeds(set(ref(db, `status/${doc}/y/initial`), null));
    const current = await assertSucceeds(get(ref(db, `status/${doc}/y/next/_seed`)));
    if (current.val() !== "current") throw new Error("old epoch retirement changed the new seed");
    await assertFails(set(ref(db, `status/${doc}/y`), null));
  });

  it("rejects an entry that is not a bounded string", async () => {
    const db = verified(env, MEMBER).database();
    await assertSucceeds(set(ref(db, "status/doc1/y/initial/boundary"), "x".repeat(2 * 1024 * 1024)));
    await assertFails(set(ref(db, "status/doc1/y/initial/e5"), { not: "a string" }));
    await assertFails(set(ref(db, "status/doc1/y/initial/e6"), "x".repeat(2 * 1024 * 1024 + 1)));
  });

  it("the withdrawn lock node is rejected outright", async () => {
    // The lock is gone (ADR 0010). A client still writing one is a client
    // running stale code, and `$other` is what makes that loud rather than
    // silently tolerated.
    const db = verified(env, MEMBER).database();
    await assertFails(
      set(ref(db, "status/doc1/lock"), {
        uid: MEMBER.uid,
        email: MEMBER.email,
        since: serverTimestamp(),
      }),
    );
  });

  it("a stranger cannot forge presence, a lock, or a request", async () => {
    const db = verified(env, STRANGER).database();
    await assertFails(
      set(ref(db, `status/doc1/peers/${STRANGER.uid}`), {
        email: STRANGER.email,
        mode: "view",
        lastChanged: serverTimestamp(),
      }),
    );
    await assertFails(
      set(ref(db, "status/doc1/lock"), {
        uid: STRANGER.uid,
        email: STRANGER.email,
        since: serverTimestamp(),
      }),
    );
    await assertFails(
      set(ref(db, `status/doc1/requests/${STRANGER.uid}`), {
        email: STRANGER.email,
        at: serverTimestamp(),
      }),
    );
  });

  it("everything outside the presence tree is denied", async () => {
    const db = verified(env, MEMBER).database();
    await assertFails(get(ref(db, "/")));
    await assertFails(set(ref(db, "anythingElse/x"), 1));
  });
});
