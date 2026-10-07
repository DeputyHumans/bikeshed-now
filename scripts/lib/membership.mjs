// SPDX-License-Identifier: Apache-2.0
// Effective-membership math, ESM twin of functions/src/lib/folders.ts (SPEC §13, §18).

/**
 * Why this is duplicated rather than shared
 * -----------------------------------------
 * Cloud Functions is CommonJS and these scripts are ESM; neither can import the
 * other. The alternative — a build artifact copied between them — is more
 * machinery and one more thing to be stale.
 *
 * So it is duplicated on purpose and TESTED into agreement:
 * `functions/test/parity.test.js` dynamic-imports this module from the CommonJS
 * suite and asserts both implementations agree across a fixture table.
 *
 * This is the fix for a real defect in the design being rebuilt: the original
 * `set-access.mjs` recomputed `members` WITHOUT the parent folder's members, so
 * `--add` on a document inside a shared folder silently revoked every
 * folder-inherited reader. The script had its own arithmetic; now it has this.
 */

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export const TEAM_PREFIX = "team:";

/** Every grantable role, lowest first. Must equal ROLES in access.ts. */
export const ROLES = ["viewer", "editor"];

/** The field each role's direct grants are stored in. Must equal GRANT_LIST in access.ts. */
export const GRANT_LIST = {
  viewer: "viewers",
  editor: "editors",
};

function asStrings(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/** The direct grants stored on a document or folder record. A missing list is empty. */
export function grantsOf(data) {
  const out = {};
  for (const role of ROLES) out[GRANT_LIST[role]] = asStrings(data?.[GRANT_LIST[role]]);
  return out;
}

/** Every list in a grants record, for the team lookup that spans them all. */
export function grantLists(grants) {
  return ROLES.map((role) => grants[GRANT_LIST[role]]);
}

/** The effective membership stored on a document or folder. A missing set is empty. */
export function membershipOf(data) {
  return {
    members: asStrings(data?.members),
    editorMembers: asStrings(data?.editorMembers),
  };
}

export function isTeamRef(principal) {
  return String(principal ?? "").startsWith(TEAM_PREFIX);
}

export function teamIdOf(principal) {
  return isTeamRef(principal) ? String(principal).slice(TEAM_PREFIX.length) : null;
}

/** Expand a grant list into the emails it names, using a teamId -> emails map. */
function expand(principals, teams) {
  const out = [];
  for (const principal of principals ?? []) {
    if (isTeamRef(principal)) {
      const id = teamIdOf(principal);
      // A grant naming a deleted team expands to nothing, so it denies rather
      // than leaving stale access in place.
      if (id) out.push(...(teams.get?.(id) ?? teams[id] ?? []));
      continue;
    }
    const e = normalizeEmail(principal);
    if (e) out.push(e);
  }
  return out;
}

/**
 * members/editorMembers from a node's own grants unioned with its parent's.
 * Must stay byte-for-byte equivalent to computeMembership in folders.ts.
 *
 * It THROWS on a missing grant list, where the TypeScript twin cannot be
 * called with one at all. A script that builds its grants by hand and forgets
 * a role would otherwise write that role's people out of every derived set —
 * a silent revocation, which is the defect ADR 0006 records.
 */
export function computeMembership(ownerEmail, grants, parent = null, teams = new Map()) {
  for (const role of ROLES) {
    if (!Array.isArray(grants?.[GRANT_LIST[role]])) {
      throw new Error(`computeMembership: grants.${GRANT_LIST[role]} is missing`);
    }
  }
  const memberSet = new Set();
  const editorSet = new Set();

  const owner = normalizeEmail(ownerEmail);
  if (owner) {
    memberSet.add(owner);
    editorSet.add(owner);
  }
  for (const e of expand(grants.editors, teams)) {
    memberSet.add(e);
    editorSet.add(e);
  }
  for (const v of expand(grants.viewers, teams)) {
    memberSet.add(v);
  }
  if (parent) {
    for (const m of parent.members ?? []) memberSet.add(m);
    for (const m of parent.editorMembers ?? []) editorSet.add(m);
  }
  return {
    members: [...memberSet].sort(),
    editorMembers: [...editorSet].sort(),
  };
}

/** Read a folder's stored effective membership, or null. */
export async function loadFolderMembership(db, folderId) {
  if (!folderId) return null;
  const snap = await db.collection("folders").doc(folderId).get();
  if (!snap.exists) return null;
  return membershipOf(snap.data());
}

/** Load the membership of every team these grant lists reference. */
export async function loadTeamIndex(db, ...lists) {
  const ids = new Set();
  for (const list of lists) {
    for (const p of list ?? []) {
      const id = teamIdOf(p);
      if (id) ids.add(id);
    }
  }
  const index = new Map();
  for (const id of ids) {
    const snap = await db.collection("teams").doc(id).get();
    if (!snap.exists) continue;
    const members = snap.data()?.members;
    index.set(id, Array.isArray(members) ? members.map(normalizeEmail) : []);
  }
  return index;
}
