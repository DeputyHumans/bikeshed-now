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

/**
 * Every grantable role, lowest first. A principal holds exactly one, and each
 * role can do everything the ones below it can (SPEC §13):
 *
 *   viewer     read, comment
 *   suggester  + propose a text change for someone else to decide on
 *   editor     + edit live, publish a version
 *   approver   + accept or reject suggestions
 *
 * Approver sits ABOVE editor because accepting a suggestion IS an edit: it is
 * replayed in the approver's own editing session, so only someone who may edit
 * can be trusted to do it.
 */
export const ROLES = ["viewer", "suggester", "editor", "approver"] as const;

export type Role = (typeof ROLES)[number];

/**
 * The field each role's direct grants are stored in, on a document and on a
 * folder alike. Every reader of grants goes through `grantsOf`, so a field
 * added here is a compile error at every place that builds a `RoleGrants` by
 * hand, rather than a list that one recompute path silently drops — which
 * revokes everyone it held (ADR 0006).
 */
export const GRANT_LIST = {
  viewer: "viewers",
  suggester: "suggesters",
  editor: "editors",
  approver: "approvers",
} as const satisfies Record<Role, string>;

export type GrantList = (typeof GRANT_LIST)[Role];

/** A node's direct grants, one list per role. */
export type RoleGrants = Record<GrantList, string[]>;

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The direct grants stored on a document or folder record. A missing list is empty. */
export function grantsOf(data: object | null | undefined): RoleGrants {
  const record = (data ?? {}) as Record<string, unknown>;
  const out = {} as RoleGrants;
  for (const role of ROLES) out[GRANT_LIST[role]] = asStrings(record[GRANT_LIST[role]]);
  return out;
}

/** No grants at all: what a new document or folder starts with. */
export function emptyGrants(): RoleGrants {
  return grantsOf(undefined);
}

/** Every list in a grants record, for the team lookup that spans them all. */
export function grantLists(grants: RoleGrants): string[][] {
  return ROLES.map((role) => grants[GRANT_LIST[role]]);
}

export interface AddEntry {
  principal: string;
  role: Role;
}

export interface AccessDelta {
  add: AddEntry[];
  remove: string[];
}

export type AccessState = RoleGrants;

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
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
  const sets = new Map(
    // A list absent from `current` reads as empty: the result always carries
    // every list, so nothing a caller left out can be written back as missing.
    ROLES.map((role) => [role, new Set((current[GRANT_LIST[role]] ?? []).map(normalizePrincipal))]),
  );
  const drop = (p: string) => {
    for (const set of sets.values()) set.delete(p);
  };

  for (const raw of delta.remove) {
    const p = normalizePrincipal(raw);
    if (p === owner) continue; // never drop the owner
    drop(p);
  }
  for (const { principal, role } of delta.add) {
    const p = normalizePrincipal(principal);
    if (p === owner) continue; // implicit; do not duplicate into a role
    drop(p);
    sets.get(role)?.add(p);
  }

  const out = {} as AccessState;
  for (const role of ROLES) out[GRANT_LIST[role]] = [...(sets.get(role) ?? [])].sort();
  return out;
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
      if (!isRole(entry.role)) {
        return { error: `\`role\` must be one of ${ROLES.map((r) => `"${r}"`).join(", ")}` };
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

/**
 * Read an expiry off a request body: epoch milliseconds, or null to clear it.
 *
 * A date in the PAST is refused rather than accepted. Accepting one would make
 * "expire this now" a side effect of a typo in a year, and the intended way to
 * take a document down immediately is to make it private — which is
 * reversible in a way an accidental expiry, silently applied, is not.
 *
 * The far bound is arbitrary but not decorative: a value in milliseconds pasted
 * where seconds were meant lands tens of thousands of years out, and a
 * document that "expires" in the year 55000 has no expiry at all while looking
 * like it has one.
 */
const MAX_EXPIRY_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export function parseExpiry(
  raw: unknown,
): { value: number | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  const ms = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(ms) || !Number.isInteger(ms)) {
    return { error: "expiresAt must be a time in epoch milliseconds, or null" };
  }
  const nowMs = Date.now();
  if (ms <= nowMs) return { error: "an expiry must be in the future" };
  if (ms > nowMs + MAX_EXPIRY_MS) {
    return { error: "an expiry must be within a hundred years" };
  }
  return { value: ms };
}
