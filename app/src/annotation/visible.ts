// SPDX-License-Identifier: Apache-2.0
// Whether the reader can see an element: what a reading place and the overlays measure against (SPEC §16).

/**
 * A deck that stacks its slides keeps every one of them in the same box and
 * hides all but one, with `visibility`, `opacity` or `display`. A hidden slide
 * still HAS its box, so geometry alone says its words sit exactly where the
 * shown slide's do: a reading place named the last slide's ids, and somebody's
 * selection on slide seven was drawn over whichever slide the reader was on.
 *
 * So both ask this first. The browser answers with `checkVisibility`; where it
 * has none (jsdom, an older engine) the same three properties are read: the
 * element's own computed `visibility`, which is inherited and so already says
 * whether an ancestor hid it — and lets a descendant show itself again, as the
 * property does — and, up the ancestors, `display: none` and an opacity of 0,
 * which are not inherited.
 *
 * Transforms are not tested. A carousel parks a slide off screen with one, but
 * a transformed container is ordinary in prose, and taking it for hidden would
 * lose a passage the reader is looking at.
 */
export function isVisible(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (options?: Record<string, boolean>) => boolean }).checkVisibility;
  if (typeof check === "function") return check.call(el, { visibilityProperty: true, opacityProperty: true });
  const view = el.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return true;
  const own = view.getComputedStyle(el);
  if (own.visibility === "hidden" || own.visibility === "collapse") return false;
  for (let at: Element | null = el; at; at = at.parentElement) {
    const style = at === el ? own : view.getComputedStyle(at);
    if (style.display === "none") return false;
    // Only a MEASURED zero hides: jsdom reports "" for a property it does not compute.
    const opacity = parseFloat(style.opacity);
    if (!Number.isNaN(opacity) && opacity <= 0) return false;
  }
  return true;
}
