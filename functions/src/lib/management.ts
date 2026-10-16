// SPDX-License-Identifier: Apache-2.0
// Shared owner access, visibility and folder management for HTTP and MCP (SPEC §13, §17, §19).

import type { Firestore, DocumentData } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomBytes } from "crypto";
import type { Principal } from "./auth";
import type { Actor } from "./actor";
import { canManageSharing, canManageFolder, canRead, canReadFolder, canEditFolder, visibilityOf, expiryMs, opensEditingToAnyAccount, type DocAclData, type FolderAclData } from "./acl";
import { applyAccessDelta, grantsOf, invalidPrincipals, parseAccessDelta, parseExpiry, type Role } from "./access";
import { filedIn, inheritedGrants, folderAudience } from "./audience";
import { membershipOf, persistDocMembership, recomputeSubtree, resolveFolderTarget, slugify, wouldCycle, type Membership } from "./folders";
import { addEvent, eventActor } from "./events";
import { syncPresenceAccess } from "./presence";
import { syncPublicProjection } from "./publicdoc";
import { safeSegment } from "./http";
import { publicOrigin } from "../config";

export interface ManagementContext { db: Firestore; caller: Principal; actor: Actor }
export type ResourceKind = "document" | "folder";
export class ManagementError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
const bad = (message: string): never => { throw new ManagementError(400, message); };
const stamp = () => FieldValue.serverTimestamp();

async function load(ctx: ManagementContext, kind: ResourceKind, id: string, ownerOnly = true) {
  if (!id || !safeSegment(id)) bad("invalid or missing id");
  const ref = ctx.db.collection(kind === "document" ? "docs" : "folders").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new ManagementError(404, `no ${kind} with id "${id}"`);
  const data = snap.data()!;
  const owner = kind === "document"
    ? canManageSharing(data as DocAclData, ctx.caller.emailLower)
    : canManageFolder(data as FolderAclData, ctx.caller.emailLower);
  const reads = kind === "document"
    ? canRead(data as DocAclData, ctx.caller)
    : canReadFolder(data as FolderAclData, ctx.caller.uid, ctx.caller.emailLower);
  if (!owner && !reads) throw new ManagementError(404, `no ${kind} with id "${id}"`);
  if (ownerOnly && !owner) throw new ManagementError(403, `only the owner can manage this ${kind}`);
  return { ref, snap, data };
}

function settings(id: string, data: DocumentData) {
  const visibility = visibilityOf(data as DocAclData);
  const key = visibility === "unlisted" && typeof data.linkToken === "string" ? data.linkToken : null;
  return {
    visibility, publicEdit: data.publicEdit === true, expiresAt: expiryMs(data as DocAclData),
    url: `${publicOrigin()}/d/${encodeURIComponent(id)}${key ? `?k=${encodeURIComponent(key)}` : ""}`,
  };
}

/** Owner-only, complete management state; no document bytes are loaded. */
export async function getAccess(ctx: ManagementContext, kind: ResourceKind, id: string) {
  const { data } = await load(ctx, kind, id);
  const parent = kind === "document" ? data.folderId : data.parentId;
  return {
    id, kind, owner: String(data.ownerEmail), direct: grantsOf(data),
    inherited: await inheritedGrants(ctx.db, ctx.caller, typeof parent === "string" ? parent : null),
    effective: membershipOf(data),
    ...(kind === "document" ? settings(id, data) : {}),
  };
}

function roleOf(email: string, m: Membership): Role {
  return m.approverMembers.includes(email) ? "approver" : m.editorMembers.includes(email) ? "editor" : m.suggesterMembers.includes(email) ? "suggester" : "viewer";
}

export async function setAccess(ctx: ManagementContext, kind: ResourceKind, id: string, body: unknown) {
  const { ref, data } = await load(ctx, kind, id);
  const parsed = parseAccessDelta(body);
  if ("error" in parsed) throw new ManagementError(400, parsed.error);
  const { delta } = parsed;
  const invalid = invalidPrincipals(delta);
  if (invalid.length) bad(`not a valid recipient: ${invalid.join(", ")}`);
  const before = membershipOf(data);
  const oldGrants = grantsOf(data);
  const next = applyAccessDelta(oldGrants, String(data.ownerEmail), delta);
  const changed = JSON.stringify(oldGrants) !== JSON.stringify(next);
  if (kind === "document") {
    await persistDocMembership(ctx.db, ref, {
      ownerEmail: String(data.ownerEmail), grants: next, folderId: data.folderId ?? null,
    }, {}, (m) => changed ? [{
      type: "access.changed", audience: "editors", actor: eventActor(ctx.actor),
      data: { added: m.members.filter(e => !before.members.includes(e)), removed: before.members.filter(e => !m.members.includes(e)) },
    }] : []);
  } else {
    await ref.set({ ...next, updatedAt: stamp() }, { merge: true });
    await recomputeSubtree(ctx.db, id);
  }
  const fresh = (await ref.get()).data()!;
  const after = membershipOf(fresh);
  if (changed) await ref.collection("acl").doc().create({
    at: stamp(), actor: ctx.actor,
    added: after.members.filter(e => !before.members.includes(e)),
    removed: before.members.filter(e => !after.members.includes(e)), ...next,
  });
  const invitees = after.members.filter(e => !before.members.includes(e) && e !== ctx.caller.emailLower)
    .map(email => ({ email, role: roleOf(email, after) }));
  if (invitees.length) {
    const { sendInvitations } = await import("../email/notify");
    await sendInvitations(ctx.caller.emailLower, invitees, {
      title: String(data.title ?? data.name ?? id), kind,
      url: `${publicOrigin()}/${kind === "document" ? "d" : "folder"}/${encodeURIComponent(id)}`,
    });
  }
  return getAccess(ctx, kind, id);
}

