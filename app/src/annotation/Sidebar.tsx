// SPDX-License-Identifier: Apache-2.0
// The comments panel: threads, replies, resolve, and who is typing (SPEC §6, §16, §17).

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { addComment, listComments, setResolved } from "../firestore";
import { peerColor } from "../brand/tokens";
import { formatRelative } from "../firestore";
import { logEvent } from "../analytics";
import type { Annotation, Comment } from "../types";
import type { Peer } from "../presence";

/**
 * A thread carries its author's colour, the same value that paints their
 * presence chip, their live caret, their rail marker and the edge of the
 * highlight in the document. Five surfaces, one colour, derived from the
 * address so it is stable between sessions.
 */

function CommentAuthor({ comment }: { comment: Comment }) {
  const via = comment.actor?.channel;
  return (
    <div className="comment-head">
      <span className="comment-author">{comment.authorEmail}</span>
      {via && via !== "web" ? (
        // Server-derived, so it can be stated as fact. The self-reported client
        // and agent strings beside it get no badge, because a badge implying
        // verification it does not have is worse than no badge.
        <span className="badge-automated" title={`Posted through the ${via.toUpperCase()} interface`}>
          via {via}
        </span>
      ) : null}
      {comment.actor?.agent ? (
        <span className="self-reported" title="Self-reported by the client">
          {comment.actor.agent}
        </span>
      ) : null}
      <span>{formatRelative(comment.createdAt)}</span>
    </div>
  );
}

function Thread({
  docId,
  versionId,
  annotation,
  selected,
  canComment,
  orphaned,
  composingPeers,
  uid,
  emailLower,
  onSelect,
  onComposing,
}: {
  docId: string;
  versionId: string;
  annotation: Annotation;
  selected: boolean;
  canComment: boolean;
  orphaned: boolean;
  composingPeers: Peer[];
  uid: string | null;
  emailLower: string;
  onSelect: () => void;
  onComposing: (threadId: string | null) => void;
}) {
  const toast = useToast();
  const [comments, setComments] = useState<Comment[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLLIElement>(null);

  useEffect(
    () => listComments(docId, versionId, annotation.annId, setComments),
    [docId, versionId, annotation.annId],
  );

  // A selected thread scrolls itself into view, because selection usually came
  // from clicking a highlight in the document rather than from this list.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const send = async () => {
    const body = reply.trim();
    // Enter reaches here without the button's `disabled`, so the guard is here:
    // a second Enter while the first is in flight would post the reply twice.
    if (!body || !uid || busy) return;
    setBusy(true);
    try {
      await addComment(docId, versionId, annotation.annId, body, uid, emailLower);
      logEvent({ name: "comment_create", params: {} });
      setReply("");
      onComposing(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      ref={ref}
      className="thread"
      aria-selected={selected}
      data-resolved={annotation.resolved}
      style={{ ["--thread-color" as string]: peerColor(annotation.authorEmail) }}
      onClick={onSelect}
    >
      {annotation.anchor.exact ? (
        <p className="thread-quote">
          {orphaned ? <em>(no longer in the text) </em> : null}
          {annotation.anchor.exact}
        </p>
      ) : null}

      {comments.map((comment) => (
        <div key={comment.commentId} className="comment">
          <CommentAuthor comment={comment} />
          <p className="comment-body">{comment.body}</p>
        </div>
      ))}

      {composingPeers.map((peer) => (
        <p
          key={peer.uid}
          className="thread-composing"
          style={{ ["--peer-color" as string]: peer.color }}
        >
          <span className="presence-dot" />
          {peer.name} is replying…
        </p>
      ))}

      {canComment ? (
        <>
          <textarea
            className="textarea"
            rows={2}
            placeholder="Reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onFocus={() => onComposing(annotation.annId)}
            onBlur={() => onComposing(null)}
            onKeyDown={(e) => {
              // Enter sends; Shift-Enter is a newline. The overwhelmingly common
              // case is one line, and reaching for a button for it is friction.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="thread-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !reply.trim()}
              aria-busy={busy}
              onClick={(e) => {
                e.stopPropagation();
                void send();
              }}
            >
              Reply
            </button>
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={(e) => {
                e.stopPropagation();
                void setResolved(docId, versionId, annotation.annId, !annotation.resolved);
              }}
            >
              <Icon name="check" size={14} />
              {annotation.resolved ? "Reopen" : "Resolve"}
            </button>
          </div>
        </>
      ) : null}
    </li>
  );
}

export function Sidebar({
  docId,
  versionId,
  annotations,
  orphaned,
  selectedId,
  canComment,
  signedIn,
  peers,
  uid,
  emailLower,
  onSelect,
  onComposing,
  onSignIn,
  onClose,
}: {
  docId: string;
  versionId: string;
  annotations: Annotation[];
  orphaned: string[];
  selectedId: string | null;
  canComment: boolean;
  signedIn: boolean;
  peers: Peer[];
  uid: string | null;
  emailLower: string;
  onSelect: (annId: string | null) => void;
  onComposing: (threadId: string | null) => void;
  onSignIn: () => void;
  onClose: () => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const orphanSet = useMemo(() => new Set(orphaned), [orphaned]);

  const visible = annotations.filter((a) => showResolved || !a.resolved);
  const openCount = annotations.filter((a) => !a.resolved).length;

  return (
    <aside className="comments-panel" aria-label="Comments">
      <div className="comments-head">
        <span className="comments-count">
          {openCount} open{annotations.length > openCount ? ` · ${annotations.length - openCount} resolved` : ""}
        </span>
        <button
          type="button"
          className="btn btn-quiet btn-sm"
          aria-pressed={showResolved}
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? "Hide resolved" : "Show resolved"}
        </button>
        <button type="button" className="icon-btn" aria-label="Close comments" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="empty-state">
          Select any passage in the document to comment on it.
        </p>
      ) : (
        <ul className="comments-list">
          {visible.map((annotation) => (
            <Thread
              key={annotation.annId}
              docId={docId}
              versionId={versionId}
              annotation={annotation}
              selected={selectedId === annotation.annId}
              canComment={canComment}
              orphaned={orphanSet.has(annotation.annId)}
              composingPeers={peers.filter((p) => p.composing === annotation.annId)}
              uid={uid}
              emailLower={emailLower}
              onSelect={() => onSelect(annotation.annId)}
              onComposing={onComposing}
            />
          ))}
        </ul>
      )}

      {!signedIn ? (
        <div className="signin-to-comment">
          {/* The selection is preserved across this prompt, and the comment
              posts afterwards. A "sign in to comment" that loses what you
              highlighted is where the feature dies (SPEC §17). */}
          <strong>Sign in to comment.</strong> Your selection is kept.
          <div style={{ marginTop: "var(--s-2)" }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={onSignIn}>
              Sign in
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
