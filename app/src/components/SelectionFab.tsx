// SPDX-License-Identifier: Apache-2.0
// The "comment on this" and "suggest an edit" affordance that follows a selection (SPEC §6, §22).

import { createPortal } from "react-dom";
import { useCoarsePointer } from "../hooks/useMediaQuery";
import { useEffect, useState } from "react";
import { watchScroll, watchSelection } from "../viewer/frameWatch";
import { suggestibleRange, trimToText } from "../annotation/exact";
import { Icon } from "./Icon";

export interface FabPosition {
  top: number;
  left: number;
}

/**
 * Where the button goes, as a pure function.
 *
 * Extracted because jsdom's getBoundingClientRect returns zeros, so the
 * placement is untestable in the component but perfectly testable here — and
 * placement is exactly the part with edge cases: a selection at the top of the
 * document has no room above it, and one at the right edge would push the
 * button off screen.
 */
export function fabPosition(
  selection: { top: number; left: number; width: number; height: number },
  frame: { width: number; height: number },
  fab: { width: number; height: number } = { width: 150, height: 34 },
): FabPosition {
  const gap = 8;
  const preferredTop = selection.top - fab.height - gap;
  const top =
    preferredTop >= 0 ? preferredTop : selection.top + selection.height + gap;
  const centred = selection.left + selection.width / 2 - fab.width / 2;
  const left = Math.max(gap, Math.min(centred, frame.width - fab.width - gap));
  return { top: Math.min(top, frame.height - fab.height - gap), left };
}

export function SelectionFab({
  doc,
  epoch,
  enabled,
  onComment,
  label = "Comment",
  suggest,
}: {
  doc: Document | null;
  epoch: number;
  enabled: boolean;
  onComment: () => void;
  label?: string;
  /**
   * Offered beside Comment when this reader may suggest (SPEC §22). Never
   * disabled outright: a selection it cannot take is said, on press, rather
   * than greyed out — a disabled button cannot explain itself reliably.
   */
  suggest?: { onSuggest: () => void; onRefused: (reason: string) => void };
}) {
  const [position, setPosition] = useState<FabPosition | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // On a touch screen the phone's own Copy/Share menu sits just above the
  // selection, exactly where this would float, and covers it. There the
  // controls dock at the bottom of the screen instead, clear of it.
  const docked = useCoarsePointer();

  useEffect(() => {
    if (!enabled || !doc) {
      setPosition(null);
      return;
    }
    const update = () => {
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setPosition(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPosition(null);
        return;
      }
      // Judged as it will be anchored: trimmed of the whitespace a drag takes with it.
      const verdict = suggestibleRange(trimToText(range));
      setRefusal(verdict === true ? null : verdict.reason);
      const view = doc.defaultView;
      setPosition(
        fabPosition(
          rect,
          { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
          { width: suggest ? 250 : 150, height: 34 },
        ),
      );
    };
    // Watched rather than listened for: an engine that delivers a sandboxed
    // document no events would otherwise never show this at all.
    const stopSelection = watchSelection(doc, update);
    const stopScroll = watchScroll(doc, update);
    return () => {
      stopSelection();
      stopScroll();
    };
  }, [enabled, doc, epoch, suggest !== undefined]);

  if (!position) return null;
  // Pointer-down rather than click: a click first collapses the selection
  // in some engines, and the selection is the entire point. A click with no
  // pointer behind it (`detail` 0) is the keyboard's, and is the only click
  // acted on, so a pointer press is never handled twice.
  const keyboardOnly = (run: () => void) => (e: React.MouseEvent) => {
    if (e.detail === 0) run();
  };
  const trySuggest = () => {
    if (!suggest) return;
    if (refusal) suggest.onRefused(refusal);
    else suggest.onSuggest();
  };
  const commentButton = (
    <button
      type="button"
      className="selection-fab"
      style={suggest || docked ? undefined : { top: position.top, left: position.left }}
      onPointerDown={(e) => {
        e.preventDefault();
        onComment();
      }}
      onClick={keyboardOnly(onComment)}
    >
      <Icon name="comment" size={14} />
      {label}
    </button>
  );
  const suggestButton = suggest ? (
    <button
      type="button"
      className="selection-fab"
      aria-disabled={refusal ? true : undefined}
      title={refusal ?? undefined}
      onPointerDown={(e) => {
        e.preventDefault();
        trySuggest();
      }}
      onClick={keyboardOnly(trySuggest)}
    >
      <Icon name="edit" size={14} />
      Suggest edit
    </button>
  ) : null;
  if (docked) {
    // Into <body>, so no ancestor's layout can move a bar fixed to the screen.
    return createPortal(
      <div className="selection-fab-bar selection-dock" role="toolbar" aria-label="Selection">
        {commentButton}
        {suggestButton}
      </div>,
      document.body,
    );
  }
  if (!suggest) return commentButton;
  return (
    <div className="selection-fab-bar" role="toolbar" aria-label="Selection" style={{ top: position.top, left: position.left }}>
      {commentButton}
      {suggestButton}
    </div>
  );
}
