// SPDX-License-Identifier: Apache-2.0
// The "comment on this", "suggest an edit" and "copy a link to here" affordance that follows a selection (SPEC §6, §6e, §22).

import { createPortal } from "react-dom";
import { useCoarsePointer } from "../hooks/useMediaQuery";
import { useEffect, useState } from "react";
import { watchScroll, watchSelection } from "../viewer/frameWatch";
import { suggestibleRange, trimToText } from "../annotation/exact";
import type { Target } from "../viewer/target";
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
  link,
}: {
  doc: Document | null;
  epoch: number;
  enabled: boolean;
  /** Absent where this reader may not comment: the controls then offer only what they may do. */
  onComment?: () => void;
  label?: string;
  /**
   * Offered beside Comment when this reader may suggest (SPEC §22). Never
   * disabled outright: a selection it cannot take is said, on press, rather
   * than greyed out — a disabled button cannot explain itself reliably.
   */
  suggest?: { onSuggest: () => void; onRefused: (reason: string) => void };
  /**
   * A link to the place the selection starts in (SPEC §6e), for any reader.
   * Offered only when `targetOf` finds one: a section with an id, or a slide.
   */
  link?: { targetOf: (range: Range) => Target | null; onCopy: (target: Target) => void };
}) {
  const [position, setPosition] = useState<FabPosition | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
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
      const found = link?.targetOf(range) ?? null;
      setTarget(found);
      const count = (onComment ? 1 : 0) + (suggest ? 1 : 0) + (found ? 1 : 0);
      // Nothing this reader may do with it: no controls at all.
      if (count === 0) {
        setPosition(null);
        return;
      }
      const view = doc.defaultView;
      setPosition(
        fabPosition(
          rect,
          { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
          { width: count === 1 ? 150 : count === 2 ? 250 : 350, height: 34 },
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
    // The callbacks are read when the selection changes; what matters here is
    // which of them exist, because that decides how wide the controls are.
  }, [enabled, doc, epoch, suggest !== undefined, onComment !== undefined, link !== undefined]);

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
  const copy = () => {
    if (link && target) link.onCopy(target);
  };
  const commentButton = onComment ? (
    <button
      type="button"
      className="selection-fab"
      onPointerDown={(e) => {
        e.preventDefault();
        onComment();
      }}
      onClick={keyboardOnly(onComment)}
    >
      <Icon name="comment" size={14} />
      {label}
    </button>
  ) : null;
  const linkButton = link && target ? (
    <button
      type="button"
      className="selection-fab"
      onPointerDown={(e) => {
        e.preventDefault();
        copy();
      }}
      onClick={keyboardOnly(copy)}
    >
      <Icon name="link" size={14} />
      Copy link
    </button>
  ) : null;
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
        {linkButton}
      </div>,
      document.body,
    );
  }
  return (
    <div className="selection-fab-bar" role="toolbar" aria-label="Selection" style={{ top: position.top, left: position.left }}>
      {commentButton}
      {suggestButton}
      {linkButton}
    </div>
  );
}
