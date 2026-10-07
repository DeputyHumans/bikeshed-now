// SPDX-License-Identifier: Apache-2.0
// Team records and the expansion of `team:{id}` grants into emails (SPEC §18).

import * as admin from "firebase-admin";
import { GRANT_LIST, ROLES, normalizeEmail, teamIdOf } from "./access";

type Db = admin.firestore.Firestore;

/** teamId → the team's member emails, lowercased. */
export type TeamIndex = ReadonlyMap<string, string[]>;

export const EMPTY_TEAM_INDEX: TeamIndex = new Map();

/** Every distinct team id referenced by these grant lists. */
export function referencedTeamIds(...lists: readonly string[][]): string[] {
  const ids = new Set<string>();
  for (const list of lists) {
    for (const principal of list) {
      const id = teamIdOf(principal);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Load the membership of every team these grants reference.
 *
 * A team that has been deleted expands to nothing rather than failing the write.
 * That is the safe direction: a dangling grant then denies access, where
 * throwing would leave the document's effective membership stale and still
 * granting it.
 */
export async function loadTeamIndex(
  db: Db,
  ...lists: readonly string[][]
): Promise<TeamIndex> {
  const ids = referencedTeamIds(...lists);
  if (ids.length === 0) return EMPTY_TEAM_INDEX;
  const snaps = await db.getAll(...ids.map((id) => db.collection("teams").doc(id)));
  const index = new Map<string, string[]>();
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const members = snap.data()?.members;
    index.set(
      snap.id,
      Array.isArray(members) ? members.map(normalizeEmail).filter(Boolean) : [],
    );
  }
  return index;
}

/**
 * Every document and folder whose grants name this team.
 *
 * Both are `array-contains` queries on a single field, which Firestore indexes
 * automatically — no composite index, and no second copy of the grant to keep in
 * sync. This is what lets a membership change re-use the folder cascade instead
 * of needing a job queue: the affected set is a query, not a traversal.
 */
export async function findGrantsForTeam(
  db: Db,
  teamId: string,
): Promise<{ docIds: string[]; folderIds: string[] }> {
  const ref = `team:${teamId}`;
  const lists = ROLES.map((role) => GRANT_LIST[role]);
  const query = (collection: string) =>
    Promise.all(
      lists.map((list) => db.collection(collection).where(list, "array-contains", ref).get()),
    );
  const [docSnaps, folderSnaps] = await Promise.all([query("docs"), query("folders")]);
  const ids = (snaps: admin.firestore.QuerySnapshot[]) =>
    [...new Set(snaps.flatMap((s) => s.docs.map((d) => d.id)))];
  return { docIds: ids(docSnaps), folderIds: ids(folderSnaps) };
}

export interface TeamRecord {
  teamId: string;
  name: string;
  slug: string;
  ownerEmail: string;
  admins: string[];
  members: string[];
}

/** The team's own membership set, always including the owner. */
export function computeTeamMembers(
  ownerEmail: string,
  members: readonly string[],
): string[] {
  const set = new Set<string>();
  const owner = normalizeEmail(ownerEmail);
  if (owner) set.add(owner);
  for (const m of members) {
    const n = normalizeEmail(m);
    if (n) set.add(n);
  }
  return [...set].sort();
}
