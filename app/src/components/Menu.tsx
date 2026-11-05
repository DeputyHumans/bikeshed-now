// SPDX-License-Identifier: Apache-2.0
// A popover menu with keyboard navigation.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Anchored to its trigger and positioned at open time rather than tracked, so
 * it cannot drift while the page scrolls underneath it. A menu that follows the
 * page is a menu you can click the wrong item in.
 */
export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** A reason a disabled item is disabled. Shown as a tooltip. */
  reason?: string;
  onSelect?: () => void;
}

export type MenuEntry = MenuItem | { id: string; separator: true } | { id: string; label: string; heading: true };

/**
 * Where the menu opens, in document coordinates, as a pure function.
 *
 * Below its trigger, or above it when there is no room below: the last card of
 * a list scrolled to its end is exactly where somebody opens one, and a menu
 * that runs off the window cannot be scrolled to, because a scroll closes it.
 * With room on neither side it takes the roomier one and stays on screen, over
 * its trigger if it has to. Extracted for the reason fabPosition is: jsdom
 * measures nothing, and the placement is the part with the edge cases.
 */
export function menuPosition(
  trigger: { top: number; bottom: number; left: number },
  view: { width: number; height: number },
  menu: { width: number; height: number },
  scroll: { x: number; y: number },
): { top: number; left: number } {
  const gap = 4;
  const edge = 8;
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - menu.height;
  const preferred =
    below + menu.height <= view.height - edge
      ? below
      : above >= edge
        ? above
        : view.height - trigger.bottom >= trigger.top
          ? below
          : above;
  const top = Math.max(edge, Math.min(preferred, view.height - edge - menu.height));
  // Clamped at the right edge too, which on a narrow viewport is most of the time.
  const left = Math.max(edge, Math.min(trigger.left, view.width - menu.width - edge));
  return { top: top + scroll.y, left: left + scroll.x };
}

/**
 * What to add to a place in the window to get `menu.style.top` and `left`.
 *
 * The document's scroll, unless the menu sits in something positioned, which it
 * is then measured from. Inside the sticky header, a menu placed in document
 * coordinates opened lower by however far the page had scrolled.
 */
function originOf(menu: HTMLElement): { x: number; y: number } {
  const parent = menu.offsetParent;
  if (!(parent instanceof HTMLElement) || parent === document.body || parent === document.documentElement) {
    return { x: window.scrollX, y: window.scrollY };
  }
  const box = parent.getBoundingClientRect();
  return { x: parent.scrollLeft - box.left - parent.clientLeft, y: parent.scrollTop - box.top - parent.clientTop };
}

export function Menu({
  trigger,
  entries,
  label,
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  entries: MenuEntry[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Placed straight onto the element, before paint and before the effect below
  // focuses its first item. Through state, React would run that effect first,
  // with the menu still where it was drawn, at the top of the document: the
  // focus scrolled a list there, and the scroll closed the menu.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!open || !menu || !rect) return;
    // Measured at the document's corner, where nothing narrows it.
    menu.style.top = "0px";
    menu.style.left = "0px";
    const { top, left } = menuPosition(
      rect,
      // The window less its scrollbars: the stylesheet reserves the vertical
      // one's gutter, and the window's own width counts it.
      { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      // jsdom measures nothing; the stylesheet's min-width makes it about 200.
      { width: menu.offsetWidth || 200, height: menu.offsetHeight },
      originOf(menu),
    );
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", () => setOpen(false), { once: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>(".menu-item")?.focus();
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)") ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? index + 1 : index - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((v) => !v),
        "aria-expanded": open,
      })}
      {open ? <div className="menu-backdrop" aria-hidden="true" onClick={() => setOpen(false)} /> : null}
      {open ? (
        <div
          ref={menuRef}
          className="menu"
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          {entries.map((entry) => {
            if ("separator" in entry) return <div key={entry.id} className="menu-sep" />;
            if ("heading" in entry) {
              return (
                <div key={entry.id} className="menu-label">
                  {entry.label}
                </div>
              );
            }
            return (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                className={entry.danger ? "menu-item menu-item-danger" : "menu-item"}
                disabled={entry.disabled}
                title={entry.disabled ? entry.reason : undefined}
                onClick={() => {
                  setOpen(false);
                  entry.onSelect?.();
                }}
              >
                {entry.icon}
                {entry.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
