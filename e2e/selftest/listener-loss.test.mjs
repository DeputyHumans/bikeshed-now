// SPDX-License-Identifier: Apache-2.0
// Earlier and recovered listener errors never hide a failed role-change oracle (SPEC §12, §13).
import test from "node:test";
import assert from "node:assert/strict";
import { unrecoveredListenerLoss } from "../lib/listener-loss.mjs";
const lost = (t) => ({ t, text: "Could not reach Cloud Firestore backend" });
const answered = (at, status = 200) => ({ at, status, path: "/google.firestore.v1.Firestore/Listen/channel" });
const user = (console = [], responses = [], sdkProbes = []) => ({ log: { console, sdkProbes }, responses });
test("only a new outage after the write starts can excuse the role-change wait", () => {
  assert.equal(unrecoveredListenerLoss(user([lost(99)]), 100), null);
  assert.deepEqual(unrecoveredListenerLoss(user([lost(110)]), 100), { since: 100, lastFault: 110, signs: 1 });
  assert.deepEqual(unrecoveredListenerLoss(user([], [], [{ t: 120 }]), 100), { since: 100, lastFault: 120, signs: 1 });
});
test("a later successful Listen response invalidates the outage excuse", () => {
  assert.equal(unrecoveredListenerLoss(user([lost(110)], [answered(120)]), 100), null);
  assert.ok(unrecoveredListenerLoss(user([lost(110)], [answered(105)]), 100));
  assert.ok(unrecoveredListenerLoss(user([lost(110)], [{ ...answered(120), path: "/config" }]), 100));
  assert.ok(unrecoveredListenerLoss(user([lost(110)], [answered(120, 503)]), 100));
});
test("an outage after recovery is a new missing observation", () => {
  assert.deepEqual(unrecoveredListenerLoss(user([lost(110), lost(140)], [answered(120)]), 100), { since: 100, lastFault: 140, signs: 2 });
});
