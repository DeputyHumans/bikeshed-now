// SPDX-License-Identifier: Apache-2.0
// The separate document a slide thumbnail renders (SPEC §6d).

import { stripDecoration } from "../annotation/highlighter";
import { OWN_SELECTOR, PREVIEW_ATTR } from "../brand/dom";
import { hasTranslation, readComputed, type Slide, type SlideComputed } from "./deck";

/**
 * A preview is a SEPARATE document this app builds. It is never the frame the
 * reader reads, and nothing serializes it, which is the whole reason it is
 * allowed to force anything at all.
 *
 * Two properties are load-bearing, and both were wrong in the first version:
 *
 *   - **The slide keeps its ancestors.** Emitting the slide alone as the only
 *     child of `<body>` throws away the elements its own stylesheet is written
 *     against. A deck whose slides get their width from a container rule
 *     renders full-bleed; one built as `<svg><foreignObject><section>` loses
 *     the wrapper the layout lives on. The box was still sized from the LIVE,
 *     correctly-styled frame, so the contents filled a fraction of it and the
 *     rest was whitespace. That was the reported bug.
 *   - **Nothing is flattened.** The first version forced `position:static` and
 *     `margin:0` on the slide, which turns `position:absolute; inset:0;
 *     display:grid; place-items:center` into shrink-wrapped content in the
 *     top-left corner. Only visibility is forced now, and `display` and
 *     `transform` only when the live document says they are what is hiding it.
 *
 * Known limitation, stated rather than discovered: the slide becomes an only
 * child, so `:first-child`, `:nth-child()` and `section + section` no longer
 * match. Preserving sibling position means emitting empty shells for every
 * other slide, which has its own failure modes inside flex and grid parents.
 * Not worth it until a real deck needs it.
 *
 * Previews are inert even for a TRUSTED document: the iframe is sandboxed
 * `allow-same-origin` with no `allow-scripts`, which blocks `<script>`, inline
 * `on*` handlers and `javascript:` alike. A thumbnail is not worth running
 * anybody's code, so there is no sanitising pass here — adding one would imply
 * the sandbox is not trusted, and it is the only thing protecting the reader's
 * own frame too.
 */

/**
 * Repeated three times on purpose.
 *
 * Decks really do write `.deck .slide{visibility:hidden!important}`, which is
 * specificity (0,2,0). An `!important` tie is broken by specificity, so a
 * single `[attr]` at (0,1,0) loses and the preview renders blank.
 */
const SELECTOR = `[${PREVIEW_ATTR}][${PREVIEW_ATTR}][${PREVIEW_ATTR}]`;

/**
 * The only rule the preview adds, built from what the live document actually
 * computes rather than from a guess.
 *
 * `visibility` and `opacity` are forced unconditionally because both are
 * layout-neutral: forcing them cannot cause the class of bug this exists to
 * fix. `display` and `transform` can both destroy a layout, so neither moves
 * unless the live frame says it is what is hiding the slide.
 *
 * Deliberately never touched: `position`, `inset`, `margin`, `width`, `height`,
 * `float`, `flex`, `place-items`.
 *
 * Known unhandled, because a speculative rule here is worse than a missing one:
 * `clip: rect(0,0,0,0)`, `content-visibility: hidden`, and `height:0` with
 * `overflow:hidden`.
 */
export function previewOverrides(
  computed: SlideComputed | null,
  donorDisplay: string | null,
): string {
  const decls = ["visibility:visible!important", "opacity:1!important"];
  if (computed?.display === "none") {
    // The slide's OWN display is `none`, so it cannot say what it should be.
    // A sibling can: every slide in a deck shares the same rules, so whatever
    // the visible one computes to is what the hidden ones are meant to be.
    decls.push(`display:${donorDisplay || "block"}!important`);
  }
  if (computed && hasTranslation(computed.transform)) {
    decls.push("transform:none!important");
  }
  return `${SELECTOR}{${decls.join(";")}}`;
}

function copyAttributes(from: Element | null, to: Element): void {
  if (!from) return;
  for (const attr of Array.from(from.attributes)) {
    to.setAttribute(attr.name, attr.value);
  }
}

function donorDisplay(view: Window, outer: Element): string | null {
  const parent = outer.parentElement;
  if (!parent) return null;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === outer) continue;
    const display = view.getComputedStyle(sibling).display;
    if (display && display !== "none") return display;
  }
  return null;
}

