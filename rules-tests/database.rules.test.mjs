// SPDX-License-Identifier: Apache-2.0
// Presence is gated by a server-maintained mirror, not by the identity gate (SPEC §16).

import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { ref, get, set, serverTimestamp } from "firebase/database";

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
    await assertSucceeds(get(ref(db, "status/doc1")));
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
    await assertSucceeds(set(ref(db, "status/doc1/y/e1"), "AQIDBA=="));
  });

  it("a READ-ONLY member may not, which is the escalation this gate exists for", async () => {
    // OTHER is in `presenceAccess` and may watch the document, but is not in
    // `editAccess`. Gating document state on the presence mirror would let them
    // push content into an editor's browser, which that editor then autosaves
    // and publishes: read escalated to write through a channel nobody audits.
    const db = verified(env, OTHER).database();
    await assertFails(set(ref(db, "status/doc1/y/e2"), "AQIDBA=="));
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
    await assertSucceeds(set(ref(db, "status/doc2/y/e1"), "AQIDBA=="));
  });

  it("a stranger may neither read nor write the shared document", async () => {
    const db = verified(env, STRANGER).database();
    await assertFails(get(ref(db, "status/doc1/y")));
    await assertFails(set(ref(db, "status/doc1/y/e3"), "AQIDBA=="));
  });

  it("an editor may remove entries, because compaction has to", async () => {
    const db = verified(env, MEMBER).database();
    await assertSucceeds(set(ref(db, "status/doc1/y/e4"), "AQIDBA=="));
    await assertSucceeds(set(ref(db, "status/doc1/y/e4"), null));
  });

  it("rejects an entry that is not a bounded string", async () => {
    const db = verified(env, MEMBER).database();
    await assertFails(set(ref(db, "status/doc1/y/e5"), { not: "a string" }));
    await assertFails(set(ref(db, "status/doc1/y/e6"), "x".repeat(200_001)));
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
