// SPDX-License-Identifier: Apache-2.0
// Shared owner access, visibility and folder management for HTTP and MCP (SPEC §13, §17, §19).

import type { Firestore, DocumentData } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomBytes } from "crypto";
import type { Principal } from "./auth";
import type { Actor } from "./actor";
import { canManageSharing, canManageFolder, canRead, canReadFolder, canEditFolder, isTeamMember, visibilityOf, expiryMs, isTrashed, opensEditingToAnyAccount, TRASHED_WRITE, type DocAclData, type FolderAclData } from "./acl";
import { applyAccessDelta, grantsOf, invalidPrincipals, normalizePrincipal, parseAccessDelta, parseExpiry, teamIdOf, type Role } from "./access";
import { filedIn, inheritedGrants, inheritedReach, folderAudience } from "./audience";
import { membershipOf, persistFolderMembership, persistDocMembership, recomputeSubtree, resolveFolderTarget, slugify, wouldCycle, type Membership } from "./folders";
import { addEvent, eventActor } from "./events";
import { syncPresenceAccess } from "./presence";
import { syncPublicProjection } from "./publicdoc";
import { linkProofFor } from "./linkgrant";
import { safeSegment } from "./http";
import { publicOrigin } from "../config";

export interface ManagementContext { db: Firestore; caller: Principal; actor: Actor }
export type ResourceKind = "document" | "folder";
export class ManagementError extends Error {
  /** `detail` joins `error` in the response body, as `{ trashed: true }` does for the Trash's 409. */
  constructor(public readonly status: number, message: string, public readonly detail: Record<string, unknown> = {}) { super(message); }
}
const bad = (message: string): never => { throw new ManagementError(400, message); };
/** A trashed folder is frozen as a trashed document is (SPEC §4): Restore first. */
const TRASHED_FOLDER = "this folder is in the Trash — restore it first";
/** Refuse a change to anything in the Trash, read inside the writing transaction, with the body every write path gives it. */
function refuseTrashed(kind: ResourceKind, data: DocumentData): void {
  if (isTrashed(data)) throw new ManagementError(409, kind === "document" ? TRASHED_WRITE : TRASHED_FOLDER, { trashed: true });
}
const stamp = () => FieldValue.serverTimestamp();

/** A document or folder the caller may manage (owner) or at least read; 404 alike for anything else. */
export async function load(ctx: ManagementContext, kind: ResourceKind, id: string, ownerOnly = true) {
  if (!id || !safeSegment(id)) bad("invalid or missing id");
  const ref = ctx.db.collection(kind === "document" ? "docs" : "folders").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new ManagementError(404, `no ${kind} with id "${id}"`);
  const data = snap.data()!;
  const owner = kind === "document"
    ? canManageSharing(data as DocAclData, ctx.caller.emailLower)
    : canManageFolder(data as FolderAclData, ctx.caller.emailLower);
  const reads = kind === "document"
    ? canRead(data as DocAclData, ctx.caller, await linkProofFor(ref, data as DocAclData, ctx.caller, null))
    : canReadFolder(data as FolderAclData, ctx.caller.uid, ctx.caller.emailLower);
  if (!owner && !reads) throw new ManagementError(404, `no ${kind} with id "${id}"`);
  if (ownerOnly && !owner) throw new ManagementError(403, `only the owner can manage this ${kind}`);
  return { ref, snap, data };
}

function settings(kind: ResourceKind, id: string, data: DocumentData) {
  const visibility = visibilityOf(data as DocAclData);
  const key = visibility === "unlisted" && typeof data.linkToken === "string" ? data.linkToken : null;
  const path = kind === "document" ? "d" : "folder";
  return {
    visibility,
    // A folder has no open editing: what its reach opens is read-only (ADR 0019).
    ...(kind === "document" ? { publicEdit: data.publicEdit === true } : {}),
    expiresAt: expiryMs(data as DocAclData),
    url: `${publicOrigin()}/${path}/${encodeURIComponent(id)}${key ? `?k=${encodeURIComponent(key)}` : ""}`,
  };
}

