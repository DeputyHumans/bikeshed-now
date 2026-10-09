// SPDX-License-Identifier: Apache-2.0
// Sharing: people and teams, and who else can see it (SPEC §2, §17, §18).

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { useToast } from "./Toast";
import { VisibilitySection } from "./VisibilitySection";
import { inheritedAccess, setAccess } from "../access";
import { inheritedFolderAccess, setFolderAccess } from "../folders";
import { logEvent } from "../analytics";
import type { VisibilityState } from "../visibility";
import { GRANT_LIST, ROLES, ROLE_HINT, ROLE_LABEL, grantsOf, type RoleGrants } from "../roles";
import type { InheritedGrant, Role, TeamMeta } from "../types";

/**
 * Teams and people live in ONE list, and a team shows its expansion inline.
 *
 * "Who can actually read this" must never require a second screen. A team grant
 * is legible as intent — "the Design team can view this" — but what it MEANS is
 * six named people, and the person deciding whether to share deserves to see
 * both without navigating away.
 *
 * For a document the same dialog also holds the visibility level, the link,
 * open editing and the expiry, under the people: one question, asked once.
 */

export interface ShareTarget {
  kind: "doc" | "folder";
  id: string;
  title: string;
  ownerEmail: string;
  viewers: string[];
  editors: string[];
  /** Absent on a record written before the role existed. */
  suggesters?: string[];
  approvers?: string[];
  /** Effective membership, so the expansion count is the real one. */
  members: string[];
}

/** Every role as a select option, lowest first, as the ladder reads. */
function RoleOptions() {
  return (
    <>
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABEL[r]}
        </option>
      ))}
    </>
  );
}

/** What a grant's row calls it, for a direct grant and an inherited one alike. */
function describePrincipal(principal: string, teams: TeamMeta[]) {
  const isTeam = principal.startsWith("team:");
  const team = isTeam ? teams.find((t) => t.teamId === principal.slice(5)) : undefined;
  // What this row IS, said once. It is also what the accessible names use: a
  // screen reader was being read "Remove team colon" and twenty characters of
  // base-62, which is the same defect as showing the id, only worse.
  const label = isTeam ? (team?.name ?? `team ${principal.slice(5)}`) : principal;
  const size = !isTeam
    ? null
    : team
      ? `${team.members.length} ${team.members.length === 1 ? "person" : "people"}`
      : // A team is readable only by its own members, so an unresolved
        // grant means one of two things and the interface cannot tell
        // them apart. Saying which it might be beats asserting the
        // wrong one.
        "deleted, or a team you are not in";
  return { isTeam, team, label, size };
}

/**
 * A grant made on a folder above, so it is changed there and not here: no
 * select and no remove. A person granted directly as well gets both rows,
 * because removing the direct grant leaves this one, and the dialog must not
 * let that look like removing them.
 */
