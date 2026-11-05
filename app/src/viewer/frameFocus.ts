// SPDX-License-Identifier: Apache-2.0
// Reflect focus inside the document on its app-owned iframe for a visible focus indicator (SPEC §7).

/** Chrome makes an iframe active without matching any focus pseudo-class on
 * it or its ancestors. Observe the parent document; never decorate author DOM.
 *
 * On a touch screen a finger in the document focuses the frame as well, and the
 * ring that tells a keyboard user where they are became a blue box round the page
 * for as long as somebody read. A finger in the frame is not an event the parent
 * hears, so there it takes a Tab, which a hardware keyboard still sends. */
export function observeFrameFocus(frame: HTMLIFrameElement): () => void {
  const doc = frame.ownerDocument;
  const view = doc.defaultView;
  const touch = view?.matchMedia?.("(pointer: coarse)").matches === true;
  let tabbed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const focused = doc.activeElement === frame && doc.hasFocus();
    if (!focused) tabbed = false;
    frame.toggleAttribute("data-frame-focus", focused && (tabbed || !touch));
  };
  // The active element changes after the window's blur event has dispatched.
  const defer = () => {
    clearTimeout(pending);
    pending = setTimeout(update, 0);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Tab") tabbed = true;
  };
  view?.addEventListener("blur", defer);
  view?.addEventListener("focus", defer);
  doc.addEventListener("focusin", update);
  doc.addEventListener("keydown", onKey, true);
  update();
  return () => {
    clearTimeout(pending);
    view?.removeEventListener("blur", defer);
    view?.removeEventListener("focus", defer);
    doc.removeEventListener("focusin", update);
    doc.removeEventListener("keydown", onKey, true);
    frame.removeAttribute("data-frame-focus");
  };
}
