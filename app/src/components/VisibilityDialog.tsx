// SPDX-License-Identifier: Apache-2.0
// Private, unlisted, or public — and what each actually means (SPEC §17).

import { useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { useToast } from "./Toast";
import { setVisibility, shareUrl, type VisibilityState } from "../visibility";
import type { Visibility } from "../types";

/**
 * Each option says what it means in terms of WHO, not in terms of a setting
 * name. "Unlisted" tells a person nothing; "anyone with the link, signed in or
 * not" tells them exactly what they are agreeing to.
 */
const OPTIONS: {
  value: Visibility;
  title: string;
  describes: string;
  icon: "lock" | "eye" | "globe";
}[] = [
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
    describes: "Readable by anyone, indexed by search engines, and listed in the sitemap.",
    icon: "globe",
  },
];

export function VisibilityDialog({
  docId,
  current,
  onClose,
  onChanged,
}: {
  docId: string;
  current: VisibilityState;
  onClose: () => void;
  onChanged: (next: VisibilityState) => void;
}) {
  const toast = useToast();
  const [state, setState] = useState(current);
  const [busy, setBusy] = useState(false);

  const apply = async (visibility: Visibility, publicEdit: boolean) => {
    setBusy(true);
    try {
      const next = await setVisibility(docId, visibility, publicEdit);
      setState(next);
      onChanged(next);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const link = shareUrl(docId, state);

  return (
    <Modal
      title="Who can see this"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="visibility-options">
        {OPTIONS.map((option) => (
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
              onChange={() => void apply(option.value, state.publicEdit)}
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

          <div className="checkbox-row" style={{ marginTop: "var(--s-3)" }}>
            <input
              id="public-edit"
              type="checkbox"
              checked={state.publicEdit}
              disabled={busy}
              onChange={(e) => void apply(state.visibility, e.target.checked)}
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
        </>
      ) : null}

      {state.visibility !== "private" ? (
        <p className="field-hint" style={{ marginTop: "var(--s-3)" }}>
          Making this private again takes up to five minutes to reach everyone,
          because published content is cached. Anyone already reading it keeps
          the copy they have.
        </p>
      ) : null}
    </Modal>
  );
}
