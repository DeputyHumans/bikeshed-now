// SPDX-License-Identifier: Apache-2.0
// Self-test: account names, derived passwords, production slots, and a ledger that never holds a secret (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimProdSlot, localEmail, passwordFor, prodEmail, runTag } from "../lib/accounts.mjs";
import { appendLedger, ledgerAccounts, ledgerDocIds, readLedger } from "../lib/ledger.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const target = () => ({ kind: "local", runId: "2610101200-acct", runDir: tempDir("e2e-acct-") });

test("runTag: six characters from the run id", () => {
  assert.equal(runTag("2610101804-mdzp"), "04mdzp");
  assert.throws(() => runTag("ab"));
});

test("emails: <role>-<run6>-<rand4>@example.com locally; e2e-<run6>-u<NN>@<domain> on production", () => {
  const t = target();
  assert.match(localEmail(t, "Owner"), /^owner-00acct-[a-z0-9]{4}@example\.com$/);
  assert.match(localEmail(t, "co-editor 2"), /^coeditor2-00acct-[a-z0-9]{4}@example\.com$/);
  assert.equal(prodEmail(t, "u07"), "e2e-00acct-u07@bikeshed-e2e.invalid");
  process.env.E2E_PROD_EMAIL_DOMAIN = "not a domain";
  try {
    assert.throws(() => prodEmail(t, "u01"));
  } finally {
    delete process.env.E2E_PROD_EMAIL_DOMAIN;
  }
});

test("passwordFor: deterministic per secret and email, strong, and different across emails", () => {
  const a = passwordFor("a@example.com");
  assert.equal(passwordFor("A@Example.com"), a, "case-insensitive in the email");
  assert.notEqual(passwordFor("b@example.com"), a);
  assert.match(a, /^[A-Za-z0-9_-]{24}Aa1!$/);
});

test("passwordFor with E2E_RUN_SECRET is reproducible in another process", async () => {
  const secret = "s".repeat(32);
  const child = (email) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", `import { passwordFor } from ${JSON.stringify(fileURLToPath(new URL("../lib/accounts.mjs", import.meta.url)))}; process.stdout.write(passwordFor(${JSON.stringify(email)}));`], { env: { ...process.env, E2E_RUN_SECRET: secret } });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.on("close", () => resolve(out));
    });
  const [one, two] = await Promise.all([child("x@example.com"), child("x@example.com")]);
  assert.equal(one, two);
  assert.match(one, /Aa1!$/);
});

test("claimProdSlot: u01, u02, … and never the same slot twice, even in parallel", async () => {
  const t = target();
  assert.equal(claimProdSlot(t), "u01");
  assert.equal(claimProdSlot(t), "u02");
  const rest = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => claimProdSlot(t))));
  assert.equal(new Set(rest).size, 20);
});

test("ledger: rows append and read back; a credential-shaped row is refused", () => {
  const t = target();
  appendLedger(t, { kind: "account", role: "owner", email: "Owner@Example.com", uid: "u1", tier: "local" });
  appendLedger(t, { kind: "doc", docId: "e2e-x-doc-abcd", ownerEmail: "owner@example.com", via: "upload" });
  assert.equal(readLedger(t).length, 2);
  assert.deepEqual([...ledgerDocIds(t)], ["e2e-x-doc-abcd"]);
  assert.equal(ledgerAccounts(t).get("owner@example.com").uid, "u1");
  assert.throws(() => appendLedger(t, { kind: "account", email: "a@b.c", password: "p" }), /never carries password/);
  assert.throws(() => appendLedger(t, { kind: "token", tokenId: "t", note: `bsk_${"a".repeat(32)}.secret` }), /credential/);
  assert.throws(() => appendLedger(t, { kind: "nope" }), /unknown kind/);
  assert.equal(readLedger(t).length, 2, "refused rows were not written");
});
