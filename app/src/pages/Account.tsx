// SPDX-License-Identifier: Apache-2.0
// The account screen: preferences, teams, and access tokens (SPEC §14, §15, §18, §19).

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
import { MARKING_OFF } from "../export/labels";
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
    return <p className="field-hint">No tokens yet.</p>;
  }
  return (
    <ul className="token-list">
      {tokens.map((token) => (
        <li key={token.tokenId} className="token-row" data-revoked={Boolean(token.revokedAt)}>
          <Icon name="key" size={15} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>{token.name}</strong>
            <span className="field-hint" style={{ display: "block" }}>
              {token.channel} · created {formatRelative(token.createdAt)} ·{" "}
              {token.revokedAt ? (
                "revoked"
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
              onClick={() => onRevoke(token.tokenId)}
            >
              Revoke
            </button>
          ) : null}
        </li>
      ))}
    </ul>
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
  const [marking, setMarking] = useState<Marking>(MARKING_OFF);

  useEffect(() => {
    if (!user) return;
    const stopUser = watchUser(user.uid, (next) => {
      setRecord(next);
      if (next?.defaultMarking) setMarking(next.defaultMarking);
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

      <section style={{ marginTop: "var(--s-5)" }}>
        <h2>Access tokens</h2>
        <p className="field-hint">
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
