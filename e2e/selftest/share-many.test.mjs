// SPDX-License-Identifier: Apache-2.0
// Self-test: shareMany sends several grants in ONE POST /access, in share()'s shapes, ledgers each principal on a 200 only, reads each mirror, and runs locally only (SPEC §12, §16, §18).

/**
 * Through http.mjs with a fake fetch standing in for the server, as
 * folder-grants.test.mjs does; the mirrors through a stand-in for
 * lib/admin.mjs's reads, so no emulator is needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHttp } from "../lib/http.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { share, shareMany } from "../lib/grant.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const OWNER = "owner-0many-abcd@example.com";
const DOC = "e2e-0many-doc-abcd";
const local = () => Object.freeze({ kind: "local", runId: "2610121300-many", runDir: tempDir("e2e-many-"), origin: "http://127.0.0.1:39223", stack: { ports: { hosting: 39223 } } });
const prod = () => Object.freeze({ kind: "prod", runId: "2610121300-many", origin: "https://share-many-selftest.invalid", runDir: tempDir("e2e-many-prod-") });

/** Answers each request with `answer(body)` → {status, json}; records every request. */
function server(answer = () => ({})) {
  const sent = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ path: new URL(url).pathname, body });
    const { status = 200, json = { members: [OWNER, ...(body.add ?? []).map((a) => a.email ?? a.principal)] } } = answer(body) ?? {};
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

