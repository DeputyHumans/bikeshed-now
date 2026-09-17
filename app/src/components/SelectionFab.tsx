// SPDX-License-Identifier: Apache-2.0
// The "comment on this" affordance that follows a selection (SPEC §6).

import { useEffect, useState } from "react";
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
}: {
  doc: Document | null;
  epoch: number;
  enabled: boolean;
  onComment: () => void;
  label?: string;
}) {
  const [position, setPosition] = useState<FabPosition | null>(null);

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
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPosition(null);
        return;
      }
      const view = doc.defaultView;
      setPosition(
        fabPosition(rect, {
          width: view?.innerWidth ?? 0,
          height: view?.innerHeight ?? 0,
        }),
      );
    };
    doc.addEventListener("selectionchange", update);
    doc.defaultView?.addEventListener("scroll", update, { passive: true });
    return () => {
      doc.removeEventListener("selectionchange", update);
      doc.defaultView?.removeEventListener("scroll", update);
    };
  }, [enabled, doc, epoch]);

  if (!position) return null;
  return (
    <button
      type="button"
      className="selection-fab"
      style={{ top: position.top, left: position.left }}
      // Pointer-down rather than click: a click first collapses the selection
      // in some engines, and the selection is the entire point.
      onPointerDown={(e) => {
        e.preventDefault();
        onComment();
      }}
    >
      <Icon name="comment" size={14} />
      {label}
    </button>
  );
}
