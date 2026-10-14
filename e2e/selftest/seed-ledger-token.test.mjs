// SPDX-License-Identifier: Apache-2.0
// Self-test: ledgerToken records a token minted outside mintToken (the CLI's browser login, the account page) as mintToken's own row, and never the token (SPEC §12, §23).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHttp } from "../lib/http.mjs";
import { ledgerFile, readLedger } from "../lib/ledger.mjs";
import { mintToken } from "../lib/session.mjs";
import { TOKEN_CHANNELS, ledgerToken } from "../lib/seed.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PORT = 39031;
const local = () => Object.freeze({ kind: "local", runId: "2610121200-ltok", origin: `http://127.0.0.1:${PORT}`, runDir: tempDir("e2e-ledger-token-"), stack: { ports: { hosting: PORT } } });
const allowAll = { check: async () => ({ allow: true }) };
const UID = "aBcD1234eFgH5678iJkL9012mNoP";
const ID = "0123456789abcdef0123456789abcdef";
const rowsOf = (t) => readLedger(t).filter((r) => r.kind === "token").map(({ t: _t, runId: _r, ...row }) => row);

test("ledgerToken: mintToken's row, field for field and in its order, plus via when given; twice is two rows", async () => {
  const t = local();
  // mintToken against a fake server, for the row it writes.
  const minted = "fedcba9876543210fedcba9876543210";
  const fetch = async () => new Response(JSON.stringify({ tokenId: minted, token: `bsk_${minted}.${"s".repeat(43)}` }), { status: 200, headers: { "content-type": "application/json" } });
  const session = { http: createHttp(t, { actor: "owner", evidence: false, guard: allowAll, fetch }), uid: UID, account: { role: "owner" } };
  await mintToken(session, { name: "e2e owner", channel: "mcp" });
  const viaMint = rowsOf(t).at(-1);

  const row = ledgerToken(t, { tokenId: ID, uid: UID, channel: "cli", name: "CLI on host" });
  assert.deepEqual(row, { kind: "token", tokenId: ID, uid: UID, channel: "cli", name: "CLI on host" });
  assert.deepEqual(viaMint, { kind: "token", tokenId: minted, uid: UID, channel: "mcp", name: "e2e owner" }, "mintToken's own row");
  assert.deepEqual(Object.keys(row), Object.keys(viaMint), "mintToken's fields, in its order");
  assert.deepEqual(rowsOf(t).at(-1), row, "the row as written");
  assert.equal(readLedger(t).at(-1).runId, t.runId);

  const withVia = ledgerToken(t, { tokenId: ID, uid: UID, channel: "mcp", name: "", via: "account-ui" });
  assert.deepEqual(withVia, { kind: "token", tokenId: ID, uid: UID, channel: "mcp", name: "", via: "account-ui" }, "an empty name is a name");
  assert.deepEqual(ledgerToken(t, { tokenId: ID, uid: UID, channel: "api" }).name, null, "no name is null");
  assert.equal(rowsOf(t).filter((r) => r.tokenId === ID).length, 3);
  assert.deepEqual(TOKEN_CHANNELS, ["cli", "mcp", "api"]);
  assert.ok(Object.isFrozen(TOKEN_CHANNELS));
});

test("NEGATIVE: ledgerToken refuses the whole token without repeating it, a path for an id, an unknown channel or field, and writes nothing", () => {
  const t = local();
  const secret = "sEcReT".repeat(7);
  const whole = `bsk_${ID}.${secret}`;
  const bad = [
    [{ tokenId: whole, uid: UID, channel: "cli" }, /tokenId is the whole token, secret included/],
    [{ tokenId: `bsa_${ID}.${secret}`, uid: UID, channel: "cli" }, /the whole token/],
    [{ tokenId: ID.toUpperCase(), uid: UID, channel: "cli" }, /tokenId is a token's id as the product makes them \(32 lowercase hex digits\), got a string of 32 characters/],
    [{ tokenId: `${ID}0`, uid: UID, channel: "cli" }, /tokenId is a token's id/],
    [{ tokenId: `/tokens/${ID}`, uid: UID, channel: "cli" }, /tokenId is a token's id/],
    [{ tokenId: undefined, uid: UID, channel: "cli" }, /tokenId is a token's id/],
    [{ tokenId: { tokenId: ID }, uid: UID, channel: "cli" }, /tokenId is a token's id/],
    [{ tokenId: ID, uid: "", channel: "cli" }, /uid is the account's uid/],
    [{ tokenId: ID, uid: "users/abc", channel: "cli" }, /uid is the account's uid/],
    [{ tokenId: ID, uid: "a b", channel: "cli" }, /uid is the account's uid/],
    [{ tokenId: ID, uid: UID, channel: "web" }, /channel is one of cli, mcp, api, got "web"/],
    [{ tokenId: ID, uid: UID }, /channel is one of/],
    [{ tokenId: ID, uid: UID, channel: "cli", name: 7 }, /name is a string or null/],
    [{ tokenId: ID, uid: UID, channel: "cli", via: "" }, /via says how the token was made/],
    [{ tokenId: ID, uid: UID, channel: "cli", via: null }, /via says how the token was made/],
    [{ tokenId: ID, uid: UID, channel: "cli", token: whole }, /unknown field "token".*a row never carries the token itself/],
    [{ tokenId: ID, uid: UID, channel: "cli", owner: "x" }, /unknown field "owner"/],
  ];
  for (const [o, re] of bad) {
    let err = null;
    try {
      ledgerToken(t, o);
    } catch (e) {
      err = e;
    }
    assert.ok(err, `refused: ${JSON.stringify({ ...o, tokenId: typeof o.tokenId === "string" ? `${o.tokenId.slice(0, 8)}…` : o.tokenId, token: o.token ? "…" : undefined })}`);
    assert.match(err.message, re);
    assert.ok(!err.message.includes(secret), "the secret is never repeated");
  }
  assert.throws(() => ledgerToken(t, null), /give \{tokenId, uid, channel, name\?, via\?\}/);
  assert.throws(() => ledgerToken({}, { tokenId: ID, uid: UID, channel: "cli" }), /target is a Target with a runDir/);
  assert.equal(existsSync(ledgerFile(t)) ? readFileSync(ledgerFile(t), "utf8") : "", "", "nothing was written");
});