/** Owner-only, complete management state; no document bytes are loaded. */
export async function getAccess(ctx: ManagementContext, kind: ResourceKind, id: string) {
  const { data } = await load(ctx, kind, id);
  const parent = kind === "document" ? data.folderId : data.parentId;
  const parentId = typeof parent === "string" ? parent : null;
  return {
    id, kind, owner: String(data.ownerEmail), direct: grantsOf(data),
    inherited: await inheritedGrants(ctx.db, ctx.caller, parentId),
    inheritedReach: await inheritedReach(ctx.db, ctx.caller, parentId),
    effective: membershipOf(data),
    ...settings(kind, id, data),
  };
}

function roleOf(email: string, m: Membership): Role {
  return m.approverMembers.includes(email) ? "approver" : m.editorMembers.includes(email) ? "editor" : m.suggesterMembers.includes(email) ? "suggester" : "viewer";
}

/**
 * A team is granted only by somebody in it (SPEC §18). Granting expands it to
 * its people, emails each of them an invitation, and answers with the
 * effective members, so a stranger who knew a team's id could otherwise read
 * its roster and mail everybody in it under a title of their choosing. A team
 * already granted here may change role or be removed by the owner whether or
 * not they are still in it: that reaches nobody new. A team that does not
 * exist is refused in the same words as one the caller is not in.
 */
async function refuseStrangersTeams(ctx: ManagementContext, data: DocumentData, principals: string[]) {
  const granted = new Set(Object.values(grantsOf(data)).flat());
  for (const raw of principals) {
    const principal = normalizePrincipal(raw);
    const teamId = teamIdOf(principal);
    if (teamId === null || granted.has(principal)) continue;
    const team = (await ctx.db.collection("teams").doc(teamId).get()).data();
    if (!isTeamMember(team, ctx.caller.emailLower)) {
      throw new ManagementError(403, `you can share with a team only if you are in it: ${principal}`);
    }
  }
}

export async function setAccess(ctx: ManagementContext, kind: ResourceKind, id: string, body: unknown) {
  const { ref, data } = await load(ctx, kind, id);
  const parsed = parseAccessDelta(body);
  if ("error" in parsed) throw new ManagementError(400, parsed.error);
  const { delta } = parsed;
  const invalid = invalidPrincipals(delta);
  if (invalid.length) bad(`not a valid recipient: ${invalid.join(", ")}`);
  await refuseStrangersTeams(ctx, data, delta.add.map((a) => a.principal));
  let before = membershipOf(data);
  let next = grantsOf(data);
  let changed = false;
  const apply = (current: DocumentData) => {
    refuseTrashed(kind, current);
    const oldGrants = grantsOf(current);
    next = applyAccessDelta(oldGrants, String(current.ownerEmail), delta);
    changed = JSON.stringify(oldGrants) !== JSON.stringify(next);
    return { ...next };
  };
  let after: Membership;
  if (kind === "document") {
    after = await persistDocMembership(ctx.db, ref, apply, (m, _data, previous) => {
      before = previous;
      return changed ? [{
        type: "access.changed", audience: "editors", actor: eventActor(ctx.actor),
        data: { added: m.members.filter(e => !before.members.includes(e)), removed: before.members.filter(e => !m.members.includes(e)) },
      }] : [];
    });
  } else {
    const result = await persistFolderMembership(ctx.db, ref, apply);
    if (!result) throw new ManagementError(404, `no folder with id "${id}"`);
    before = result.before;
    after = result.membership;
    await recomputeSubtree(ctx.db, id);
  }
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
    // Not a thaw, as lifting an expiry is: only Restore brings it back.
    refuseTrashed("document", data);
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
  return { id, ...settings("document", id, data), linkToken: data.linkToken ?? null };
}

/**
 * A folder's own level and expiry: what its reach opens beneath it (SPEC §13,
 * §17). Sparse, as for a document. The token follows the document's rule —
 * kept while unlisted, minted on becoming unlisted, deleted otherwise — so
 * making the folder private and unlisted again revokes every link at once. The
 * expiry ends the reach only: members keep their access, and nothing beneath
 * is frozen (ADR 0019).
 */