function InheritedRow({ grant, teams }: { grant: InheritedGrant; teams: TeamMeta[] }) {
  const { isTeam, label, size } = describePrincipal(grant.principal, teams);
  // The server writes `…` for a level the owner cannot open, so a path whose
  // last level is one is a folder this person may not know the name of.
  const hidden = grant.path === "…" || grant.path.endsWith("/…");
  const via = hidden ? "via a folder you cannot open" : `via ${grant.path}`;
  return (
    <li className="share-row">
      <Icon name={isTeam ? "team" : "eye"} />
      <span className="share-principal">
        <span className="share-name">{label}</span>
        {size ? <span className="share-sub">{size}</span> : null}
        <span className="share-sub">{via}</span>
      </span>
      <span className="share-role share-sub">{ROLE_LABEL[grant.role]}</span>
    </li>
  );
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
  const { isTeam, team, label, size } = describePrincipal(principal, teams);

  return (
    <li className="share-row">
      <Icon name={isTeam ? "team" : "eye"} />
      <span className="share-principal">
        <span className="share-name">{label}</span>
        {size ? <span className="share-sub">{size}</span> : null}
      </span>
      <span className="share-role">
        <label className="visually-hidden" htmlFor={`role-${principal}`}>
          Access for {label}
        </label>
        <select
          id={`role-${principal}`}
          className="toolbar-select"
          value={role}
          disabled={disabled}
          onChange={(e) => onRole(e.target.value as Role)}
        >
          <RoleOptions />
        </select>
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Remove ${label}`}
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

/**
 * What somebody typed, as the server wants it stored.
 *
 * Three accepted forms, in the order they are distinguishable: the stored
 * `team:{id}` verbatim, because the CLI and the agent surface document it and
 * somebody pasting one should not be second-guessed; anything with an `@` as an
 * address; and everything else as a team NAME. An address is the only one of
 * the three whose shape is unambiguous, which is why it is tested before the
 * lookup rather than after.
 */
function resolvePrincipal(value: string, teamByName: Map<string, TeamMeta>): string | null {
  if (value.startsWith("team:")) return value;
  if (value.includes("@")) return value.toLowerCase();
  const team = teamByName.get(value.toLowerCase());
  return team ? `team:${team.teamId}` : null;
}

/** What the level lets in beyond the people listed, for the footer's count. */
function beyondThePeople(visibility: VisibilityState["visibility"]): string {
  if (visibility === "public") return ", and anyone";
  if (visibility === "unlisted") return ", and anyone with the link";
  return "";
}

export function SharePanel({
  target,
  teams,
  isOwner,
  visibility,
  onClose,
  onChanged,
}: {
  target: ShareTarget;
  teams: TeamMeta[];
  isOwner: boolean;
  /** A document's level, link, open editing and expiry. Folders have none, and pass none. */
  visibility?: VisibilityState;
  onClose: () => void;
  onChanged: (next: RoleGrants) => void;
}) {
  const toast = useToast();
  const [grants, setGrants] = useState<RoleGrants>(() => grantsOf(target));
  const [input, setInput] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  // What the folders above give, which only the server can say: the owner may
  // not be able to open them, and the record holds only the flattened result.
  const [inherited, setInherited] = useState<InheritedGrant[]>([]);
  const [inheritedFailed, setInheritedFailed] = useState(false);
  useEffect(() => {
    if (!isOwner) return;
    let live = true;
    const read = target.kind === "doc" ? inheritedAccess : inheritedFolderAccess;
    void read(target.id).then(
      (rows) => live && setInherited(rows),
      () => live && setInheritedFailed(true),
    );
    return () => {
      live = false;
    };
  }, [isOwner, target.kind, target.id]);
  // Followed here only for the footer: the section owns the editing of it.
  const [level, setLevel] = useState(visibility?.visibility ?? "private");
  const showsVisibility = visibility !== undefined && target.kind === "doc";

  /**
   * Teams are entered BY NAME and stored as `team:{id}`.
   *
   * The picker used to offer the stored form directly, so choosing a team from
   * the list filled the box with `team:` and twenty-odd random characters — the
   * one string in this dialog that means nothing to the person reading it. The
   * id is an implementation detail of the grant; the name is the grant.
   */
  const teamByName = useMemo(() => {
    const byName = new Map<string, TeamMeta>();
    for (const t of teams) byName.set(t.name.trim().toLowerCase(), t);
    return byName;
  }, [teams]);

  // Highest role first: who can do the most is what the owner checks first.
  const principals = useMemo(
    () =>
      [...ROLES]
        .reverse()
        .flatMap((r) => grants[GRANT_LIST[r]].map((p) => ({ principal: p, role: r }))),
    [grants],
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
      const next = grantsOf(result);
      setGrants(next);
      onChanged(next);
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
    const principal = resolvePrincipal(value, teamByName);
    if (!principal) {
      toast.error(
        `No team called “${value}”. Add a person by email address, or a team by its name.`,
      );
      return;
    }
    setInput("");
    await apply({ add: [{ principal, role }] });
  };

  return (
    <Modal
      title={`Share “${target.title}”`}
      onClose={onClose}
      // Wide when the levels are in it, so the three of them sit side by side
      // and a private document's whole dialog fits a laptop screen.
      wide={showsVisibility}
      footer={
        <>
          <span className="caption">
            {/* The effective set, not the grant list: a grant to a six-person
                team is one row and six readers, and the number that matters is
                the second one. And only the whole truth for a private
                document — the level can let in everybody else. */}
            {target.members.length}{" "}
            {showsVisibility && level !== "private"
              ? `${target.members.length === 1 ? "person" : "people"}${beyondThePeople(level)}`
              : `${target.members.length === 1 ? "person has" : "people have"} access`}
          </span>
          {/* One busy flag covers every row, so one spinner says it. */}
          {busy ? <Spinner label="Saving" /> : null}
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
            <div className="field-row">
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
              {/* Values, not labels. A datalist shows the VALUE as the
                  primary line and fills the box with it on selection, so a
                  label here would have been decoration over the id. */}
              <datalist id="bshd-teams">
                {teams.map((t) => (
                  <option key={t.teamId} value={t.name} />
                ))}
              </datalist>
              <select
                className="toolbar-select"
                aria-label="Access level"
                aria-describedby="share-role-hint"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                <RoleOptions />
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
            <span className="field-hint" id="share-role-hint">
              {ROLE_LABEL[role]}: {ROLE_HINT[role]}
            </span>
            <span className="field-hint">
              Anything you share reaches them the moment they sign in with this
              address, whether or not they have an account yet.
              {teams.length > 0 ? (
                <>
                  {" "}
                  Type a team’s name to share with everyone in it —{" "}
                  <Link to="/account">manage your teams</Link>.
                </>
              ) : null}
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
            {inherited.map((grant) => (
              <InheritedRow
                key={`${grant.folderId}:${grant.principal}`}
                grant={grant}
                teams={teams}
              />
            ))}
          </ul>
          {inheritedFailed ? (
            <p className="caption">Could not load who has access through its folders.</p>
          ) : null}

          {showsVisibility ? (
            <VisibilitySection
              docId={target.id}
              current={visibility}
              onChanged={(next) => setLevel(next.visibility)}
            />
          ) : null}
        </>
      )}
    </Modal>
  );
}
