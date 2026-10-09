// SPDX-License-Identifier: Apache-2.0
// Where a document is filed and who can read it there, as an agent is told it (SPEC §13, §19).

import type * as admin from "firebase-admin";
import type { Principal } from "./auth";
import { canReadFolder, visibilityOf, type DocAclData, type FolderAclData } from "./acl";
import { grantLists, grantsOf, normalizeEmail } from "./access";
import { referencedTeamIds } from "./teams";

type Db = admin.firestore.Firestore;
type Snap = admin.firestore.DocumentSnapshot;

/**
 * Why this exists
 * ---------------
 * Filing a document into a folder shares it with everyone the folder is shared
 * with, and nobody is emailed: invitations go out only when sharing changes. So
 * the agent that filed it is the only party that can tell the person who just
 * gained access, and until this it could not see who that was.
 *
 * Nothing here discloses what the caller's browser could not already read. The
 * rules let a folder's members read its whole record, `members` included, and a
 * document's members read its own; a team's name is shown only to the team's
 * members, exactly as the share panel shows it.
 */

/** How many people are named before the rest are only counted. */
export const PEOPLE_SHOWN = 25;

/** What a hidden team is called: the share panel's words, never its size. */
export const UNNAMED_TEAM = "a team you are not in";

export interface FiledIn {
  id: string;
  path: string;
}

export interface Audience {
  /** Everyone in the effective read set, the owner included. */
  readers: number;
  /** The first PEOPLE_SHOWN of them, sorted. */
  people: string[];
  morePeople: number;
  /** Teams granted on the record or a folder above it, named only for their members. */
  teams: string[];
  /**
   * Set when a count would understate the audience: a public document is open to
   * anyone signed in, and an unlisted one to anyone holding its link.
   */
  alsoReadableBy?: "anyone signed in" | "anyone with the link";
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A folder and every folder above it that still exists, nearest first. */
async function folderChain(db: Db, folderId: string): Promise<Snap[]> {
  const folders = db.collection("folders");
  const [own] = await db.getAll(folders.doc(folderId));
  if (!own.exists) return [];
  const ancestors = strings(own.data()?.ancestors);
  const above = ancestors.length ? await db.getAll(...ancestors.map((id) => folders.doc(id))) : [];
  return [own, ...above.filter((s) => s.exists)];
}

/**
 * The path of each folder, naming only the levels the caller may read.
 *
 * A level the caller cannot read is `…`, as in `list_folders`: membership flows
 * downward, so a document can be readable while the folder holding it is not,
 * and its name is then not the caller's to know.
 */
export async function filedIn(
  db: Db,
  caller: Principal,
  folderIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, FiledIn>> {
  const ids = [...new Set(folderIds.filter((id): id is string => typeof id === "string" && id !== ""))];
  const out = new Map<string, FiledIn>();
  if (ids.length === 0) return out;
  const folders = db.collection("folders");
  const own = await db.getAll(...ids.map((id) => folders.doc(id)));
  const aboveIds = [...new Set(own.flatMap((s) => (s.exists ? strings(s.data()?.ancestors) : [])))];
  const above = aboveIds.length ? await db.getAll(...aboveIds.map((id) => folders.doc(id))) : [];
  const nameOf = new Map<string, string>();
  for (const s of [...own, ...above]) {
    if (s.exists && canReadFolder(s.data() as FolderAclData, caller.uid, caller.emailLower)) {
      nameOf.set(s.id, String(s.data()?.name ?? s.id));
    }
  }
  for (const s of own) {
    if (!s.exists) continue;
    const ancestors = strings(s.data()?.ancestors);
    const path = [...ancestors, s.id].map((id) => nameOf.get(id) ?? "…").join("/");
    out.set(s.id, { id: s.id, path });
  }
  return out;
}

/** The teams these grant lists name, as the caller may see them. */
async function teamsNamed(db: Db, caller: Principal, lists: string[][]): Promise<string[]> {
  const ids = referencedTeamIds(...lists);
  if (ids.length === 0) return [];
  const snaps = await db.getAll(...ids.map((id) => db.collection("teams").doc(id)));
  const named: string[] = [];
  let hidden = 0;
  for (const s of snaps) {
    if (!s.exists) continue; // a deleted team grants nothing
    const v = s.data() ?? {};
    const isMember =
      normalizeEmail(String(v.ownerEmail ?? "")) === caller.emailLower ||
      strings(v.members).map(normalizeEmail).includes(caller.emailLower);
    if (isMember) named.push(String(v.name ?? s.id));
    else hidden++;
  }
  return [...named.sort(), ...Array<string>(hidden).fill(UNNAMED_TEAM)];
}

function people(members: string[]): Pick<Audience, "readers" | "people" | "morePeople"> {
  const sorted = [...new Set(members)].sort();
  return {
    readers: sorted.length,
    people: sorted.slice(0, PEOPLE_SHOWN),
    morePeople: Math.max(0, sorted.length - PEOPLE_SHOWN),
  };
}

/** Who can read a document, read from the record as it stands after a write. */
export async function documentAudience(
  db: Db,
  caller: Principal,
  data: DocAclData & Record<string, unknown>,
): Promise<Audience> {
  const folderId = typeof data.folderId === "string" ? data.folderId : null;
  const chain = folderId ? await folderChain(db, folderId) : [];
  const teams = await teamsNamed(db, caller, [
    ...grantLists(grantsOf(data)),
    ...chain.flatMap((s) => grantLists(grantsOf(s.data()))),
  ]);
  const visibility = visibilityOf(data);
  return {
    ...people(strings(data.members)),
    teams,
    ...(visibility === "public"
      ? { alsoReadableBy: "anyone signed in" as const }
      : visibility === "unlisted"
        ? { alsoReadableBy: "anyone with the link" as const }
        : {}),
  };
}

/** Who can read a folder, the same way, for `get_folder`. */
export async function folderAudience(db: Db, caller: Principal, folder: Snap): Promise<Audience> {
  const ancestors = strings(folder.data()?.ancestors);
  const above = ancestors.length
    ? (await db.getAll(...ancestors.map((id) => db.collection("folders").doc(id)))).filter((s) => s.exists)
    : [];
  const teams = await teamsNamed(
    db,
    caller,
    [folder, ...above].flatMap((s) => grantLists(grantsOf(s.data()))),
  );
  return { ...people(strings(folder.data()?.members)), teams };
}

/** The first PEOPLE_SHOWN of a list, and how many more there are. */
export function firstPeople(list: unknown): { people: string[]; more: number } {
  const sorted = [...new Set(strings(list))].sort();
  return { people: sorted.slice(0, PEOPLE_SHOWN), more: Math.max(0, sorted.length - PEOPLE_SHOWN) };
}
