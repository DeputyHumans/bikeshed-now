// SPDX-License-Identifier: Apache-2.0
// The per-document export marking editor (SPEC §20).

import { useState } from "react";
import { Modal } from "./Modal";
import { useToast } from "./Toast";
import { setMarking } from "../marking";
import {
  FOOTER_PLACEHOLDERS,
  MAX_FOOTER,
  MAX_LABEL,
  SUGGESTED_FOOTER,
  SUGGESTED_LABEL,
  clampMarking,
} from "../export/labels";
import type { Marking } from "../types";

/**
 * Marking is DATA, per document, resolved at publish time.
 *
 * The design this replaces stamped one company's fixed confidentiality notice
 * on every export from a constant in the source. Making it data is what let
 * this product be open-sourced at all — and making it per-document is what
 * stops a reader's own default from overriding an owner's decision.
 */
export function MarkingDialog({
  docId,
  current,
  onClose,
  onChanged,
}: {
  docId: string;
  current: Marking;
  onClose: () => void;
  onChanged: (next: Marking) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Marking>(current);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const clamped = clampMarking(draft);
      await setMarking(docId, clamped);
      onChanged(clamped);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Marking on exports"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void save()}
          >
            Save
          </button>
        </>
      }
    >
      <div className="checkbox-row">
        <input
          id="marking-enabled"
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) =>
            setDraft({
              enabled: e.target.checked,
              // Offer a starting point rather than an empty box, but never
              // apply one automatically: an unasked-for "CONFIDENTIAL" on
              // somebody's public document would be its own kind of wrong.
              label: draft.label || SUGGESTED_LABEL,
              footer: draft.footer || SUGGESTED_FOOTER,
            })
          }
        />
        <label htmlFor="marking-enabled">
          <strong>Stamp exports of this document</strong>
          <span className="field-hint" style={{ display: "block" }}>
            Applies to PDF, PNG and SVG. It is set by the owner and does not
            depend on who exports.
          </span>
        </label>
      </div>

      {draft.enabled ? (
        <>
          <div className="field">
            <label className="field-label" htmlFor="marking-label">
              Corner label
            </label>
            <input
              id="marking-label"
              className="input"
              maxLength={MAX_LABEL}
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="marking-footer">
              Page footer
            </label>
            <textarea
              id="marking-footer"
              className="textarea"
              maxLength={MAX_FOOTER}
              value={draft.footer}
              onChange={(e) => setDraft({ ...draft, footer: e.target.value })}
            />
            <span className="field-hint">
              {FOOTER_PLACEHOLDERS.map((p) => `${p.token} — ${p.describes}`).join(" · ")}
            </span>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
