// SPDX-License-Identifier: Apache-2.0
// Reading statistics, and the Activity feed: everything that happened to a document, who did it and through what (SPEC §4, §17).

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "./Modal";
import { Icon, type IconName } from "./Icon";
import { Loading } from "./Spinner";
import { formatDuration, formatRelative, formatTimestamp, listDocViewers } from "../firestore";
import { describeActivity, fetchActivity, subjectOf, type ActivityItem } from "../activity";
import { formatDay } from "../expiry";
import { viaOf } from "../provenance";
import type { DocMeta, ViewerStat } from "../types";

/**
 * Two audiences, deliberately separated.
 *
 * The AGGREGATE rides on the document and every member sees it. The per-person
 * breakdown is editor-gated, because "who read this and for how long" is a
 * different kind of fact from "how many people read this", and open editing on
 * a public document must not hand it to a stranger.
 *
 * The feed is one list, newest first, from GET /activity: every change the log
 * records and every reading session, each saying who acted and through what.
 * It used to be reading sessions followed by access changes, two lists in one,
 * and never said who published a version or whether a person or an agent did.
 */

type Filter = "all" | "people" | "automation";

const ICON: Record<string, IconName> = {
  read: "eye",
  "version.published": "upload",
  "version.withdrawn": "doc",
  "doc.renamed": "edit",
  "doc.moved": "folder",
  "doc.visibility": "globe",
  "doc.expiry": "clock",
  "doc.trust": "shield",
  "access.changed": "share",
  "fork.created": "fork",
};

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

function ActivityRow({ item, docId }: { item: ActivityItem; docId: string }) {
  const via = viaOf(item);
  const ms = item.at ? Date.parse(item.at) : NaN;
  // A fork is sent as its day alone (SPEC §21), a UTC date, so it is shown as
  // that date rather than as the hour before midnight west of Greenwich.
  const day = item.at?.length === 10 && Number.isFinite(ms) ? formatDay(ms, "UTC") : null;
  return (
    <li className="activity-row">
      <Icon name={ICON[item.type] ?? "comment"} size={14} />
      <span>{subjectOf(item)}</span>
      <span>{describeActivity(item)}</span>
      {via ? (
        // Server-derived, so stated as fact: the credential, in the words it
        // was given when it acted (provenance.ts).
        <span className="badge-automated" title={`Done through ${via}, not by a person in the browser`}>
          via {via}
        </span>
      ) : null}
      {item.version ? (
        <span className="caption">
          <Link to={`/d/${docId}/${item.version}`}>{item.version}</Link>
          {item.type === "read" && !item.automated ? ` · ${formatDuration(item.ms)}` : ""}
        </span>
      ) : null}
      {Number.isFinite(ms) ? (
        <time
          className="activity-when"
          dateTime={item.at ?? undefined}
          title={day ?? formatTimestamp(ms)}
        >
          {day ?? formatRelative(ms)}
        </time>
      ) : null}
    </li>
  );
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
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  // Until both are in, "Nobody has opened it yet" would be a guess.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!canSeeDetail) return;
    let live = true;
    void Promise.all([
      listDocViewers(meta.docId).then((v) => live && setViewers(v)).catch(() => live && setViewers([])),
      fetchActivity(meta.docId)
        .then((page) => {
          if (!live) return;
          setItems(page.items);
          setNext(page.next);
        })
        .catch((e: Error) => live && setFailed(e.message)),
    ]).then(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [meta.docId, canSeeDetail]);

  const loadMore = () => {
    if (!next || more) return;
    setMore(true);
    fetchActivity(meta.docId, next)
      .then((page) => {
        setItems((have) => [...have, ...page.items]);
        setNext(page.next);
      })
      .catch((e: Error) => setFailed(e.message))
      .finally(() => setMore(false));
  };

  const stats = meta.stats;
  const identified = viewers.length;
  // Every row, not only reads: an agent's grant is automation, a person's
  // publish is not.
  const shown = items.filter((i) =>
    filter === "all" ? true : filter === "automation" ? i.automated === true : i.automated !== true,
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
      ) : !loaded ? (
        <Loading label="Loading the activity" />
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
          {failed ? <p className="field-error">{failed}</p> : null}
          <ul className="activity-feed">
            {shown.map((item) => (
              <ActivityRow key={item.id} item={item} docId={meta.docId} />
            ))}
            {shown.length === 0 && !failed ? <li className="empty-state">Nothing yet.</li> : null}
          </ul>
          {next ? (
            <button type="button" className="btn btn-sm" disabled={more} aria-busy={more} onClick={loadMore}>
              Show earlier activity
            </button>
          ) : null}
        </>
      )}
    </Modal>
  );
}
