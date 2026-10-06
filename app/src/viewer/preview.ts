// SPDX-License-Identifier: Apache-2.0
// The separate document a slide thumbnail renders (SPEC §6d).

import { stripDecoration } from "../annotation/highlighter";
import { OWN_SELECTOR, PREVIEW_ATTR, REVEAL_ATTR } from "../brand/dom";
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

const REVEALED = `[${REVEAL_ATTR}][${REVEAL_ATTR}][${REVEAL_ATTR}]`;

/**
 * What makes a preview show a slide as it ENDS rather than as it begins.
 *
 * Decks animate a slide's content in when the slide is shown, and a preview is
 * never shown anything: it loads once, runs no script, and is looked at from
 * then on. So every animation is finished before it starts — a zero-length
 * animation is already over, and its fill mode then decides what stays, which
 * is exactly the deck's own last frame. Transitions are off for the same
 * reason: a preview has no "before" worth easing out of.
 *
 * The whole preview document is ours, so the universal selector is fair game;
 * the slide's subtree is repeated at the slide rule's weight so a deck's own
 * `!important` animation on a class pair cannot outrank it.
 *
 * The second rule is the reveal pass's half (see `revealHidden`): opacity and
 * visibility only, layout-neutral for the same reason the slide rule is.
 */
export const FINAL_STATE_CSS =
  `*,*::before,*::after,${SELECTOR},${SELECTOR}::before,${SELECTOR}::after,` +
  `${SELECTOR} *,${SELECTOR} *::before,${SELECTOR} *::after{` +
  "animation-duration:0s!important;animation-delay:0s!important;" +
  "animation-iteration-count:1!important;transition:none!important}" +
  `${REVEALED}{opacity:1!important;visibility:visible!important}`;

/**
 * Mark what the loaded preview still hides inside its slide, so
 * `FINAL_STATE_CSS` can force it visible.
 *
 * Freezing animations reaches the last frame only of an animation that RUNS. A
 * deck that hides content until its script marks the slide active —
 * `.slide .item{opacity:0}` and `.slide.active .item{…}` — gives a preview,
 * where no script runs, nothing to finish: the content just stays hidden, and
 * the thumbnail is blank. What is still at `opacity:0` or `visibility:hidden`
 * once the preview has loaded is, inside a slide, content waiting for a reveal.
 *
 * Computed, so it has to run in the loaded preview, and it reads everything
 * before it writes anything. One pass is enough: forcing only ever makes
 * things visible, so nothing becomes hidden that a second pass would find.
 *
 * A `position:fixed` element is skipped WITH its subtree: it is the deck's
 * chrome — a modal, a toolbar — and its children inherit its hiding, so marking
 * them would float them free of the overlay they belong to.
 *
 * Only ever called on a preview document. The reader's frame has no element
 * carrying `PREVIEW_ATTR`, so even a wrong document is left untouched.
 */
export function revealHidden(doc: Document): void {
  const view = doc.defaultView;
  const slide = doc.querySelector(`[${PREVIEW_ATTR}]`);
  if (!view || !slide) return;

  const hidden: Element[] = [];
  const walker = doc.createTreeWalker(slide, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const style = view.getComputedStyle(node as Element);
      if (style.position === "fixed") return NodeFilter.FILTER_REJECT;
      if (style.opacity === "0" || style.visibility === "hidden") {
        hidden.push(node as Element);
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
  // Skipping every node walks the whole subtree; only REJECT prunes. The walk
  // itself is the read phase, so nothing is written while styles are read.
  walker.nextNode();
  for (const el of hidden) el.setAttribute(REVEAL_ATTR, "");
}

/**
 * Class names that mean "this slide is the one being shown", exactly or as a
 * suffix: `active`, `is-active`, bespoke's `bespoke-active`, reveal's
 * `present`, a scroll deck's `seen`.
 *
 * An allowlist on purpose. Learning the state from whatever the shown slide
 * carries that the others lack would also learn `title-slide`, `cover` and
 * `dark` whenever the reader sits on a slide that has them, and restyle every
 * thumbnail as that slide. A name this list misses costs a thumbnail its bars;
 * a name it wrongly includes costs every thumbnail its layout.
 */
const STATE_NAMES: ReadonlySet<string> = new Set([
  "active",
  "current",
  "present",
  "visible",
  "shown",
  "seen",
  "revealed",
  "in-view",
  "animate",
  "animated",
]);
const STATE_SUFFIXES = ["-active", "-current", "-present", "-visible", "-in-view", "-seen"];

function isStateToken(token: string): boolean {
  return STATE_NAMES.has(token) || STATE_SUFFIXES.some((suffix) => token.endsWith(suffix));
}

/**
 * The classes a deck puts on the slide it is showing, read off the live slides,
 * as a space-separated string so it can sit in a memo dependency unchanged.
 *
 * Forcing visibility reaches content hidden by opacity, but not a final state
 * of any other property — `.slide.active .bar{width:var(--w)}` grows a bar no
 * forced opacity can fill. Giving every preview the deck's own state class
 * lets the deck's own stylesheet put each slide in its shown state.
 *
 * Read, never written: these come off the reader's frame and go onto copies.
 */
export function slideStateTokens(slides: readonly Slide[]): string {
  const found: string[] = [];
  for (const slide of slides) {
    for (const token of Array.from(slide.outer.classList)) {
      if (isStateToken(token) && !found.includes(token)) found.push(token);
    }
  }
  return found.join(" ");
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
export function buildPreviewDoc(slide: Slide, baseHref: string, state = ""): string {
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
  // The deck's shown state (`slideStateTokens`), on the clone for the same
  // reason as the marker.
  for (const token of state.split(" ")) if (token) clone.classList.add(token);
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
    previewOverrides(computed, donor) +
    FINAL_STATE_CSS;
  // Last in head, so an `!important` tie against a guest rule of equal
  // specificity is broken by source order in our favour.
  preview.head.appendChild(style);

  return `<!doctype html>${preview.documentElement.outerHTML}`;
}
