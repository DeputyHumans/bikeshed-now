// SPDX-License-Identifier: Apache-2.0
// Where a document came from, and what has been made from it (SPEC §21).

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Modal } from "./Modal";
import { Loading } from "./Spinner";
import type { Ancestor, ForkListing, Lineage } from "../forks";

/**
 * Two sections, two audiences.
 *
 * "Forked from" is for every reader, one hop at a time and only as far as they
 * could open: the walk stops at the first document they cannot, and says that
 * it stopped rather than skipping past it.
 *
 * "Forks" is the owner's. Every fork is COUNTED, so they know how far their
 * document has travelled; only the ones they can open are LISTED, because a
 * private fork is its own owner's business.
 */
export function ForksPanel({
  title,
  forked,
  isOwner,
  signedIn,
  lineage,
  failed,
  onRefresh,
  onClose,
}: {
  title: string;
  forked: boolean;
  isOwner: boolean;
  signedIn: boolean;
  lineage: Lineage | null;
  failed: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  // Fresh on every open: a fork made a minute ago belongs in the count.
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const body = !signedIn ? (
    <p className="field-hint">Sign in to see what this document was forked from.</p>
  ) : failed ? (
    <p className="field-hint">
      That did not load.{" "}
      <button type="button" className="btn btn-sm" onClick={onRefresh}>
        Try again
      </button>
    </p>
  ) : !lineage ? (
    <Loading label="Loading" />
  ) : (
    <>
      {forked ? <ForkedFrom lineage={lineage} /> : null}
      {isOwner && lineage.forks ? <Forks forks={lineage.forks} below={forked} /> : null}
    </>
  );

  return (
    <Modal title={`Forks of “${title}”`} onClose={onClose}>
      {body}
    </Modal>
  );
}

function ForkedFrom({ lineage }: { lineage: Lineage }) {
  const [parent] = lineage.ancestors;
  return (
    <section>
      <h3>Forked from</h3>
      {lineage.ancestors.length === 0 ? (
        <p className="field-hint">A document you can't open.</p>
      ) : (
        <ol className="activity-feed">
          {lineage.ancestors.map((a) => (
            <AncestorRow key={a.docId} ancestor={a} />
          ))}
          {lineage.hiddenAncestor ? (
            <li className="activity-row field-hint">…which was forked from a document you can't open.</li>
          ) : null}
        </ol>
      )}
      {parent?.changed ? (
        <p className="field-hint">
          The original has changed since this was forked.{" "}
          <Link to={`/d/${parent.docId}`}>See it as it is now</Link>
        </p>
      ) : null}
    </section>
  );
}

function AncestorRow({ ancestor }: { ancestor: Ancestor }) {
  return (
    <li className="activity-row">
      <Link to={`/d/${ancestor.docId}${ancestor.versionId ? `/${ancestor.versionId}` : ""}`}>
        {ancestor.title}
      </Link>
      <span className="caption">
        {[ancestor.versionId, ancestor.ownerEmail].filter(Boolean).join(" · ")}
      </span>
    </li>
  );
}

const VISIBILITY = { private: "Private", unlisted: "Link", public: "Public" } as const;

/**
 * How far a document has travelled, in one sentence. "Can't open" rather than
 * "private": an unlisted fork whose link the owner never had, and an expired
 * one, are hidden for the same reason a private one is.
 */
export function forkCountSentence(total: number, hidden: number): string {
  const times = total === 1 ? "once" : `${total} times`;
  if (hidden <= 0) return `Forked ${times}.`;
  if (hidden >= total) {
    return total === 1
      ? "Forked once, into a document you can't open."
      : `Forked ${times}, into documents you can't open.`;
  }
  return `Forked ${times}. The ${hidden === 1 ? "one" : hidden} you can't open ${hidden === 1 ? "isn't" : "aren't"} listed.`;
}

function Forks({
  forks,
  below,
}: {
  forks: NonNullable<Lineage["forks"]>;
  /** Spaced from "Forked from" when it follows it; flush when it is the whole panel. */
  below: boolean;
}) {
  return (
    <section style={below ? { marginTop: "var(--s-4)" } : undefined}>
      <h3>Forks</h3>
      {forks.total === 0 ? (
        <p className="field-hint">Nobody has forked it yet.</p>
      ) : (
        <>
          <p className="field-hint">{forkCountSentence(forks.total, forks.hidden)}</p>
          {forks.visible.length > 0 ? (
            <ul className="activity-feed">
              {forks.visible.map((f) => (
                <ForkRow key={f.docId} fork={f} />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

function ForkRow({ fork }: { fork: ForkListing }) {
  return (
    <li className="activity-row">
      <Link to={`/d/${fork.docId}`}>{fork.title}</Link>
      <span className="caption">
        {[VISIBILITY[fork.visibility], fork.ownerEmail].filter(Boolean).join(" · ")}
      </span>
      {fork.forkedAt ? (
        <span className="activity-when">
          {new Date(fork.forkedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
        </span>
      ) : null}
    </li>
  );
}