/** Sparse patch: expiry omission never clears it, including on an expired document. */
export async function setVisibility(ctx: ManagementContext, id: string, patch: Record<string, unknown>) {
  const { ref } = await load(ctx, "document", id);
  const fields = ["visibility", "publicEdit", "expiresAt"].filter(k => Object.hasOwn(patch, k));
  if (!fields.length) bad("provide visibility, publicEdit and/or expiresAt");
  if (Object.hasOwn(patch, "visibility") && (typeof patch.visibility !== "string" || !["private", "unlisted", "public"].includes(patch.visibility))) bad('visibility must be "private", "unlisted" or "public"');
  if (Object.hasOwn(patch, "publicEdit") && typeof patch.publicEdit !== "boolean") bad("publicEdit must be a boolean");
  if (Object.hasOwn(patch, "expiresAt") && patch.expiresAt !== null && typeof patch.expiresAt !== "number") bad("expiresAt must be epoch milliseconds or null");
  const expiry = Object.hasOwn(patch, "expiresAt") ? parseExpiry(patch.expiresAt) : undefined;
  if (expiry && "error" in expiry) bad(expiry.error);
  await ctx.db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data()!;
    if (!canManageSharing(data as DocAclData, ctx.caller.emailLower)) throw new ManagementError(403, "only the owner can manage this document");
    const visibility = (patch.visibility ?? visibilityOf(data as DocAclData)) as "private" | "unlisted" | "public";
    const publicEdit = visibility !== "private" && (patch.publicEdit ?? data.publicEdit) === true;
    const update: Record<string, unknown> = { visibility, publicEdit, updatedAt: stamp() };
    if (expiry && "value" in expiry) update.expiresAt = expiry.value === null ? FieldValue.delete() : Timestamp.fromMillis(expiry.value);
    update.linkToken = visibility === "unlisted"
      ? (typeof data.linkToken === "string" && data.linkToken.length >= 22 ? data.linkToken : randomBytes(16).toString("base64url"))
      : FieldValue.delete();
    tx.set(ref, update, { merge: true });
    const actor = eventActor(ctx.actor);
    if (visibilityOf(data as DocAclData) !== visibility || (data.publicEdit === true) !== publicEdit) addEvent(tx, ref, {
      type: "doc.visibility", audience: "editors", actor,
      data: { from: visibilityOf(data as DocAclData), to: visibility, publicEdit },
    });
    if (expiry && "value" in expiry && expiryMs(data as DocAclData) !== expiry.value) addEvent(tx, ref, {
      type: "doc.expiry", audience: "readers", actor,
      data: { from: expiryMs(data as DocAclData), to: expiry.value },
    });
  });
  await syncPublicProjection(ctx.db, id);
  const data = (await ref.get()).data()!;
  const m = membershipOf(data);
  await syncPresenceAccess(id, m.members, m.editorMembers, opensEditingToAnyAccount(data as DocAclData));
  return { id, ...settings(id, data), linkToken: data.linkToken ?? null };
}

export async function organizeFolder(ctx: ManagementContext, id: string, op: "rename" | "move" | "delete", args: Record<string, unknown> = {}) {
  const { ref, data } = await load(ctx, "folder", id, op === "delete");
  if (op !== "delete" && !canEditFolder(data as FolderAclData, ctx.caller.uid, ctx.caller.emailLower)) throw new ManagementError(403, "you cannot edit that folder");
  if (op === "rename") {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name || name.length > 120) bad("folder name is required (up to 120 characters)");
    await ref.set({ name, slug: slugify(name), updatedAt: stamp() }, { merge: true });
  } else if (op === "move") {
    const target = await resolveFolderTarget(ctx.db, args.parent, ctx.caller);
    if (!target.ok) throw new ManagementError(target.status, target.error);
    if (target.id && await wouldCycle(ctx.db, id, target.id)) bad("cannot move a folder into itself or a descendant");
    await ref.set({ parentId: target.id, updatedAt: stamp() }, { merge: true });
    await recomputeSubtree(ctx.db, id);
  } else {
    const parent = data.parentId ?? null;
    const folders = await ctx.db.collection("folders").where("parentId", "==", id).get();
    const docs = await ctx.db.collection("docs").where("folderId", "==", id).get();
    // Chunk the writes so a folder containing more than one Firestore batch still works.
    const children = [...folders.docs.map(s => ({ ref: s.ref, field: "parentId" })), ...docs.docs.map(s => ({ ref: s.ref, field: "folderId" }))];
    for (let i = 0; i < children.length; i += 400) {
      const batch = ctx.db.batch();
      for (const child of children.slice(i, i + 400)) batch.set(child.ref, { [child.field]: parent, updatedAt: stamp() }, { merge: true });
      await batch.commit();
    }
    for (const child of folders.docs) await recomputeSubtree(ctx.db, child.id);
    for (const child of docs.docs) {
      const d = child.data();
      await persistDocMembership(ctx.db, child.ref, { ownerEmail: String(d.ownerEmail), grants: grantsOf(d), folderId: parent });
    }
    await ref.delete();
    return { id, deleted: true, parent, reparented: { folders: folders.size, documents: docs.size } };
  }
  const fresh = await ref.get();
  const paths = await filedIn(ctx.db, ctx.caller, [id]);
  return { id, name: fresh.data()?.name, parent: fresh.data()?.parentId ?? null, path: paths.get(id)?.path ?? "…", access: await folderAudience(ctx.db, ctx.caller, fresh) };
}
