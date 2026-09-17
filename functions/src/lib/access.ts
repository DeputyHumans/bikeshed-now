// SPDX-License-Identifier: Apache-2.0
// Pure sharing algebra: parse and apply a grant delta (SPEC §2, §18).

import { isAllowedEmail } from "../generated/policy";

/**
 * A grant names a PRINCIPAL, which is either a lowercased email or a
 * `team:{teamId}` reference.
 *
 * Grants record intent and stay legible — "the Design team can view this".
 * Effective membership records reality and stays a flat array of emails, because
 * `members` is simultaneously the read gate and the workspace query key, and the
 * Firestore `list` rule is only valid because it is statically provable from an
 * array-contains filter (SPEC §5). Expansion happens server-side, in
 * `teams.ts`; nothing in this module touches the database.
 */
export const TEAM_PREFIX = "team:";

export type Role = "viewer" | "editor";

export interface AddEntry {
  principal: string;
  role: Role;
}

export interface AccessDelta {
  add: AddEntry[];
  remove: string[];
}

export interface AccessState {
  viewers: string[];
  editors: string[];
}

export function isTeamRef(principal: string): boolean {
  return principal.startsWith(TEAM_PREFIX);
}

export function teamIdOf(principal: string): string | null {
  return isTeamRef(principal) ? principal.slice(TEAM_PREFIX.length) : null;
}

/** Lowercase emails; leave a team id's case alone (Firestore ids are case-sensitive). */
export function normalizePrincipal(principal: string): string {
  const p = String(principal ?? "").trim();
  return isTeamRef(p) ? p : p.toLowerCase();
}

export function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

/** A team id must be a usable Firestore document id: opaque and bounded. */
const TEAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidPrincipal(principal: string): boolean {
  const p = normalizePrincipal(principal);
  const teamId = teamIdOf(p);
  if (teamId !== null) return TEAM_ID_RE.test(teamId);
  return isAllowedEmail(p);
}

/** Principals in a delta's `add` list that this deployment will not accept. */
export function invalidPrincipals(delta: AccessDelta): string[] {
  return delta.add.map((a) => a.principal).filter((p) => !isValidPrincipal(p));
}

/**
 * Apply add/remove with set semantics.
 *
 * A principal holds a SINGLE role: adding them to one removes them from the
 * other, which is what makes repeated calls converge instead of accumulating.
 * The owner is never removed and is never written into a role — ownership is
 * implicit in membership, and storing it twice creates two places to get it
 * wrong.
 */
export function applyAccessDelta(
  current: AccessState,
  ownerEmail: string,
  delta: AccessDelta,
): AccessState {
  const owner = normalizeEmail(ownerEmail);
  const viewers = new Set(current.viewers.map(normalizePrincipal));
  const editors = new Set(current.editors.map(normalizePrincipal));

  for (const raw of delta.remove) {
    const p = normalizePrincipal(raw);
    if (p === owner) continue; // never drop the owner
    viewers.delete(p);
    editors.delete(p);
  }
  for (const { principal, role } of delta.add) {
    const p = normalizePrincipal(principal);
    if (p === owner) continue; // implicit; do not duplicate into a role
    viewers.delete(p);
    editors.delete(p);
    if (role === "editor") editors.add(p);
    else viewers.add(p);
  }

  return { viewers: [...viewers].sort(), editors: [...editors].sort() };
}

/**
 * Validate and normalize a raw request body into a delta, or produce the message
 * for a 400. Unknown fields are ignored; `add` entries need a principal and a
 * valid role.
 *
 * `email` is accepted as an alias for `principal` so the wire shape stays
 * compatible with the obvious `{ email, role }` a caller would reach for.
 */
export function parseAccessDelta(
  body: unknown,
): { delta: AccessDelta } | { error: string } {
  if (body == null || typeof body !== "object") {
    return { error: "request body must be a JSON object" };
  }
  const b = body as { add?: unknown; remove?: unknown };

  const add: AddEntry[] = [];
  if (b.add !== undefined) {
    if (!Array.isArray(b.add)) return { error: "`add` must be an array" };
    for (const raw of b.add) {
      if (raw == null || typeof raw !== "object") {
        return { error: "each `add` entry must be an object" };
      }
      const entry = raw as { email?: unknown; principal?: unknown; role?: unknown };
      const value =
        typeof entry.principal === "string" ? entry.principal : entry.email;
      if (typeof value !== "string" || value.trim() === "") {
        return { error: "each `add` entry needs a non-empty email or team reference" };
      }
      if (entry.role !== "viewer" && entry.role !== "editor") {
        return { error: '`role` must be "viewer" or "editor"' };
      }
      add.push({ principal: value, role: entry.role });
    }
  }

  const remove: string[] = [];
  if (b.remove !== undefined) {
    if (!Array.isArray(b.remove)) return { error: "`remove` must be an array" };
    for (const e of b.remove) {
      if (typeof e !== "string" || e.trim() === "") {
        return { error: "each `remove` entry must be a non-empty string" };
      }
      remove.push(e);
    }
  }

  if (add.length === 0 && remove.length === 0) {
    return { error: "nothing to change (provide `add` and/or `remove`)" };
  }
  return { delta: { add, remove } };
}
