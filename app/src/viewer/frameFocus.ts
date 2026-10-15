// SPDX-License-Identifier: Apache-2.0
// Reflect focus inside the document on its app-owned iframe for a visible focus indicator (SPEC §7).

/** Chrome makes an iframe active without matching any focus pseudo-class on
 * it or its ancestors. Observe the parent document; never decorate author DOM. */
export function observeFrameFocus(frame: HTMLIFrameElement): () => void {
  const doc = frame.ownerDocument;
  const view = doc.defaultView;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    frame.toggleAttribute("data-frame-focus", doc.activeElement === frame && doc.hasFocus());
  };
  // The active element changes after the window's blur event has dispatched.
  const defer = () => {
    clearTimeout(pending);
    pending = setTimeout(update, 0);
  };
  view?.addEventListener("blur", defer);
  view?.addEventListener("focus", defer);
  doc.addEventListener("focusin", update);
  update();
  return () => {
    clearTimeout(pending);
    view?.removeEventListener("blur", defer);
    view?.removeEventListener("focus", defer);
    doc.removeEventListener("focusin", update);
    frame.removeAttribute("data-frame-focus");
  };
}
