// SPDX-License-Identifier: Apache-2.0
// Self-test: the Admin SDK's own deadline on a Firestore call (gRPC DEADLINE_EXCEEDED) is the stack not answering, and nothing that merely says so is (SPEC §12).

/**
 * The error is a real one: the grpc-js module google-gax hands the Firestore
 * client (resolved from @google-cloud/firestore, so it is that very copy)
 * calls a local TCP server that accepts and never answers, with a 300 ms
 * deadline. A Firestore read through the SDK against the same server throws
 * the same shape (measured: code 4, "4 DEADLINE_EXCEEDED: Deadline exceeded
 * after 0.502s,Waiting for LB pick"), but only after its own retries, about
 * 50 s, so the self-test calls the gRPC layer itself. google-gax's
 * total-timeout errors are built with its own GoogleError, as it builds them.
 */

import { after, before, test } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { onAnsweringStack, stackDidNotAnswer } from "../lib/test.mjs";

const here = createRequire(import.meta.url);
const gax = createRequire(here.resolve("@google-cloud/firestore/package.json"))("google-gax");
const LEAD = "the stack did not answer, so nothing was measured: ";
const WHY = "a Firestore call through the Admin SDK got no answer within its deadline: ";

let server;
const sockets = new Set();

before(async () => {
  server = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});

after(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

/** A real grpc-js DEADLINE_EXCEEDED: a unary call to a server that never answers. */
async function realDeadline(ms = 300) {
  const client = new gax.grpc.Client(`127.0.0.1:${server.address().port}`, gax.grpc.credentials.createInsecure());
  try {
    return await new Promise((resolve) =>
      client.makeUnaryRequest("/google.firestore.v1.Firestore/GetDocument", (x) => x, (x) => x, Buffer.alloc(0), { deadline: Date.now() + ms }, (err) => resolve(err)),
    );
  } finally {
    client.close();
  }
}

/** google-gax's own total-timeout error, built as normalCalls/retries.js and streamingCalls/streaming.js build it. */
function gaxTimeout(message) {
  const err = new gax.GoogleError(message);
  err.code = gax.Status.DEADLINE_EXCEEDED;
  return err;
}

test("a real gRPC DEADLINE_EXCEEDED from the Admin SDK's own grpc-js is the stack not answering, named by its first line", async () => {
  const err = await realDeadline();
  assert.equal(err.code, 4, "gRPC's DEADLINE_EXCEEDED");
  assert.match(err.message, /^4 DEADLINE_EXCEEDED: Deadline exceeded after /);
  const why = stackDidNotAnswer(err);
  assert.equal(why, `${WHY}${err.message.split("\n")[0]}`);

  for (const message of [
    "Total timeout of API google.firestore.v1.Firestore exceeded 60000 milliseconds  before any response was received.",
    "Total timeout of API exceeded 300000 milliseconds retrying error Error: 14 UNAVAILABLE: No connection established  before any response was received.",
  ]) {
    assert.equal(stackDidNotAnswer(gaxTimeout(message)), `${WHY}${message}`, message.slice(0, 40));
  }
  const long = Object.assign(new Error(`4 DEADLINE_EXCEEDED: ${"x".repeat(400)}\nsecond line`), { code: 4 });
  assert.equal(stackDidNotAnswer(long), `${WHY}${long.message.split("\n")[0].slice(0, 240)}`, "one line, at most 240 characters");
});

test("NEGATIVE: the code without the words, the words without the code, a retry count, an assertion and the product's own words are not", async () => {
  const real = await realDeadline();
  const shaped = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
  assert.equal(stackDidNotAnswer(shaped(4, "something else entirely")), null, "code 4 alone");
  assert.equal(stackDidNotAnswer(shaped("4", real.message)), null, "a string code is not gRPC's");
  assert.equal(stackDidNotAnswer(shaped(undefined, real.message)), null, "the words alone");
  assert.equal(stackDidNotAnswer(gaxTimeout("Exceeded maximum number of retries retrying error Error: 14 UNAVAILABLE: x before any response was received")), null, "gax's retry count, not a deadline");
  assert.equal(stackDidNotAnswer(gaxTimeout(`Exceeded maximum number of retries retrying error Error: ${real.message} before any response was received`)), null, "the retry count quoting a deadline: the words must open the message");
  assert.equal(stackDidNotAnswer(shaped(14, "14 UNAVAILABLE: No connection established")), null, "another gRPC status");
  assert.equal(stackDidNotAnswer(shaped("E2E_MCP_TOOL", `MCP get_comments failed: ${real.message}`)), null, "the product's tool error quoting it: the product answered");
  assert.equal(stackDidNotAnswer(shaped("E2E_STATUS", `POST /mcp: expected 200, got 500: ${real.message}`, { response: { status: 500, ms: 61_000 } })), null, "a 500 whose body says so");
  assert.equal(stackDidNotAnswer(new AssertionError({ message: real.message })), null, "an assertion, whatever its message");
  assert.equal(stackDidNotAnswer(Object.assign(new AssertionError({ message: real.message }), { code: 4 })), null, "an assertion that carries the code and the words is still the spec's");
  assert.equal(stackDidNotAnswer(shaped("E2E_PRECONDITION", `precondition: ${real.message}`)), null);
});

test("onAnsweringStack ends a case INCONCLUSIVE on it, also as a known defect's oracle's cause, and keeps the error", async () => {
  const real = await realDeadline();
  const texts = {};
  const ctx = { ev: { text: (n, v) => (texts[n] = v), step() {} } };
  const inc = await onAnsweringStack(async () => {
    throw real;
  })(ctx).then(() => assert.fail("expected INCONCLUSIVE"), (e) => e);
  assert.equal(inc.code, "E2E_INCONCLUSIVE");
  assert.equal(inc.reason, `${LEAD}${WHY}${real.message.split("\n")[0]}`);
  assert.equal(inc.cause, real);
  assert.match(texts["stack-did-not-answer.txt"], /4 DEADLINE_EXCEEDED/);

  const oracle = Object.assign(new Error(real.message, { cause: real }), { code: "E2E_DEFECT_ORACLE" });
  assert.equal(stackDidNotAnswer(oracle), `${WHY}${real.message.split("\n")[0]}`, "a known defect's oracle that got no answer did not fail as expected");
  const words = new Error(`assert: ${real.message}`);
  assert.equal(await onAnsweringStack(async () => {
    throw words;
  })(ctx).then(() => null, (e) => e), words, "anything else is rethrown as it was");
});
