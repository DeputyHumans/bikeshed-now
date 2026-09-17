// SPDX-License-Identifier: Apache-2.0
// A popover menu with keyboard navigation.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 200;
    setPosition({
      top: rect.bottom + window.scrollY + 4,
      // Flip when the menu would run off the right edge, which on a narrow
      // viewport is most of the time.
      left: Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - width - 8)),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
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
  }, [open, place]);

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
      {open ? (
        <div
          ref={menuRef}
          className="menu"
          role="menu"
          aria-label={label}
          style={{ top: position.top, left: position.left }}
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
