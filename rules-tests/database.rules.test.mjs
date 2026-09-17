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

  it("the edit lock is claimed by its holder and cannot be stolen while held", async () => {
    const mine = verified(env, MEMBER).database();
    await assertSucceeds(
      set(ref(mine, "status/doc1/lock"), {
        uid: MEMBER.uid,
        email: MEMBER.email,
        since: serverTimestamp(),
      }),
    );
    const theirs = verified(env, OTHER).database();
    await assertFails(
      set(ref(theirs, "status/doc1/lock"), {
        uid: OTHER.uid,
        email: OTHER.email,
        since: serverTimestamp(),
      }),
    );
    await assertSucceeds(set(ref(mine, "status/doc1/lock"), null));
  });

  it("a lock cannot be claimed on behalf of somebody else", async () => {
    const db = verified(env, MEMBER).database();
    await assertFails(
      set(ref(db, "status/doc1/lock"), {
        uid: OTHER.uid,
        email: OTHER.email,
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