/**
 * Build the preview as a real document and serialize it ONCE, at the end.
 *
 * Not string concatenation. The version this replaces escaped exactly one
 * character by hand and missed `&`, and preserving the ancestor chain means
 * carrying arbitrary attribute sets out of a document nobody here owns.
 * `outerHTML` runs the HTML fragment serialization algorithm, so there is no
 * hand-written escaping anywhere in this file. It also keeps namespaces and
 * case intact, which matters for `foreignObject` — case-significant in SVG,
 * and mangled by anything that rebuilds a tag from `tagName`.
 *
 * The stage size is deliberately NOT baked in here. It sizes the iframe
 * ELEMENT, so resizing the window re-lays-out the preview without changing
 * this string — which means no reload and no refetch of the document's assets.
 * Leak the stage into this string and every resize refetches every preview.
 */
export function buildPreviewDoc(slide: Slide, baseHref: string): string {
  const doc = slide.outer.ownerDocument;
  const view = doc.defaultView;
  const preview = doc.implementation.createHTMLDocument("");

  // `html` and `body` carry more than `class`: `dir="rtl"` alone flips a deck,
  // and `lang` and `data-theme` are routinely what a stylesheet branches on.
  copyAttributes(doc.documentElement, preview.documentElement);
  copyAttributes(doc.body, preview.body);

  const charset = preview.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  preview.head.appendChild(charset);

  // Before the stylesheets, so their relative urls resolve against the content
  // proxy rather than the app origin. Without it every asset in a preview 404s.
  const base = preview.createElement("base");
  base.setAttribute("href", baseHref);
  preview.head.appendChild(base);

  // The guest's own stylesheets, minus ours — without the filter a reader's
  // highlights bleed into every thumbnail.
  for (const el of Array.from(
    doc.head.querySelectorAll('style, link[rel="stylesheet"]'),
  )) {
    if (el.matches(OWN_SELECTOR)) continue;
    // importNode, never the live node: appending a live `<style>` MOVES it out
    // of the reader's frame and silently unstyles the document being read.
    preview.head.appendChild(preview.importNode(el, true));
  }

  // Every ancestor between the slide and `<body>`, outermost first. An empty
  // chain is the flat case, where this emits exactly what it always did — so
  // the change cannot regress a deck whose slides are children of `<body>`.
  const chain: Element[] = [];
  for (
    let parent = slide.outer.parentElement;
    parent && parent !== doc.body && parent !== doc.documentElement;
    parent = parent.parentElement
  ) {
    chain.unshift(parent);
  }

  let mount: Element = preview.body;
  for (const ancestor of chain) {
    // Shallow: the ancestor's OTHER children are the deck's other slides, and
    // carrying them would put every slide in every thumbnail.
    const shell = preview.importNode(ancestor, false);
    mount.appendChild(shell);
    mount = shell;
  }

  // Deep: the slide keeps its own subtree. The marker goes on the CLONE — set
  // it on `slide.outer` and it is an attribute written into the document the
  // reader is reading, which is exactly what this design promises never to do.
  const clone = preview.importNode(slide.outer, true);
  clone.setAttribute(PREVIEW_ATTR, "");
  mount.appendChild(clone);

  // The head filter above keeps our STYLESHEETS out, but highlights, the peer
  // layer and edit affordances are nodes and attributes inside the slide and on
  // the elements copied around it. A `<mark>` with no author rule is the
  // browser's own yellow, so without this every commented slide previews as if
  // one reader's annotations were part of the deck.
  stripDecoration(preview.documentElement);

  // `getComputedStyle` has to come from the FRAME's view. A `DOMParser`
  // document has no `defaultView` at all, which is every unit test: the
  // measurement is skipped and only the unconditional declarations are
  // emitted, so test output is deterministic for free.
  const computed = view ? readComputed(view, slide.el) : null;
  const donor = view ? donorDisplay(view, slide.outer) : null;

  const style = preview.createElement("style");
  style.textContent =
    "html,body{margin:0;padding:0;overflow:hidden;background:#fff}" +
    previewOverrides(computed, donor);
  // Last in head, so an `!important` tie against a guest rule of equal
  // specificity is broken by source order in our favour.
  preview.head.appendChild(style);

  return `<!doctype html>${preview.documentElement.outerHTML}`;
}
