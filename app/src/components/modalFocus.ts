// SPDX-License-Identifier: Apache-2.0
// Shared modal focus boundaries survive disabled and removed controls (SPEC §7).

const CANDIDATES = "a[href], button, input, select, textarea, summary, [tabindex]";

export function modalStops(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(CANDIDATES)).filter((el) => {
    if (el.tabIndex < 0 || el.matches(":disabled") || el.closest("[hidden], [inert]")) return false;
    for (let at: HTMLElement | null = el; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (at === panel) break;
    }
    return true;
  });
}

export function trapModalTab(e: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">, panel: HTMLElement): void {
  if (e.key !== "Tab") return;
  const items = modalStops(panel);
  const active = panel.ownerDocument.activeElement;
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    e.preventDefault();
    panel.focus();
  } else if (!items.includes(active as HTMLElement) || (e.shiftKey ? active === first : active === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

/** Native disabling can move focus to body without a React keyboard event. */
export function containModalFocus(panel: HTMLElement): () => void {
  const doc = panel.ownerDocument;
  const repair = () => {
    // Only the top dialog owns focus when one dialog opens another.
    if (Array.from(doc.querySelectorAll('[aria-modal="true"]')).at(-1) !== panel) return;
    const items = modalStops(panel);
    const active = doc.activeElement;
    if (active === panel || items.includes(active as HTMLElement)) return;
    (items[0] ?? panel).focus();
  };
  doc.addEventListener("focusin", repair);
  const observer = new MutationObserver(repair);
  observer.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden", "tabindex", "class", "style"] });
  return () => {
    doc.removeEventListener("focusin", repair);
    observer.disconnect();
  };
}
