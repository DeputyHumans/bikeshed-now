// SPDX-License-Identifier: Apache-2.0
// Refute version, passage, body and refusal mistakes in historical feedback assertions (SPEC §6, §12).
import test from "node:test";
import assert from "node:assert/strict";
import { assertBrowserFeedback } from "../lib/feedback-oracles.mjs";
const sample = () => ({
  state: { current: "v2", threads: [{ annId: "a", version: "v1", anchor: { elementId: "p", exact: "old passage" }, bodies: ["historic body"] }] },
  answers: [{ what: "web thread", isError: false, json: { threadId: "a", version: "v1", expectedAnchor: { elementId: "p", exact: "old passage" }, expectedBody: "historic body" } }],
});
test("an old version's feedback is valid while a newer version is current", () => { const x = sample(); assertBrowserFeedback(x.state, x.answers); });
for (const [name, corrupt] of [
  ["refusal", x => { x.answers[0] = { what: "web thread", isError: true, text: "PERMISSION_DENIED" }; }],
  ["missing thread", x => { x.state.threads = []; }],
  ["redirected version", x => { x.state.threads[0].version = "v2"; }],
  ["changed passage", x => { x.state.threads[0].anchor.exact = "different passage"; }],
  ["lost body", x => { x.state.threads[0].bodies = []; }],
  ["rewritten body", x => { x.state.threads[0].bodies = ["rewritten"]; }],
]) test(`historical oracle rejects ${name}`, () => { const x = sample(); corrupt(x); assert.throws(() => assertBrowserFeedback(x.state, x.answers), assert.AssertionError); });

test("publication can refuse a browser write only with a rules denial", () => {
  const x = sample(); x.state.threads = [];
  x.answers = [{ what: "web thread", isError: true, text: "PERMISSION_DENIED" }];
  assertBrowserFeedback(x.state, x.answers, { allowRefused: true });
  x.answers[0].text = "service unavailable";
  assert.throws(() => assertBrowserFeedback(x.state, x.answers, { allowRefused: true }), /retired-version write is refused/);
});
