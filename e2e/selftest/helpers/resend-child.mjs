// SPDX-License-Identifier: Apache-2.0
// Child process for the shim self-test: imports the INSTALLED resend SDK fresh and sends once (SPEC §14).

/**
 * A separate process because the SDK reads RESEND_BASE_URL once, at import:
 * the only honest test of "the stack's env reaches the SDK" is a fresh import
 * under exactly that env.
 *
 * Every fetch is recorded, and any to a non-loopback host is REFUSED before it
 * leaves the process — so the negative case (no RESEND_BASE_URL, the SDK falls
 * back to Resend's real API) is observed without a single packet reaching it.
 *
 * argv[2]: path of functions/package.json to resolve `resend` from.
 * Prints one JSON line: {attempts, result, resolved}.
 */

import { createRequire } from "node:module";

const attempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  attempts.push(url.href);
  if (!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new Error(`self-test guard: refused a request to ${url.host}`);
  }
  return realFetch(input, init);
};

const require = createRequire(process.argv[2]);
const resolved = require.resolve("resend");
const { Resend } = require("resend");
const resend = new Resend(process.env.E2E_SELFTEST_KEY);
const result = await resend.emails.send({
  from: "Bikeshed E2E <noreply@e2e.bikeshed.invalid>",
  to: process.env.E2E_SELFTEST_TO,
  subject: process.env.E2E_SELFTEST_SUBJECT,
  html: "<p>self-test <b>html</b></p>",
  text: "self-test text",
});
process.stdout.write(JSON.stringify({ attempts, result, resolved }) + "\n");
