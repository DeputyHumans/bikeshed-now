// SPDX-License-Identifier: Apache-2.0
// Agent management across MCP, CLI, stored access and invitation delivery (SPEC §13, §17, §19).

import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession, mintToken } from "../../lib/session.mjs";
import { createFolderMcp, publishMcp, docIdFor } from "../../lib/seed.mjs";
import { readDoc, closeAdmin } from "../../lib/admin.mjs";
import { runCli, cliHome } from "../../lib/cli.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";

const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);

async function person(ctx, role) {
  const [account] = await cast(target, [role], { notifications: false });
  const session = await openSession(target, account);
  const { token } = await mintToken(session, { name: `management ${role}`, channel: "mcp" });
  const mcp = ctx.mcp({ http: ctx.http({ actor: role, headers: { authorization: `Bearer ${token}` } }) });
  await mcp.initialize();
  return { account, token, mcp };
}
async function folder(who, name, parent) {
  const result = await createFolderMcp(who.mcp, { name, ownerEmail: who.account.email, ...(parent ? { parent } : {}) });
  precondition(!result.isError && result.folderId, `create folder: ${result.text}`);
  return result.folderId;
}
async function document(who, name, parent) {
  const result = await publishMcp(who.mcp, { id: docIdFor(target, name), title: name, format: "markdown", content: `# ${name}\n\nKeep this document.`, ...(parent ? { folder: parent } : {}) });
  precondition(!result.isError && result.docId, `publish: ${result.text}`);
  return result.docId;
}
async function call(who, name, args) {
  const result = await who.mcp.call(name, args);
  precondition(!result.isError, `${name}: ${result.text}`);
  return result.json;
}

scenario("A20 management: MCP shares, revokes, preserves sparse settings, and trashes and restores a folder with its documents", {
  tiers: ["local"], effects: ["email:POST /mcp"], needs: ["email", "mailpit"], timeoutMs: 300_000,
}, async ctx => {
  const owner = await person(ctx, "owner"), reader = await person(ctx, "reader");
  const parent = await folder(owner, "Management parent"), child = await folder(owner, "Management child", parent);
  const id = await document(owner, "management-mcp", child);
  await call(owner, "set_folder_access", { id: parent, add: [{ principal: reader.account.email, role: "viewer" }] });
  const readable = await reader.mcp.call("get_document", { id });
  const denied = await reader.mcp.call("set_document_access", { id, add: [{ principal: reader.account.email, role: "approver" }] });
  await call(owner, "set_folder_access", { id: parent, add: [{ principal: reader.account.email, role: "viewer" }] });
  await call(owner, "set_document_access", { id, add: [{ principal: reader.account.email, role: "editor" }] });
  const access = await call(owner, "get_document_access", { id });
  const removed = await call(owner, "set_document_access", { id, remove: [reader.account.email] });
  const expiresAt = Date.now() + 86400000;
  const settings = await call(owner, "set_document_visibility", { id, visibility: "unlisted", expiresAt });
  const sparse = await call(owner, "set_document_visibility", { id, publicEdit: false });
  await call(owner, "rename_folder", { id: child, name: "Renamed" });
  const cycle = await owner.mcp.call("move_folder", { id: parent, parent: child });
  await call(owner, "move_folder", { id: child });
  const detached = await call(owner, "get_document_access", { id });
  await call(owner, "move_folder", { id: child, parent });
  // Deleting a folder moves it to the Trash with its document: the reader its
  // parent shares with loses the document until the owner restores it.
  const trashed = await call(owner, "delete_folder", { id: child });
  const inTrash = await readDoc(target, `docs/${id}`);
  const hidden = await reader.mcp.call("get_document", { id });
  const listed = await call(owner, "list_trash", {});
  const restored = await call(owner, "restore_from_trash", { id: child, kind: "folder" });
  const back = await readDoc(target, `docs/${id}`);
  assert.deepEqual({
    readable: readable.isError, denied: denied.isError, editor: access.direct.editors.includes(reader.account.email), stillInherited: removed.effective.members.includes(reader.account.email), expiry: sparse.expiresAt, sameLink: settings.url === sparse.url, cycle: cycle.isError, detached: detached.effective.members.includes(reader.account.email),
    trashed: [trashed.folders, trashed.documents], inTrash: [inTrash.members, inTrash.folderId, typeof inTrash.trashed?.batch], hidden: hidden.isError, listed: [listed.folders.map((f) => f.id), listed.documents.map((d) => [d.id, d.with?.folderId])],
    restored: [restored.parentId, restored.documents], back: [back.trashed, back.folderId, back.members.includes(reader.account.email)], version: back.currentVersion,
  }, {
    readable: false, denied: true, editor: true, stillInherited: true, expiry: expiresAt, sameLink: true, cycle: true, detached: false,
    trashed: [1, 1], inTrash: [[owner.account.email.toLowerCase()], child, "string"], hidden: true, listed: [[child], [[id, child]]],
    restored: [parent, 1], back: [null, child, true], version: "v1",
  });
  await mailbox(target, { http: ctx.http({ actor: "mailpit" }) }).expectMail({ to: reader.account.email, count: 1 });
});

scenario("A20 management: CLI permissions, visibility and folder commands reach the shared handlers", {
  tiers: ["local"], effects: ["email:POST /mcp"], needs: ["email", "mailpit"], timeoutMs: 300_000,
}, async ctx => {
  const owner = await person(ctx, "cli-owner"), reader = await person(ctx, "cli-reader");
  const parent = await folder(owner, "CLI management"), child = await folder(owner, "CLI child", parent);
  const id = await document(owner, "management-cli", child);
  const home = cliHome(target);
  const cli = async args => {
    const result = await runCli(target, [...args, "--json"], { token: owner.token, home, timeoutMs: 120_000 });
    precondition(result.code === 0 && result.json, `CLI ${args[0]}: ${result.stderr}`);
    return result.json;
  };
  await cli(["access", "document", id, "--add", reader.account.email, "--role", "approver"]);
  const access = await cli(["access", "document", id]);
  await cli(["access", "document", id, "--remove", reader.account.email]);
  await cli(["visibility", id, "public", "--public-edit", "true"]);
  const settings = await cli(["visibility", id, "--expires", "none"]);
  const renamed = await cli(["rename-folder", child, "CLI renamed"]);
  const moved = await cli(["move-folder", child, "root"]);
  // The older name and the new one reach the same tool; restore brings it back.
  const deleted = await cli(["delete-folder", child]);
  const listed = await cli(["trash"]);
  const restored = await cli(["restore", "folder", child]);
  const trashedDoc = await cli(["trash", id]);
  const restoredDoc = await cli(["restore", id]);
  const stored = await readDoc(target, `docs/${id}`);
  assert.deepEqual({ role: access.direct.approvers, public: settings.visibility, editing: settings.publicEdit, expiry: settings.expiresAt, name: renamed.name, parent: moved.parent, deleted: [deleted.folders, deleted.documents], listed: listed.documents.map((d) => d.id), restored: [restored.parentId, restored.documents], trashedDoc: typeof trashedDoc.batch, restoredDoc: restoredDoc.folderId, docParent: stored.folderId, trashed: stored.trashed, member: stored.members.includes(reader.account.email) }, {
    role: [reader.account.email], public: "public", editing: true, expiry: null, name: "CLI renamed", parent: null, deleted: [1, 1], listed: [id], restored: [null, 1], trashedDoc: "string", restoredDoc: child, docParent: child, trashed: null, member: false,
  });
  await mailbox(target, { http: ctx.http({ actor: "mailpit" }) }).expectMail({ to: reader.account.email, count: 1 });
});
