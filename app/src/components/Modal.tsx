// SPDX-License-Identifier: Apache-2.0
// A dialog that traps focus and returns it (SPEC §7).

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import { containModalFocus, modalStops, trapModalTab } from "./modalFocus";

/**
 * Three things a dialog must do, and all three are easy to forget:
 *
 *   - Return focus to whatever opened it. Without that, dismissing a dialog
 *     drops a keyboard user at the top of the page.
 *   - Trap Tab inside itself, or Tab walks into the page behind it, which a
 *     screen reader will happily read out.
 *   - Close on Escape, and on a backdrop click, but NOT on a click that started
 *     inside and ended outside — a text selection dragged past the edge is not
 *     a dismissal.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const pressedInside = useRef(false);

  useEffect(() => {
    opener.current = document.activeElement;
    const root = panel.current;
    if (!root) return;
    (modalStops(root)[0] ?? root).focus();
    const release = containModalFocus(root);
    return () => {
      release();
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (panel.current) trapModalTab(e, panel.current);
    },
    [onClose],
  );

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        pressedInside.current = panel.current?.contains(e.target as Node) ?? false;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !pressedInside.current) onClose();
      }}
    >
      <div
        ref={panel}
        className={wide ? "modal modal-wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
