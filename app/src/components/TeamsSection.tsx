// SPDX-License-Identifier: Apache-2.0
// Creating teams and managing who is in them (SPEC §18).

import { useCallback, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { useToast } from "./Toast";
import { createTeam, deleteTeam, renameTeam, updateTeamMembers } from "../teams";
import type { TeamMeta } from "../types";

/**
 * A team is an access grant, so every change here changes who can read things.
 *
 * That is why each operation reports how many documents and folders it touched:
 * "removed" is a small word for an action that can revoke access to sixty
 * things, and the number is the only part of it a person can check.
 *
 * The server has supported all of this since teams existed — create, rename,
 * delete, add, remove, promote. What did not exist was anywhere to do it: the
 * account screen could add somebody through `window.prompt` and nothing else,
 * so a team could be filled and never emptied.
 */

type Role = "owner" | "admin" | "member";

function roleOf(team: TeamMeta, email: string): Role {
  if (team.ownerEmail === email) return "owner";
  return team.admins.includes(email) ? "admin" : "member";
}

/** Owner first, then admins, then everybody else, each group alphabetical. */
function orderedMembers(team: TeamMeta): string[] {
  const rank: Record<Role, number> = { owner: 0, admin: 1, member: 2 };
  return [...team.members].sort(
    (a, b) => rank[roleOf(team, a)] - rank[roleOf(team, b)] || a.localeCompare(b),
  );
}

function MemberRow({
  email,
  team,
  canManage,
  isYou,
  busy,
  onAdmin,
  onRemove,
}: {
  email: string;
  team: TeamMeta;
  canManage: boolean;
  isYou: boolean;
  busy: boolean;
  onAdmin: (isAdmin: boolean) => void;
  onRemove: () => void;
}) {
  const role = roleOf(team, email);
  return (
    <li className="member-row">
      <Icon name={role === "member" ? "eye" : "shield"} size={15} />
      <span className="share-principal">
        <span className="share-name">
          {email}
          {isYou ? <span className="share-sub"> (you)</span> : null}
        </span>
      </span>
      {role !== "member" ? (
        <span className={role === "owner" ? "chip chip-accent" : "chip"}>
          {role === "owner" ? "Owner" : "Admin"}
        </span>
      ) : null}
      {/* The owner has no controls at all. A team whose owner can be demoted or
          removed is a team that can end up with nobody able to fix it. */}
      {canManage && role !== "owner" ? (
        <span className="member-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            title={
              role === "admin"
                ? "An admin can add and remove people."
                : "An admin can add and remove people, and rename the team."
            }
            onClick={() => onAdmin(role !== "admin")}
          >
            {role === "admin" ? "Remove admin" : "Make admin"}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove ${email} from ${team.name}`}
            title={`Remove ${email}`}
            disabled={busy}
            onClick={onRemove}
          >
            <Icon name="close" size={15} />
          </button>
        </span>
      ) : null}
    </li>
  );
}

function TeamDialog({
  team,
  emailLower,
  onClose,
}: {
  team: TeamMeta;
  emailLower: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(team.name);
  const [invite, setInvite] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const canManage = roleOf(team, emailLower) !== "member";
  const isOwner = team.ownerEmail === emailLower;

  /**
   * Every change reports its blast radius.
   *
   * `affected` is the count of documents and folders the server recomputed. It
   * is the difference between "added Dana to Design" and "gave Dana access to
   * sixty-three things", and only one of those is what actually happened.
   */
  const run = useCallback(
    async (what: () => Promise<{ affected?: number }>, done: string) => {
      setBusy(true);
      try {
        const result = await what();
        toast.show(
          result.affected
            ? `${done} Access updated on ${result.affected} item${result.affected === 1 ? "" : "s"}.`
            : done,
        );
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const addMember = async () => {
    const email = invite.trim().toLowerCase();
    if (!email) return;
    setInvite("");
    await run(
      () => updateTeamMembers(team.teamId, { add: [email] }),
      `${email} is in ${team.name}.`,
    );
  };

  return (
    <Modal
      title={team.name}
      onClose={onClose}
      footer={
        <>
          <span className="caption">
            {team.members.length}{" "}
            {team.members.length === 1 ? "person" : "people"}
          </span>
          {/* One busy flag covers every control here, so one spinner says it. */}
          {busy ? <Spinner label="Saving" /> : null}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {!canManage ? (
        <div className="banner" role="note">
          Only {team.ownerEmail} and this team’s admins can change who is in it.
        </div>
      ) : (
        <div className="field">
          <label className="field-label" htmlFor="team-name">
            Name
          </label>
          <div className="field-row">
            <input
              id="team-name"
              className="input"
              value={name}
              maxLength={120}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || !name.trim() || name.trim() === team.name}
              onClick={() =>
                void run(
                  () => renameTeam(team.teamId, name.trim()).then(() => ({})),
                  "Renamed.",
                )
              }
            >
              Rename
            </button>
          </div>
        </div>
      )}

      <ul className="member-list">
        {orderedMembers(team).map((email) => (
          <MemberRow
            key={email}
            email={email}
            team={team}
            canManage={canManage}
            isYou={email === emailLower}
            busy={busy}
            onAdmin={(isAdmin) =>
              void run(
                () => updateTeamMembers(team.teamId, { admin: { email, isAdmin } }),
                isAdmin ? `${email} is an admin.` : `${email} is no longer an admin.`,
              )
            }
            onRemove={() =>
              void run(
                () => updateTeamMembers(team.teamId, { remove: [email] }),
                `${email} is out of ${team.name}.`,
              )
            }
          />
        ))}
      </ul>

      {canManage ? (
        <div className="field">
          <label className="field-label" htmlFor="team-invite">
            Add somebody
          </label>
          <div className="field-row">
            <input
              id="team-invite"
              className="input"
              type="email"
              placeholder="name@example.com"
              value={invite}
              disabled={busy}
              onChange={(e) => setInvite(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addMember();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !invite.trim()}
              onClick={() => void addMember()}
            >
              Add
            </button>
          </div>
          <span className="field-hint">
            {/* Said before it happens rather than after: this is the one action
                here whose consequence is invisible from this screen. */}
            They get everything this team has been granted, immediately, and an
            email telling them so.
          </span>
        </div>
      ) : null}

      {isOwner ? (
        <div className="field danger-zone">
          {confirmingDelete ? (
            <>
              <span className="field-hint">
                Deleting {team.name} revokes its access everywhere it was
                granted. People keep anything shared with them by name.
              </span>
              <div className="field-row">
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() => deleteTeam(team.teamId), `${team.name} is gone.`).then(
                      onClose,
                    )
                  }
                >
                  Delete {team.name}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Keep it
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              <Icon name="trash" size={14} /> Delete this team
            </button>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

export function TeamsSection({
  teams,
  emailLower,
}: {
  /** Null until the first snapshot, which is not the same as "none". */
  teams: TeamMeta[] | null;
  emailLower: string;
}) {
  const toast = useToast();
  const [managing, setManaging] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * The dialog reads the LIVE record rather than a copy taken when it opened,
   * so a change made inside it is reflected by the same Firestore listener that
   * feeds the list behind it. Nothing to keep in sync, and nothing to go stale.
   *
   * It also closes itself if the team disappears from under it — which is what
   * an admin removing their own membership looks like from here.
   */
  const open = useMemo(
    () => teams?.find((t) => t.teamId === managing) ?? null,
    [teams, managing],
  );

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await createTeam(name);
      setNewName("");
      setCreating(false);
      toast.show(`${name} created. Add people to it, then share with it by name.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ marginTop: "var(--s-5)" }}>
      <h2>Teams</h2>
      <p className="field-hint">
        {/* The consequence people do not expect, said before it happens: a
            team is an access grant, so adding somebody grants them everything
            the team already holds. */}
        A team is something you share with. Adding somebody gives them
        everything the team has been granted, immediately.
      </p>

      {teams === null ? (
        // In the line the answer will take, not inline beside the button below.
        <p className="field-hint">
          <Spinner label="Loading your teams" />
        </p>
      ) : teams.length === 0 ? (
        <p className="field-hint">
          You are not in any team yet. A team is worth making when the same
          group of people keeps appearing on the same documents.
        </p>
      ) : (
        <ul className="token-list">
          {teams.map((team) => {
            const role = roleOf(team, emailLower);
            return (
              <li key={team.teamId} className="token-row">
                <Icon name="team" size={15} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{team.name}</strong>
                  <span className="field-hint" style={{ display: "block" }}>
                    {team.members.length}{" "}
                    {team.members.length === 1 ? "person" : "people"}
                    {role === "member" ? "" : ` · you are the ${role}`}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setManaging(team.teamId)}
                >
                  {role === "member" ? "Who is in it" : "Manage"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {creating ? (
        <div className="field">
          <label className="field-label" htmlFor="new-team">
            Team name
          </label>
          <div className="field-row">
            <input
              id="new-team"
              className="input"
              placeholder="Design"
              value={newName}
              maxLength={120}
              autoFocus
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
                if (e.key === "Escape") setCreating(false);
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !newName.trim()}
              aria-busy={busy}
              onClick={() => void create()}
            >
              Create
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginTop: "var(--s-2)" }}
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" size={14} /> New team
        </button>
      )}

      {open ? (
        <TeamDialog team={open} emailLower={emailLower} onClose={() => setManaging(null)} />
      ) : null}
    </section>
  );
}
