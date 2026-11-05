// SPDX-License-Identifier: Apache-2.0
// Private, unlisted, or public — and until when — as a section of Share (SPEC §17).

import { useState } from "react";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { useToast } from "./Toast";
import { folderShareUrl, setFolderVisibility, setVisibility, shareUrl, type VisibilityState } from "../visibility";
import { endOfDayMs, expiryLabel, isExpired, sharingLabel, toDateInput } from "../expiry";
import type { InheritedReach, Visibility } from "../types";

/**
 * Each option says what it means in terms of WHO, not in terms of a setting
 * name. "Unlisted" tells a person nothing; "anyone with the link, signed in or
 * not" tells them exactly what they are agreeing to.
 */
type Option = {
  value: Visibility;
  title: string;
  describes: string;
  icon: "lock" | "eye" | "globe";
};

const OPTIONS: Option[] = [
  {
    value: "private",
    title: "Private",
    describes: "Only you and the people you share it with.",
    icon: "lock",
  },
  {
    value: "unlisted",
    title: "Anyone with the link",
    describes:
      "Readable without an account, by anyone holding the link. Not indexed by search engines.",
    icon: "eye",
  },
  {
    value: "public",
    title: "Public",
    describes:
      "Readable by anyone and listed in the sitemap. Search engines may index it, and AI crawlers may read it or train on it.",
    icon: "globe",
  },
];

/**
 * A folder's options say what they reach, because that is the surprise: not
 * the folder, but everything in it, at every depth, including what somebody
 * else filed there and what is filed tomorrow (SPEC §17 "A folder's reach").
 */
const FOLDER_OPTIONS: Option[] = [
  {
    value: "private",
    title: "Private",
    describes: "Only you and the people you share it with.",
    icon: "lock",
  },
  {
    value: "unlisted",
    title: "Anyone with the link",
    describes:
      "Everything in this folder and its subfolders can be read without an account by anyone holding the link. Not indexed by search engines.",
    icon: "eye",
  },
  {
    value: "public",
    title: "Public",
    describes:
      "Everything in this folder and its subfolders can be read by anyone and is listed in the sitemap. Search engines may index it, and AI crawlers may read it or train on it.",
    icon: "globe",
  },
];

