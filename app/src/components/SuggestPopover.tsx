// SPDX-License-Identifier: Apache-2.0
// Writing a suggested edit: the form, and where it floats over the document (SPEC §22).

import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";

/**
 * The replacement is one line of text, because it is typed into the document
 * with `insertText`: a line break there would become a `<br>` or a new
 * paragraph, and the server refuses one. So Enter submits rather than adding a
 * line, and a pasted break becomes a space.
 */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ");

export function SuggestForm({
  exact,
  initial,
  initialNote = "",
  submitLabel,
  onSubmit,
  onCancel,
}: {
  /** The text being replaced, shown so the reader knows what they are rewriting. */
  exact: string;
  /** What the field starts with: the quote itself, or the current replacement. */
  initial: string;
  initialNote?: string;
  submitLabel: string;
  onSubmit: (replacement: string, note: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [replacement, setReplacement] = useState(initial);
  const [note, setNote] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const unchanged = replacement === exact;

  // Focused with the caret at the END, so the common edit — retyping a word
  // or adding one — starts where the reader's attention already is.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const submit = async () => {
    if (busy || unchanged) return;
    setBusy(true);
    try {
      await onSubmit(replacement, note.trim());
    } finally {
      setBusy(false);
    }
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="suggest-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <label className="field-label" htmlFor={`${id}-replacement`}>
        Replace “<span className="suggest-quote">{exact}</span>” with
      </label>
      <textarea
        id={`${id}-replacement`}
        ref={field}
        className="textarea"
        rows={2}
        value={replacement}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setReplacement(oneLine(e.target.value))}
        onKeyDown={keys}
      />
      <span className="field-hint" id={`${id}-hint`}>
        {replacement === "" ? "Left empty, this suggests deleting it." : "Leave it empty to suggest deleting it."}
      </span>
      <input
        className="input"
        aria-label="Note (optional)"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={keys}
      />
      <div className="suggest-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || unchanged} aria-busy={busy}>
          {submitLabel}
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export interface PopoverPosition {
  top: number;
  left: number;
  width: number;
}

/**
 * Where the form floats, as a pure function for the same reason `fabPosition`
 * is one: jsdom measures nothing, and placement is where the edge cases are.
 *
 * Below the selection, so the text being rewritten stays readable above the
 * form; above it when there is no room below; never off either side; and no
 * wider than the frame allows, so it works on a phone.
 */
export function popoverPosition(
  selection: { top: number; left: number; width: number; height: number },
  frame: { width: number; height: number },
  size: { width: number; height: number } = { width: 340, height: 200 },
): PopoverPosition {
  const gap = 8;
  const width = Math.max(0, Math.min(size.width, frame.width - 2 * gap));
  const below = selection.top + selection.height + gap;
  const top =
    below + size.height <= frame.height || selection.top - size.height - gap < 0
      ? below
      : selection.top - size.height - gap;
  const left = Math.max(gap, Math.min(selection.left, frame.width - width - gap));
  return { top, left, width };
}

/** The form, floating in the frame's stage: the parent's DOM, never the document's. */
export function SuggestPopover({
  position,
  docked = false,
  ...form
}: Parameters<typeof SuggestForm>[0] & {
  position: PopoverPosition;
  /** On a touch screen: a sheet above the docked selection bar, clear of the phone's own menu. */
  docked?: boolean;
}) {
  if (docked) {
    return createPortal(
      <div className="suggest-popover suggest-sheet" role="dialog" aria-label="Suggest an edit">
        <SuggestForm {...form} />
      </div>,
      document.body,
    );
  }
  return (
    <div
      className="suggest-popover"
      role="dialog"
      aria-label="Suggest an edit"
      style={{ top: position.top, left: position.left, width: position.width }}
    >
      <SuggestForm {...form} />
    </div>
  );
}