export async function setFolderVisibility(ctx: ManagementContext, id: string, patch: Record<string, unknown>) {
  const { ref } = await load(ctx, "folder", id);
  if (Object.hasOwn(patch, "publicEdit")) bad("a folder has no open editing: what its link opens is read-only");
  const fields = ["visibility", "expiresAt"].filter(k => Object.hasOwn(patch, k));
  if (!fields.length) bad("provide visibility and/or expiresAt");
  if (Object.hasOwn(patch, "visibility") && (typeof patch.visibility !== "string" || !["private", "unlisted", "public"].includes(patch.visibility))) bad('visibility must be "private", "unlisted" or "public"');
  if (Object.hasOwn(patch, "expiresAt") && patch.expiresAt !== null && typeof patch.expiresAt !== "number") bad("expiresAt must be epoch milliseconds or null");
  const expiry = Object.hasOwn(patch, "expiresAt") ? parseExpiry(patch.expiresAt) : undefined;
  if (expiry && "error" in expiry) bad(expiry.error);
  const before = await ctx.db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data()!;
    if (!canManageFolder(data as FolderAclData, ctx.caller.emailLower)) throw new ManagementError(403, "only the owner can manage this folder");
    refuseTrashed("folder", data);
    const visibility = (patch.visibility ?? visibilityOf(data as DocAclData)) as "private" | "unlisted" | "public";
    const update: Record<string, unknown> = { visibility, updatedAt: stamp() };
    if (expiry && "value" in expiry) update.expiresAt = expiry.value === null ? FieldValue.delete() : Timestamp.fromMillis(expiry.value);
    update.linkToken = visibility === "unlisted"
      ? (typeof data.linkToken === "string" && data.linkToken.length >= 22 ? data.linkToken : randomBytes(16).toString("base64url"))
      : FieldValue.delete();
    tx.set(ref, update, { merge: true });
    return { visibility: visibilityOf(data as DocAclData), expiresAt: expiryMs(data as DocAclData), linkToken: data.linkToken ?? null };
  });
  // The folder's own entry and every descendant's inherited one, and the
  // public mirror of every document beneath it, in one pass.
  await recomputeSubtree(ctx.db, id);
  const data = (await ref.get()).data()!;
  const after = settings("folder", id, data);
  if (before.visibility !== after.visibility || before.expiresAt !== after.expiresAt || before.linkToken !== (data.linkToken ?? null)) {
    await ref.collection("acl").doc().create({
      at: stamp(), actor: ctx.actor,
      visibility: { from: before.visibility, to: after.visibility },
      expiresAt: { from: before.expiresAt, to: after.expiresAt },
      linkRotated: before.linkToken !== null && before.linkToken !== (data.linkToken ?? null),
    });
  }
  return { id, ...after, linkToken: data.linkToken ?? null };
}

export async function organizeFolder(ctx: ManagementContext, id: string, op: "rename" | "move", args: Record<string, unknown> = {}) {
  const { ref, data } = await load(ctx, "folder", id, false);
  if (!canEditFolder(data as FolderAclData, ctx.caller.uid, ctx.caller.emailLower)) throw new ManagementError(403, "you cannot edit that folder");
  // Moving a folder is sharing everything in it: its new parent's members,
  // link and public level reach the whole subtree. So it is the folder's
  // owner's, as its sharing is; its editors may rename it (SPEC §13).
  if (op === "move" && !canManageFolder(data as FolderAclData, ctx.caller.emailLower)) {
    throw new ManagementError(403, "only its owner can move this folder: moving it changes who can read everything in it");
  }
  refuseTrashed("folder", data);
  if (op === "rename") {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name || name.length > 120) bad("folder name is required (up to 120 characters)");
    await ref.set({ name, slug: slugify(name), updatedAt: stamp() }, { merge: true });
  } else {
    const target = await resolveFolderTarget(ctx.db, args.parent, ctx.caller);
    if (!target.ok) throw new ManagementError(target.status, target.error);
    if (target.id && await wouldCycle(ctx.db, id, target.id)) bad("cannot move a folder into itself or a descendant");
    await ref.set({ parentId: target.id, updatedAt: stamp() }, { merge: true });
    await recomputeSubtree(ctx.db, id);
  }
  const fresh = await ref.get();
  const paths = await filedIn(ctx.db, ctx.caller, [id]);
  return { id, name: fresh.data()?.name, parent: fresh.data()?.parentId ?? null, path: paths.get(id)?.path ?? "…", access: await folderAudience(ctx.db, ctx.caller, fresh) };
}