/** Where a document's wider audience comes from, when a folder above it is shared. */
function ReachNote({ reach }: { reach: InheritedReach[] }) {
  if (reach.length === 0) return null;
  return (
    <ul className="reach-list" aria-label="Shared through its folders">
      {reach.map((r) => {
        const ended = r.expiresAt !== null && isExpired(r.expiresAt);
        const who = r.visibility === "public" ? "Anyone can read it" : "Anyone with the folder’s link can read it";
        const until = sharingLabel(r.expiresAt);
        return (
          <li key={r.folderId} className="field-hint" data-ended={ended || undefined}>
            <Icon name={r.visibility === "public" ? "globe" : "eye"} />{" "}
            {ended
              ? `“${r.path}” was shared ${r.visibility === "public" ? "publicly" : "by link"} until its date passed. That no longer reaches this document.`
              : `${who} through “${r.path}”${until ? ` (${until.toLowerCase()})` : ""}. Change that on the folder.`}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A section rather than a dialog of its own. It was one — "Who can see it…",
 * a second menu entry beside "Share…" — and the two asked one question from
 * two places, with the second found only by reading the overflow menu. The
 * share dialog holds it now, under the people. A folder has it too, without
 * open editing: what a folder's level opens is read-only, and its expiry ends
 * only that.
 */
export function VisibilitySection({
  target,
  current,
  inheritedReach = [],
  onChanged,
}: {
  target: { kind: "doc" | "folder"; id: string };
  current: VisibilityState;
  /** Folders above whose link or public level reaches this one, from GET /access. */
  inheritedReach?: InheritedReach[];
  onChanged: (next: VisibilityState) => void;
}) {
  const isFolder = target.kind === "folder";
  const toast = useToast();
  const [state, setState] = useState(current);
  const [busy, setBusy] = useState(false);

  /**
   * Every change sends the whole triple.
   *
   * The server writes visibility, open editing and expiry together, so a call
   * that left one of them out would clear it. Reading the current value from
   * `state` for the arguments not being changed is what keeps ticking a
   * checkbox from quietly removing a date somebody set last week.
   */
  const apply = async (
    visibility: Visibility,
    publicEdit: boolean,
    expiresAt: number | null,
  ) => {
    setBusy(true);
    try {
      const next = isFolder
        ? await setFolderVisibility(target.id, visibility, expiresAt)
        : await setVisibility(target.id, visibility, publicEdit, expiresAt);
      setState(next);
      onChanged(next);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const link = isFolder ? folderShareUrl(target.id, state) : shareUrl(target.id, state);

  return (
    <section aria-labelledby="visibility-heading" className="visibility-section">
      {/* The options only move once the server has answered, so until then
          this is what says the click registered. Beside the heading, not in
          it, so it never becomes part of the section's name. */}
      <div className="visibility-heading">
        <h3 id="visibility-heading">Who can see it</h3>
        {busy ? <Spinner label="Saving" /> : null}
      </div>
      <div className="visibility-options">
        {(isFolder ? FOLDER_OPTIONS : OPTIONS).map((option) => (
          <label
            key={option.value}
            className="visibility-option"
            data-selected={state.visibility === option.value}
          >
            <input
              type="radio"
              name="visibility"
              value={option.value}
              checked={state.visibility === option.value}
              disabled={busy}
              onChange={() => void apply(option.value, state.publicEdit, state.expiresAt)}
            />
            <Icon name={option.icon} />
            <span>
              <strong>{option.title}</strong>
              <span className="visibility-desc" style={{ display: "block" }}>
                {option.describes}
              </span>
            </span>
          </label>
        ))}
      </div>

      {state.visibility !== "private" ? (
        <>
          <div className="link-row">
            <input readOnly value={link} aria-label="Share link" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(link);
                toast.show("Link copied");
              }}
            >
              <Icon name="copy" />
              Copy
            </button>
          </div>

          {isFolder ? (
            <p className="field-hint" style={{ marginTop: "var(--s-3)" }}>
              That includes documents other people filed here, and anything
              filed here later. Readers get the documents only: commenting and
              editing still need you to share with them by name.
            </p>
          ) : (
          <div className="checkbox-row" style={{ marginTop: "var(--s-3)" }}>
            <input
              id="public-edit"
              type="checkbox"
              checked={state.publicEdit}
              disabled={busy}
              onChange={(e) => void apply(state.visibility, e.target.checked, state.expiresAt)}
            />
            <label htmlFor="public-edit">
              <strong>Let anyone with an account edit this</strong>
              <span className="field-hint" style={{ display: "block" }}>
                {/* Stated plainly, because this is the setting people misread.
                    "Anyone" here never means anonymous: every comment, highlight
                    and edit still requires a signed-in account, on every
                    document, whatever this box says. */}
                Editing always requires signing in. Readers without an account
                can read, and nothing else — that does not change.
              </span>
            </label>
          </div>
          )}
        </>
      ) : null}

      {state.visibility !== "private" ? (
        <p className="field-hint" style={{ marginTop: "var(--s-3)" }}>
          Making this private again takes up to five minutes to reach everyone,
          because published content is cached. Anyone already reading it keeps
          the copy they have.
        </p>
      ) : null}

      {!isFolder ? <ReachNote reach={inheritedReach} /> : null}

      {/* Expiry applies at every visibility, which is why it sits outside the
          branches above: a private document shared with six reviewers is
          exactly the kind that should stop being readable after the review. */}
      {/* A folder's date ends only what its level opens, so it means nothing
          on a private folder — unless one is already set and needs clearing. */}
      {!isFolder || state.visibility !== "private" || state.expiresAt !== null ? (
      <div className="expiry-row">
        <label htmlFor="expires-on">
          <strong>{isFolder ? "Stop sharing the link after" : "Stop being readable after"}</strong>
          <span className="field-hint" style={{ display: "block" }}>
            {/* The single most important sentence in this dialog. "Expire"
                reads as "delete" to almost everybody, and this product does not
                delete documents at all. */}
            {isFolder
              ? "Nothing is deleted. After this date the link stops working and the folder stops being public. The people you shared it with keep their access."
              : "Nothing is deleted. After this date only you can open it, and it cannot be edited until you change or clear the date."}
          </span>
        </label>
        <div className="link-row">
          <input
            id="expires-on"
            type="date"
            value={toDateInput(state.expiresAt)}
            min={toDateInput(Date.now() + 24 * 60 * 60 * 1000)}
            disabled={busy}
            onChange={(e) => {
              const at = endOfDayMs(e.target.value);
              // An emptied field clears it; a half-typed one is not a date yet
              // and must not be sent as one.
              if (e.target.value === "") void apply(state.visibility, state.publicEdit, null);
              else if (at !== null) void apply(state.visibility, state.publicEdit, at);
            }}
          />
          {state.expiresAt !== null ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void apply(state.visibility, state.publicEdit, null)}
            >
              Clear
            </button>
          ) : null}
        </div>
        {state.expiresAt !== null ? (
          <p className="field-hint">{isFolder ? sharingLabel(state.expiresAt) : expiryLabel(state.expiresAt)}</p>
        ) : null}
      </div>
      ) : null}
    </section>
  );
}
