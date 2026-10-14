// SPDX-License-Identifier: Apache-2.0
// Self-test: share() and unshare() grant a TEAM as the product names it, team:<id> with its case kept, ledgered like any grant, and a team grant's mirror is read for every member (SPEC §12, §16, §18).

/**
 * Through http.mjs with a fake fetch standing in for the server, as
 * folder-grants.test.mjs does; readTeamMirror with a stand-in for
 * lib/admin.mjs, so no emulator is needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { readTeamMirror, share, unshare } from "../lib/grant.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const OWNER = "owner-0team-abcd@example.com";
const DOC = "e2e-0team-doc-abcd";
const local = () => Object.freeze({ kind: "local", runId: "2610111200-team", runDir: tempDir("e2e-team-"), origin: "http://127.0.0.1:39123", stack: { ports: { hosting: 39123 } } });

function server() {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ members: [OWNER] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}
const ownerOf = (t, fetch) => ({ account: { email: OWNER }, http: createHttp(t, { actor: "owner", evidence: false, fetch }) });
const grants = (t) => readLedger(t).filter((r) => r.kind === "grant").map(({ t: _t, runId: _r, ...row }) => row);

test("share({team}): POST /access {docId, add: [{principal: \"team:<id>\", role}]}, the id's case kept, by id, by `team:<id>` or by a createTeam result; ledgered as the principal", async () => {
  const t = local();
  const s = server();
  const owner = ownerOf(t, s.fetch);
  const created = { status: 200, teamId: "TeAm_9x-Q", name: "A team" };
  await share(t, { owner, doc: DOC, team: "TeAm_9x-Q", role: "viewer", verify: false });
  await share(t, { owner, doc: { docId: DOC }, team: "team:TeAm_9x-Q", role: "editor", verify: false });
  await share(t, { owner, doc: DOC, team: created, role: "suggester", verify: false });
  await share(t, { owner, doc: DOC, account: created, role: "approver", verify: false });
  await share(t, { owner, doc: DOC, account: "team:TeAm_9x-Q", role: "viewer", verify: false });
  const add = (role) => ({ path: "/access", body: { docId: DOC, add: [{ principal: "team:TeAm_9x-Q", role }] } });
  assert.deepEqual(s.sent, [add("viewer"), add("editor"), add("suggester"), add("approver"), add("viewer")]);
  assert.deepEqual(grants(t).map((g) => [g.email, g.role, g.via]), [
    ["team:TeAm_9x-Q", "viewer", "access"], ["team:TeAm_9x-Q", "editor", "access"], ["team:TeAm_9x-Q", "suggester", "access"],
    ["team:TeAm_9x-Q", "approver", "access"], ["team:TeAm_9x-Q", "viewer", "access"],
  ]);
  await unshare(t, { owner, doc: DOC, team: created });
  await unshare(t, { owner, doc: DOC, account: "team:TeAm_9x-Q" });
  assert.deepEqual(s.sent.slice(5), [
    { path: "/access", body: { docId: DOC, remove: ["team:TeAm_9x-Q"] } },
    { path: "/access", body: { docId: DOC, remove: ["team:TeAm_9x-Q"] } },
  ]);
});

test("a person is sent exactly as before: {email, role}, lower-cased", async () => {
  const t = local();
  const s = server();
  const owner = ownerOf(t, s.fetch);
  await share(t, { owner, doc: DOC, account: { email: "Viewer-0team@Example.com" }, role: "viewer", verify: false });
  await share(t, { owner, doc: DOC, account: "Second-0team@Example.com", role: "editor", verify: false });
  await unshare(t, { owner, doc: DOC, account: "Second-0team@Example.com" });
  assert.deepEqual(s.sent.map((x) => x.body), [
    { docId: DOC, add: [{ email: "viewer-0team@example.com", role: "viewer" }] },
    { docId: DOC, add: [{ email: "second-0team@example.com", role: "editor" }] },
    { docId: DOC, remove: ["second-0team@example.com"] },
  ]);
});

test("NEGATIVE: an account AND a team, a team id the product refuses, or a team with no id throws before anything is sent", async () => {
  const t = local();
  const s = server();
  const owner = ownerOf(t, s.fetch);
  await assert.rejects(share(t, { owner, doc: DOC, account: "v@example.com", team: "T1", verify: false }), /give an account or a team, not both/);
  for (const team of ["bad id", "team:", "", "x".repeat(65), "a/b", { teamId: "" }, { teamId: 7 }]) {
    await assert.rejects(share(t, { owner, doc: DOC, team, verify: false }), /a team is a team id, "team:<id>" or a createTeam result/, JSON.stringify(team));
  }
  await assert.rejects(unshare(t, { owner, doc: DOC, team: "bad id" }), /unshare: a team is a team id/);
  await assert.rejects(share(t, { owner, doc: DOC, account: "team:no good", verify: false }), /a team is a team id/, "an account that is a bad team ref is refused too, never sent as an email");
  assert.deepEqual(s.sent, []);
  assert.deepEqual(grants(t), []);
});

/** A stand-in for lib/admin.mjs: a team record and the two RTDB mirrors. */
function fakeAdmin({ members, presence = [], edit = [] }) {
  const key = (e) => e.replace(/\./g, ",");
  return {
    emailKey: key,
    readDoc: async (_t, path) => (path === "teams/TeAm1" && members ? { teamId: "TeAm1", members } : null),
    rtdbGet: async (_t, path) => {
      const [root, , k] = path.split("/");
      const list = root === "presenceAccess" ? presence : root === "editAccess" ? edit : [];
      return list.map(key).includes(k) ? true : null;
    },
  };
}

test("readTeamMirror: every member must be present; an editing role needs every member's edit mirror; a viewer's edit is not judged", async () => {
  const t = local();
  const A = "a-0team@example.com";
  const B = "b-0team@example.com";
  const all = fakeAdmin({ members: [A, B], presence: [A, B], edit: [A] });
  const viewer = await readTeamMirror(t, DOC, "TeAm1", "viewer", { admin: all });
  assert.deepEqual(viewer, {
    teamId: "TeAm1",
    found: true,
    members: [
      { email: A, presence: true, edit: true, expectEdit: null, ok: true },
      { email: B, presence: true, edit: false, expectEdit: null, ok: true },
    ],
    ok: true,
  }, "A edits through another grant (the owner); B does not; neither is judged for a viewer grant");
  const editor = await readTeamMirror(t, DOC, { teamId: "TeAm1" }, "editor", { admin: all });
  assert.deepEqual(editor.members.map((m) => [m.email, m.expectEdit, m.ok]), [[A, true, true], [B, true, false]]);
  assert.equal(editor.ok, false, "NEGATIVE: an editor grant whose member has no edit mirror");
  const missing = await readTeamMirror(t, DOC, "team:TeAm1", "viewer", { admin: fakeAdmin({ members: [A, B], presence: [A] }) });
  assert.deepEqual([missing.ok, missing.members.map((m) => m.ok)], [false, [true, false]], "NEGATIVE: a member missing from presenceAccess");
  const gone = await readTeamMirror(t, DOC, "TeAm1", "viewer", { admin: fakeAdmin({ members: null }) });
  assert.deepEqual(gone, { teamId: "TeAm1", found: false, members: [], ok: false }, "NEGATIVE: no team record");
  const empty = await readTeamMirror(t, DOC, "TeAm1", "viewer", { admin: fakeAdmin({ members: [] }) });
  assert.equal(empty.ok, false, "NEGATIVE: a record that names nobody proves nothing");
  await assert.rejects(readTeamMirror(t, DOC, "TeAm1", "owner", { admin: all }), /role must be one of/);
});
