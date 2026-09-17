// SPDX-License-Identifier: Apache-2.0
// Client for teams (SPEC §18).

import { post } from "./api";

/**
 * A team is an access GRANT, never a principal: a document always has a person
 * as owner. Granting to `team:{id}` records the intent; the server expands it
 * into the flat `members` array, so the Firestore list rule and the workspace
 * query are untouched by teams existing at all.
 */

export function createTeam(name: string): Promise<{ teamId: string; name: string }> {
  return post("/team", { op: "create", name });
}

export function renameTeam(teamId: string, name: string): Promise<{ ok: true }> {
  return post("/team", { op: "rename", teamId, name });
}

/**
 * Deleting a team revokes its access everywhere it was granted, immediately.
 * `affected` is how many documents and folders were recomputed — surfaced
 * because "you just changed access to 63 things" deserves to be visible.
 */
export function deleteTeam(teamId: string): Promise<{ ok: true; affected: number }> {
  return post("/team", { op: "delete", teamId });
}

export interface TeamMembership {
  members: string[];
  admins: string[];
  affected: number;
}

export function updateTeamMembers(
  teamId: string,
  change: { add?: string[]; remove?: string[]; admin?: { email: string; isAdmin: boolean } },
): Promise<TeamMembership> {
  return post(
    "/team-members",
    { teamId, ...change },
    { forbidden: "Only a team owner or admin can change its members." },
  );
}

/** Format a grant for display: `team:abc` reads as the team's name. */
export function principalLabel(
  principal: string,
  teamName: (id: string) => string | undefined,
): string {
  if (!principal.startsWith("team:")) return principal;
  const id = principal.slice(5);
  return teamName(id) ?? `team ${id}`;
}
