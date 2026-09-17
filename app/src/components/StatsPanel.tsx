// SPDX-License-Identifier: Apache-2.0
// Reading statistics, and the activity feed built from them (SPEC §4, §17).

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import {
  formatDuration,
  formatRelative,
  listAclChanges,
  listDocViewers,
  listViewSessions,
} from "../firestore";
import type { AclChange, DocMeta, ViewSession, ViewerStat } from "../types";

/**
 * Two audiences, deliberately separated.
 *
 * The AGGREGATE rides on the document and every member sees it. The per-person
 * breakdown is editor-gated, because "who read this and for how long" is a
 * different kind of fact from "how many people read this", and open editing on
 * a public document must not hand it to a stranger.
 */

type Filter = "all" | "people" | "automation";

function ViewerRows({ viewers }: { viewers: ViewerStat[] }) {
  if (viewers.length === 0) return <p className="empty-state">Nobody has opened it yet.</p>;
  return (
    <ul className="activity-feed">
      {viewers.map((v) => (
        <li key={v.uid} className="activity-row">
          <span>{v.email}</span>
          <span className="caption">
            {v.views} {v.views === 1 ? "visit" : "visits"} · {formatDuration(v.totalMs)}
          </span>
          <span className="activity-when">{formatRelative(v.lastViewedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function describeAcl(change: AclChange): string {
  const parts: string[] = [];
  if (change.added.length) parts.push(`granted ${change.added.join(", ")}`);
  if (change.removed.length) parts.push(`removed ${change.removed.join(", ")}`);
  return parts.join(" and ") || "changed access";
}

export function StatsPanel({
  meta,
  canSeeDetail,
  onClose,
}: {
  meta: DocMeta;
  /** Owner or a real editor. Open editing does not qualify. */
  canSeeDetail: boolean;
  onClose: () => void;
}) {
  const [viewers, setViewers] = useState<ViewerStat[]>([]);
  const [sessions, setSessions] = useState<ViewSession[]>([]);
  const [aclChanges, setAclChanges] = useState<AclChange[]>([]);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    if (!canSeeDetail) return;
    void listDocViewers(meta.docId).then(setViewers).catch(() => setViewers([]));
    void listViewSessions(meta.docId).then(setSessions).catch(() => setSessions([]));
    void listAclChanges(meta.docId).then(setAclChanges).catch(() => setAclChanges([]));
  }, [meta.docId, canSeeDetail]);

  const stats = meta.stats;
  const identified = viewers.length;

  const filtered = sessions.filter((s) =>
    filter === "all" ? true : filter === "automation" ? s.automated : !s.automated,
  );

  return (
    <Modal title={`Activity on “${meta.title}”`} onClose={onClose} wide>
      <div className="stat-grid">
        <div className="stat-tile">
          <div className="stat-value">{stats?.views ?? 0}</div>
          {/* Sessions are counted; people are not. An anonymous reader has no
              identity to roll up, and no IP or fingerprint is collected to
              invent one. Saying both numbers is more honest than saying one. */}
          <div className="stat-label">
            visits{canSeeDetail && identified ? ` · ${identified} identified` : ""}
          </div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{formatDuration(stats?.totalMs)}</div>
          <div className="stat-label">time reading</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{stats?.commits ?? 0}</div>
          <div className="stat-label">versions published</div>
        </div>
        {stats?.apiReads ? (
          <div className="stat-tile">
            <div className="stat-value">{stats.apiReads}</div>
            {/* Counted separately and never folded into the human numbers: an
                agent fetching a document forty times would otherwise make both
                meaningless, and reading TIME has no meaning for a machine. */}
            <div className="stat-label">automated reads</div>
          </div>
        ) : null}
      </div>

      {!canSeeDetail ? (
        <p className="field-hint" style={{ marginTop: "var(--s-3)" }}>
          Only the owner and its editors can see who read this document.
        </p>
      ) : (
        <>
          <h3 style={{ marginTop: "var(--s-4)" }}>Readers</h3>
          <ViewerRows viewers={viewers} />

          <h3 style={{ marginTop: "var(--s-4)" }}>Recent activity</h3>
          <div className="pane-toggle" style={{ display: "inline-flex", marginBottom: "var(--s-2)" }}>
            {(["all", "people", "automation"] as Filter[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === "all" ? "Everything" : value === "people" ? "People" : "Automation"}
              </button>
            ))}
          </div>
          <ul className="activity-feed">
            {filtered.map((session) => (
              <li key={session.sessionId} className="activity-row">
                <Icon name="eye" size={14} />
                <span>{session.email ?? "somebody without an account"}</span>
                {session.automated ? (
                  <span className="badge-automated">via {session.actor?.channel}</span>
                ) : null}
                <span className="caption">
                  {session.versionId} · {formatDuration(session.ms)}
                </span>
                <span className="activity-when">{formatRelative(session.lastBeatAt)}</span>
              </li>
            ))}
            {aclChanges.map((change, i) => (
              <li key={`acl-${i}`} className="activity-row">
                <Icon name="share" size={14} />
                <span>
                  {change.actor?.email} {describeAcl(change)}
                </span>
                {change.actor && change.actor.channel !== "web" ? (
                  <span className="badge-automated">via {change.actor.channel}</span>
                ) : null}
                <span className="activity-when">{formatRelative(change.at)}</span>
              </li>
            ))}
            {filtered.length === 0 && aclChanges.length === 0 ? (
              <li className="empty-state">Nothing yet.</li>
            ) : null}
          </ul>
        </>
      )}
    </Modal>
  );
}
