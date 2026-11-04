// SPDX-License-Identifier: Apache-2.0
// The account screen: preferences, teams, connected apps and access tokens (SPEC §14, §15, §18, §19, §23).

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { setAnalyticsOptOut } from "../analytics";
import { formatRelative, listMyTeams, saveUserProfile, watchMyTokens, watchUser } from "../firestore";
import { createToken, isUnused, revokeToken, type TokenChannel } from "../tokens";
import { clampMarking, SUGGESTED_FOOTER, SUGGESTED_LABEL } from "../export/labels";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/Spinner";
import { TeamsSection } from "../components/TeamsSection";
import { useToast } from "../components/Toast";
import { DEPLOYMENT_MARKING } from "../config";
import type { Marking, TeamMeta, TokenSummary, UserRecord } from "../types";

function TokenList({
  tokens,
  onRevoke,
}: {
  /** Null until the first snapshot, which is not the same as "none". */
  tokens: TokenSummary[] | null;
  onRevoke: (tokenId: string) => void;
}) {
  if (tokens === null) {
    return (
      <p className="field-hint">
        <Spinner label="Loading your tokens" />
      </p>
    );
  }
  if (tokens.length === 0) {
    return <p className="field-hint">No tokens or connected apps yet.</p>;
  }
  return (
    <ul className="token-list">
      {tokens.map((token) => {
        // A connected app (SPEC §23) shares the row and the Revoke, but says
        // where it lives rather than which channel it uses. Its name is the
        // app's own claim unless its host was checked, so it is quoted then.
        const app = token.kind === "oauth";
        return (
          <li
            key={token.tokenId}
            className="token-row"
            data-kind={app ? "app" : "token"}
            data-revoked={Boolean(token.revokedAt)}
          >
            <Icon name={app ? "link" : "key"} size={15} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{app && !token.clientVerified ? <q>{token.name}</q> : token.name}</strong>
              <span className="field-hint" style={{ display: "block" }}>
                {app ? (
                  <>
                    {token.clientHost ? (
                      <>
                        <span className="mono">{token.clientHost}</span> ·{" "}
                      </>
                    ) : null}
                    {/* ADR 0026: an organisation connected it, so say so, and say
                        what Revoke means here, because it is not undone by
                        the organisation trying again. */}
                    {token.managedBy ? "connected by your organisation" : "connected"}{" "}
                    {formatRelative(token.createdAt)} ·{" "}
                  </>
                ) : (
                  <>
                    {token.channel} · created {formatRelative(token.createdAt)} ·{" "}
                  </>
                )}
                {token.revokedAt ? (
                  token.managedBy ? (
                    "revoked · your organisation can't reconnect it"
                  ) : (
                    "revoked"
                  )
                ) : token.lastUsedAt ? (
                  `last used ${formatRelative(token.lastUsedAt)}`
                ) : (
                  // Surfaced deliberately: a token nobody has used is the one
                  // worth revoking, and it is invisible unless something says so.
                  <span className="token-unused">never used</span>
                )}
              </span>
            </span>
            {!token.revokedAt ? (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                title={
                  token.managedBy
                    ? "Your organisation won't be able to connect it for you again. You can still connect it yourself."
                    : undefined
                }
                onClick={() => onRevoke(token.tokenId)}
              >
                Revoke
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

interface SkillArchive {
  name: string;
  description: string;
  archive: string;
}

/** Only a zip under /skills/, named the way the build names one. */
const ARCHIVE_PATH = /^skills\/[a-z0-9][a-z0-9-]*\.zip$/;

function isSkillArchive(entry: unknown): entry is SkillArchive {
  const e = entry as Partial<SkillArchive> | null;
  return (
    typeof e?.name === "string" &&
    typeof e.description === "string" &&
    typeof e.archive === "string" &&
    ARCHIVE_PATH.test(e.archive)
  );
}

/**
 * The skill zips, from the same index the CLI reads. Empty when the index is
 * missing or unreadable, which hides the block rather than showing an error:
 * a deployment built before the zips existed simply has none to offer.
 */
function useSkillArchives(): SkillArchive[] {
  const [skills, setSkills] = useState<SkillArchive[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/skills/index.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((index: { skills?: unknown } | null) => {
        const list = Array.isArray(index?.skills) ? index.skills : [];
        if (live) setSkills(list.filter(isSkillArchive));
      })
      .catch(() => {
        if (live) setSkills([]);
      });
    return () => {
      live = false;
    };
  }, []);
  return skills;
}

/**
 * Connecting an app by its address (SPEC §23). Built from the LIVE origin:
 * Bikeshed is self-hosted, so a literal host would be wrong on every
 * deployment but one.
 */
function ConnectSection() {
  const toast = useToast();
  const origin = window.location.origin;
  const url = `${origin}/mcp`;
  const skills = useSkillArchives();

  return (
    <section style={{ marginTop: "var(--s-5)" }}>
      <h2>Connect an app</h2>
      <p className="field-hint">
        Add Bikeshed to Claude, ChatGPT or your editor with this address. You sign
        in and approve once, and there's nothing to paste after that.
      </p>
      <div className="connect-url">
        <span className="token-value mono">{url}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(url);
            toast.show("Address copied");
          }}
        >
          <Icon name="copy" size={14} /> Copy
        </button>
      </div>

      <div className="connect-guide">
        <details>
          <summary>Claude</summary>
          <p>
            On the web, in the desktop app or on your phone: Settings → Connectors
            → Add custom connector. Paste the address, and sign in when it asks.
          </p>
        </details>
        <details>
          <summary>ChatGPT</summary>
          <p>
            Settings → Apps &amp; Connectors → Advanced, and turn on Developer
            mode. Then create a connector with the address.
          </p>
        </details>
        <details>
          <summary>Claude Code</summary>
          <p>
            Run <code className="mono">claude mcp add --transport http bikeshed {url}</code>,
            then <code className="mono">/mcp</code> in Claude Code to sign in.
          </p>
        </details>
        <details>
          <summary>Cursor or VS Code</summary>
          <p>
            Add a server whose only setting is its <code className="mono">url</code>, set to
            the address. It asks you to sign in the first time you use it.
          </p>
        </details>
        <details>
          <summary>Terminal</summary>
          <p>
            Run <code className="mono">npx -y bikeshed-now login --origin {origin}</code>.
            It opens your browser so you can approve it here.
          </p>
        </details>
      </div>

      {skills.length > 0 ? (
        <div style={{ marginTop: "var(--s-4)" }}>
          <h3>Skills for Claude</h3>
          <p className="field-hint">
            Each one teaches Claude part of how Bikeshed works. Download it, then
            add it in Claude's settings under Skills.
          </p>
          <ul className="connect-skills">
            {skills.map((skill) => (
              <li key={skill.name}>
                <a href={`/${skill.archive}`} download>
                  <Icon name="download" size={14} />
                  {skill.name}
                </a>
                <span className="field-hint" style={{ display: "block" }}>
                  {skill.description}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function Account() {
  const { user, emailLower } = useAuth();
  const toast = useToast();

  const [record, setRecord] = useState<UserRecord | null>(null);
  const [teams, setTeams] = useState<TeamMeta[] | null>(null);
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [tokenChannel, setTokenChannel] = useState<TokenChannel>("cli");
  const [marking, setMarking] = useState<Marking>(DEPLOYMENT_MARKING);

  useEffect(() => {
    if (!user) return;
    const stopUser = watchUser(user.uid, (next) => {
      setRecord(next);
      setMarking(next?.defaultMarking ?? DEPLOYMENT_MARKING);
    });
    const stopTokens = watchMyTokens(user.uid, setTokens);
    const stopTeams = listMyTeams(emailLower, setTeams, () => setTeams([]));
    return () => {
      stopUser();
      stopTokens();
      stopTeams();
    };
  }, [user, emailLower]);

  if (!user) return null;

  const save = (fields: Partial<UserRecord>) =>
    saveUserProfile(user.uid, emailLower, fields).catch((e) =>
      toast.error((e as Error).message),
    );

  return (
    <div className="container">
      <h1>Account</h1>
      <p className="caption">{emailLower}</p>

      <section style={{ marginTop: "var(--s-5)" }}>
        <h2>Email</h2>
        <div className="checkbox-row">
          <input
            id="notify"
            type="checkbox"
            checked={record?.emailNotifications !== false}
            onChange={(e) => void save({ emailNotifications: e.target.checked })}
          />
          <label htmlFor="notify">
            Tell me when somebody comments
            <span className="field-hint" style={{ display: "block" }}>
              {/* Bounded by construction rather than by a preference screen: one
                  message per document per half hour, to the owner and the people
                  already in the thread. There is no digest and no notification
                  centre, deliberately. */}
              At most one message per document every half hour, and only for
              threads you own or have replied in.
            </span>
          </label>
        </div>
      </section>

      <section style={{ marginTop: "var(--s-5)" }}>
        <h2>Analytics</h2>
        <div className="checkbox-row">
          <input
            id="analytics"
            type="checkbox"
            checked={record?.analyticsOptOut === true}
            onChange={(e) => {
              void setAnalyticsOptOut(e.target.checked);
              void save({ analyticsOptOut: e.target.checked });
            }}
          />
          <label htmlFor="analytics">
            Do not count my usage
            <span className="field-hint" style={{ display: "block" }}>
              {/* Worth stating, because "analytics" usually means the opposite:
                  route patterns, never document ids, titles, slugs, folder names
                  or addresses. */}
              This deployment records which screens are used, never which
              documents. No title, address or link is ever sent.
            </span>
          </label>
        </div>
        {/* The per-device cookie choice is a DIFFERENT question from the
            account preference above, and somebody who already answered the
            banner has no other way back to it. Both live here so neither is a
            dead end. */}
        <p className="field-hint" style={{ marginTop: "var(--s-3)" }}>
          Cookie choices are per device and live on the{" "}
          <Link to="/privacy">privacy policy</Link> page. See also the{" "}
          <Link to="/terms">terms of service</Link>.
        </p>
      </section>

      <section style={{ marginTop: "var(--s-5)" }}>
        <h2>Marking on exports</h2>
        <p className="field-hint">
          Seeds each new document you create. Each document's own setting is what
          applies when somebody exports it.
        </p>
        <div className="checkbox-row">
          <input
            id="default-marking"
            type="checkbox"
            checked={marking.enabled}
            onChange={(e) => {
              const next = clampMarking({
                enabled: e.target.checked,
                label: marking.label || SUGGESTED_LABEL,
                footer: marking.footer || SUGGESTED_FOOTER,
              });
              setMarking(next);
              void save({ defaultMarking: next });
            }}
          />
          <label htmlFor="default-marking">Stamp new documents by default</label>
        </div>
      </section>

      <TeamsSection teams={teams} emailLower={emailLower} />

      <ConnectSection />

      <section style={{ marginTop: "var(--s-5)" }}>
        <h2>Access tokens</h2>
        <p className="field-hint">
          Tokens are for scripts, CI and anything that can't open a browser. Apps
          you connect are listed here too.{" "}
          {/* The security property, stated where somebody is about to create
              one: a token is not a lesser credential. */}
          A token can do exactly what you can do, and nothing more. Everything it
          touches is recorded against it, so revoking one tells you precisely
          what it did.
        </p>

        {minted ? (
          <div className="token-reveal" role="status">
            <span className="token-value mono">{minted}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(minted);
                toast.show("Token copied");
              }}
            >
              <Icon name="copy" size={14} /> Copy
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setMinted(null)}>
              Done
            </button>
          </div>
        ) : null}
        {minted ? (
          <p className="field-hint">
            This is the only time it is shown. It is stored as a hash, so nobody —
            including you — can read it back.
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "var(--s-2)", margin: "var(--s-3) 0" }}>
          <input
            className="input"
            placeholder="What is it for? e.g. laptop CLI"
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
          />
          <select
            className="toolbar-select"
            aria-label="Token kind"
            value={tokenChannel}
            onChange={(e) => setTokenChannel(e.target.value as TokenChannel)}
          >
            <option value="cli">Command line</option>
            <option value="mcp">Agent (MCP)</option>
            <option value="api">Other</option>
          </select>
          <button
            type="button"
            className="btn btn-primary"
            // Disabled while minting, or a double click mints two tokens.
            disabled={!tokenName.trim() || minting}
            aria-busy={minting}
            onClick={() => {
              setMinting(true);
              void createToken(tokenName.trim(), tokenChannel)
                .then((t) => {
                  setMinted(t.token);
                  setTokenName("");
                })
                .catch((e) => toast.error((e as Error).message))
                .finally(() => setMinting(false));
            }}
          >
            Create
          </button>
        </div>

        <TokenList
          tokens={tokens}
          onRevoke={(tokenId) =>
            void toast
              .during("Revoking…", revokeToken(tokenId))
              .then(() => toast.show("Revoked."))
              .catch((e) => toast.error((e as Error).message))
          }
        />
        {tokens?.some(isUnused) ? (
          <p className="field-hint token-unused">
            Some of these have never been used. If you do not remember creating
            one, revoke it.
          </p>
        ) : null}
      </section>
    </div>
  );
}