/** A fetch that never answers: it waits for the request's own abort. */
function silent() {
  const sent = [];
  const fetch = (url, init) =>
    new Promise((_, reject) => {
      sent.push(new URL(url).pathname);
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  return { sent, fetch };
}

const ownerOf = (t, fetch) => ({ account: { email: OWNER }, http: createHttp(t, { actor: "owner", evidence: false, fetch }) });
const grants = (t) => readLedger(t).filter((r) => r.kind === "grant").map(({ t: _t, runId: _r, ...row }) => row);
const findings = (t) => {
  const f = join(t.runDir, "findings.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

test("shareMany: ONE POST /access {docId, add: [...]} in the order given, each as share() sends it; one ledger row per principal", async () => {
  const t = local();
  const s = server();
  const owner = ownerOf(t, s.fetch);
  const team = { status: 200, teamId: "TeAm_9x-Q", name: "A team" };
  const r = await shareMany(t, {
    owner,
    doc: { docId: DOC },
    grants: [
      { account: { email: "Editor-0many@Example.com" }, role: "editor" },
      { account: "viewer-0many@example.com" },
      { team, role: "suggester" },
      { account: "team:TeAm_9x-Q", role: "approver" },
    ],
    verify: false,
  });
  assert.deepEqual(s.sent, [{
    path: "/access",
    body: { docId: DOC, add: [
      { email: "editor-0many@example.com", role: "editor" },
      { email: "viewer-0many@example.com", role: "viewer" },
      { principal: "team:TeAm_9x-Q", role: "suggester" },
      { principal: "team:TeAm_9x-Q", role: "approver" },
    ] },
  }], "one request, every add in it, a person lower-cased, a team's id with its case");
  assert.equal(r.status, 200);
  assert.deepEqual(r.principals, ["editor-0many@example.com", "viewer-0many@example.com", "team:TeAm_9x-Q", "team:TeAm_9x-Q"]);
  assert.deepEqual(r.members, [OWNER, "editor-0many@example.com", "viewer-0many@example.com", "team:TeAm_9x-Q", "team:TeAm_9x-Q"]);
  assert.equal(r.mirrors, null, "not verified");
  assert.equal(r.response.status, 200);
  assert.deepEqual(grants(t), [
    { kind: "grant", docId: DOC, email: "editor-0many@example.com", role: "editor", via: "access" },
    { kind: "grant", docId: DOC, email: "viewer-0many@example.com", role: "viewer", via: "access" },
    { kind: "grant", docId: DOC, email: "team:TeAm_9x-Q", role: "suggester", via: "access" },
    { kind: "grant", docId: DOC, email: "team:TeAm_9x-Q", role: "approver", via: "access" },
  ]);

  // share() of one grant sends what shareMany sends for it, and ledgers the same row.
  const s2 = server();
  const t2 = local();
  await share(t2, { owner: ownerOf(t2, s2.fetch), doc: DOC, account: "Viewer-0many@example.com", verify: false });
  await shareMany(t2, { owner: ownerOf(t2, s2.fetch), doc: DOC, grants: [{ account: "Viewer-0many@example.com" }], verify: false });
  assert.deepEqual(s2.sent[0], s2.sent[1], "the same body as share()");
  assert.deepEqual(grants(t2)[0], grants(t2)[1], "the same ledger row as share()");
});

test("shareMany verifies each grant's mirror as share() does, and records a missing one without throwing", async () => {
  const t = local();
  const s = server();
  const key = (e) => e.replace(/\./g, ",");
  const rtdb = new Map([
    [`presenceAccess/${DOC}/${key("ed-0many@example.com")}`, true],
    [`editAccess/${DOC}/${key("ed-0many@example.com")}`, true],
    [`presenceAccess/${DOC}/${key("member-0many@example.com")}`, true],
    // gone-0many has no mirror at all
  ]);
  const admin = {
    emailKey: key,
    rtdbGet: async (_t, path) => rtdb.get(path) ?? null,
    readDoc: async (_t, path) => (path === "teams/T1" ? { members: ["Member-0many@example.com"] } : null),
  };
  const r = await shareMany(t, { owner: ownerOf(t, s.fetch), doc: DOC, admin, grants: [{ account: "ed-0many@example.com", role: "editor" }, { account: "gone-0many@example.com" }, { team: "T1" }] });
  assert.equal(r.mirrors.length, 3);
  assert.deepEqual(r.mirrors[0], { presence: true, edit: true, expectEdit: true, ok: true });
  assert.deepEqual(r.mirrors[1], { presence: false, edit: false, expectEdit: false, ok: false });
  assert.equal(r.mirrors[2].teamId, "T1");
  assert.equal(r.mirrors[2].ok, true, "the team's member is in presenceAccess");
  assert.deepEqual(findings(t).map((f) => [f.kind, f.suspect, f.email, f.role, f.via]), [["mirror-missing", "S16", "gone-0many@example.com", "viewer", "POST /access"]]);
});

test("NEGATIVE: only a 200 is ledgered: a 200 `expect` refused is ledgered and thrown; a refusal, a cut-off and no answer are not", async () => {
  const t = local();
  const refusedOk = await rejection(shareMany(t, { owner: ownerOf(t, server().fetch), doc: DOC, grants: [{ account: "a-0many@example.com" }, { account: "b-0many@example.com" }], expect: 201, verify: false }));
  assert.equal(refusedOk.code, "E2E_STATUS");
  assert.deepEqual(grants(t).map((g) => g.email), ["a-0many@example.com", "b-0many@example.com"], "granted, though the case did not expect it");

  const t2 = local();
  const no = await shareMany(t2, { owner: ownerOf(t2, server(() => ({ status: 403, json: { error: "forbidden" } })).fetch), doc: DOC, grants: [{ account: "c-0many@example.com" }], expect: null, verify: true });
  assert.deepEqual([no.status, no.members, no.mirrors], [403, null, null], "expect: null returns any status; a refusal reads no mirror");
  const cut = await rejection(shareMany(t2, { owner: ownerOf(t2, server(() => ({ status: 504, json: { error: "Timed out waiting for function to respond." } })).fetch), doc: DOC, grants: [{ account: "d-0many@example.com" }] }));
  assert.equal(cut.code, "E2E_STATUS");
  assert.equal(cut.response.status, 504, "the error carries the answer, for stackDidNotAnswer to judge");
  const silence = silent();
  const late = await rejection(shareMany(t2, { owner: ownerOf(t2, silence.fetch), doc: DOC, grants: [{ account: "e-0many@example.com" }], timeoutMs: 150 }));
  assert.equal(late.message, "timeout after 150 ms", "timeoutMs reaches the request");
  assert.deepEqual(silence.sent, ["/access"]);
  assert.deepEqual(grants(t2), [], "nothing but a 200 is ledgered");
});

test("NEGATIVE: production, a malformed grant or no owner throws before anything is sent", async () => {
  const s = server();
  const p = prod();
  const onProd = await rejection(shareMany(p, { owner: ownerOf(local(), s.fetch), doc: DOC, grants: [{ account: "v-0many@example.com" }] }));
  assert.equal(onProd.code, "E2E_LOCAL_ONLY");
  assert.match(onProd.message, /^shareMany: local only — several grants in ONE request exist only as POST \/access/);
  assert.deepEqual(grants(p), []);

  const t = local();
  const owner = ownerOf(t, s.fetch);
  const bad = [
    [undefined, /grants is a non-empty list/],
    [[], /grants is a non-empty list/],
    ["v@example.com", /grants is a non-empty list/],
    [[null], /grant 1 is \{account \| team, role\}/],
    [[{ account: "ok-0many@example.com" }, ["x"]], /grant 2 is \{account \| team, role\}/],
    [[{ role: "viewer" }], /grant 1 names no account or team/],
    [[{ account: "ok-0many@example.com", role: "owner" }], /grant 1: role must be one of viewer, suggester, editor, approver, got "owner"/],
    [[{ account: "ok-0many@example.com", team: "T1" }], /grant 1: give an account or a team, not both/],
    [[{ account: "ok-0many@example.com" }, { team: "bad id" }], /grant 2: a team is a team id/],
  ];
  for (const [g, re] of bad) await assert.rejects(shareMany(t, { owner, doc: DOC, grants: g, verify: false }), re, JSON.stringify(g));
  await assert.rejects(shareMany(t, { doc: DOC, grants: [{ account: "ok-0many@example.com" }], verify: false }), /the owner's session \(with its http client\) is required/);
  await assert.rejects(shareMany(t, { owner, grants: [{ account: "ok-0many@example.com" }], verify: false }), /a document id is required/);
  assert.deepEqual(s.sent, [], "nothing was sent");
  assert.deepEqual(grants(t), []);
});

test("a principal named twice is sent twice, as given, and ledgered twice", async () => {
  const t = local();
  const s = server();
  await shareMany(t, { owner: ownerOf(t, s.fetch), doc: DOC, grants: [{ account: "twice-0many@example.com" }, { account: "TWICE-0many@example.com", role: "editor" }], verify: false });
  assert.deepEqual(s.sent[0].body.add, [{ email: "twice-0many@example.com", role: "viewer" }, { email: "twice-0many@example.com", role: "editor" }]);
  assert.deepEqual(grants(t).map((g) => [g.email, g.role]), [["twice-0many@example.com", "viewer"], ["twice-0many@example.com", "editor"]]);
});
