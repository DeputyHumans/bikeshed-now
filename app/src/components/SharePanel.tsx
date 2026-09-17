// SPDX-License-Identifier: Apache-2.0
// Sharing: people and teams, side by side (SPEC §2, §18).

import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { useToast } from "./Toast";
import { setAccess } from "../access";
import { setFolderAccess } from "../folders";
import { logEvent } from "../analytics";
import type { Role, TeamMeta } from "../types";

/**
 * Teams and people live in ONE list, and a team shows its expansion inline.
 *
 * "Who can actually read this" must never require a second screen. A team grant
 * is legible as intent — "the Design team can view this" — but what it MEANS is
 * six named people, and the person deciding whether to share deserves to see
 * both without navigating away.
 */

export interface ShareTarget {
  kind: "doc" | "folder";
  id: string;
  title: string;
  ownerEmail: string;
  viewers: string[];
  editors: string[];
  /** Effective membership, so the expansion count is the real one. */
  members: string[];
}

function PrincipalRow({
  principal,
  role,
  teams,
  onRole,
  onRemove,
  disabled,
}: {
  principal: string;
  role: Role;
  teams: TeamMeta[];
  onRole: (role: Role) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const isTeam = principal.startsWith("team:");
  const team = isTeam ? teams.find((t) => t.teamId === principal.slice(5)) : undefined;

  return (
    <li className="share-row">
      <Icon name={isTeam ? "team" : "eye"} />
      <span className="share-principal">
        <span className="share-name">
          {isTeam ? (team?.name ?? `team ${principal.slice(5)}`) : principal}
        </span>
        {isTeam ? (
          <span className="share-sub">
            {team ? `${team.members.length} ${team.members.length === 1 ? "person" : "people"}` : "team no longer exists"}
          </span>
        ) : null}
      </span>
      <span className="share-role">
        <label className="visually-hidden" htmlFor={`role-${principal}`}>
          Access for {principal}
        </label>
        <select
          id={`role-${principal}`}
          className="toolbar-select"
          value={role}
          disabled={disabled}
          onChange={(e) => onRole(e.target.value as Role)}
        >
          <option value="viewer">Can read</option>
          <option value="editor">Can edit</option>
        </select>
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Remove ${principal}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <Icon name="close" />
      </button>
      {isTeam && team ? (
        <details className="team-expansion">
          <summary>Who that is</summary>
          {team.members.join(", ")}
        </details>
      ) : null}
    </li>
  );
}

export function SharePanel({
  target,
  teams,
  isOwner,
  onClose,
  onChanged,
}: {
  target: ShareTarget;
  teams: TeamMeta[];
  isOwner: boolean;
  onClose: () => void;
  onChanged: (next: { viewers: string[]; editors: string[] }) => void;
}) {
  const toast = useToast();
  const [viewers, setViewers] = useState(target.viewers);
  const [editors, setEditors] = useState(target.editors);
  const [input, setInput] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);

  const principals = useMemo(
    () => [
      ...editors.map((p) => ({ principal: p, role: "editor" as Role })),
      ...viewers.map((p) => ({ principal: p, role: "viewer" as Role })),
    ],
    [viewers, editors],
  );

  const apply = async (change: {
    add?: { principal: string; role: Role }[];
    remove?: string[];
  }) => {
    setBusy(true);
    try {
      const result =
        target.kind === "doc"
          ? await setAccess(target.id, change)
          : await setFolderAccess(target.id, change);
      setViewers(result.viewers);
      setEditors(result.editors);
      onChanged(result);
      for (const added of change.add ?? []) {
        logEvent({
          name: "share_grant",
          params: {
            role: added.role,
            principal: added.principal.startsWith("team:") ? "team" : "person",
          },
        });
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addPrincipal = async () => {
    const value = input.trim();
    if (!value) return;
    setInput("");
    await apply({ add: [{ principal: value, role }] });
  };

  return (
    <Modal
      title={`Share “${target.title}”`}
      onClose={onClose}
      footer={
        <>
          <span className="caption">
            {/* The effective set, not the grant list: a grant to a six-person
                team is one row and six readers, and the number that matters is
                the second one. */}
            {target.members.length}{" "}
            {target.members.length === 1 ? "person has" : "people have"} access
          </span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {!isOwner ? (
        <div className="banner" role="note">
          Only {target.ownerEmail} can change who has access.
        </div>
      ) : (
        <>
          <div className="field">
            <label className="field-label" htmlFor="share-input">
              Add a person or a team
            </label>
            <div style={{ display: "flex", gap: "var(--s-2)" }}>
              <input
                id="share-input"
                className="input"
                placeholder="name@example.com"
                list="bshd-teams"
                value={input}
                disabled={busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addPrincipal();
                  }
                }}
              />
              <datalist id="bshd-teams">
                {teams.map((t) => (
                  <option key={t.teamId} value={`team:${t.teamId}`}>
                    {t.name}
                  </option>
                ))}
              </datalist>
              <select
                className="toolbar-select"
                aria-label="Access level"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                <option value="viewer">Can read</option>
                <option value="editor">Can edit</option>
              </select>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !input.trim()}
                onClick={() => void addPrincipal()}
              >
                Add
              </button>
            </div>
            <span className="field-hint">
              Anything you share reaches them the moment they sign in with this
              address, whether or not they have an account yet.
            </span>
          </div>

          <ul className="share-list">
            <li className="share-row">
              <Icon name="shield" />
              <span className="share-principal">
                <span className="share-name">{target.ownerEmail}</span>
                <span className="share-sub">Owner — cannot be removed</span>
              </span>
            </li>
            {principals.map(({ principal, role: current }) => (
              <PrincipalRow
                key={principal}
                principal={principal}
                role={current}
                teams={teams}
                disabled={busy}
                onRole={(next) => void apply({ add: [{ principal, role: next }] })}
                onRemove={() => void apply({ remove: [principal] })}
              />
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
