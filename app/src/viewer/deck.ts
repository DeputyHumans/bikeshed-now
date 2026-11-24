// SPDX-License-Identifier: Apache-2.0
// What counts as a slide, and where the reader is in one (SPEC §6d).

import type { ReadingPlace } from "../presence";

/**
 * There is still no slide MODEL, for the reason `SlidePanel` has always given:
 * a slide is a region the author already treated as one. This module only reads
 * the markup. Nothing here mutates a document.
 *
 * The detection is an ordered list rather than one selector because real decks
 * disagree with each other, and each rule below exists because some deck
 * defeats the rule above it:
 *
 *   - Many carry no `id` on a slide at all, so `section[id]` finds nothing.
 *   - Many never use the class `slide`, so `section.slide` finds nothing.
 *     Those two sets do not overlap. That is the whole argument for a list.
 *   - One wraps every slide in `<svg><foreignObject>`, six levels below `body`.
 *   - Some build every slide at runtime and ship an empty container, so with
 *     scripts blocked there is nothing to find and "not a deck" is the wrong
 *     answer — `script-required` is.
 *
 * Two traps, both load-bearing:
 *
 *   - **Reading order is DOM order, never an id or an index attribute.** One
 *     deck numbers its sections `s-0, s-1, s-4, s-11, s-2`; another uses bare
 *     numerals, which makes `#1` an invalid selector that `querySelector`
 *     throws on. Nothing here ever builds a selector out of an id.
 *   - **Class matching is by token.** Markup in the wild emits `class="slide "`
 *     and `class="slide  slide--noted"`, so string equality misses nearly every
 *     slide, and a substring match would also catch `slide-number` and
 *     `lead-slide`.
 */

export interface Slide {
  index: number;
  title: string;
  /** The authored element. Comments and edits address this. */
  el: HTMLElement;
  /**
   * What to scroll to and what to preview. The same node as `el` except when
   * the slide lives inside foreign content, where scrolling the inner
   * `<section>` does not reliably move the page.
   */
  outer: HTMLElement;
}

export type SlideScan =
  | { kind: "slides"; slides: Slide[] }
  /** A deck whose slides only exist once its own JavaScript has run. */
  | { kind: "script-required" }
  | { kind: "none" };

/** Containers a deck framework leaves empty for its script to fill. */
const RUNTIME_CONTAINERS =
  "#slides-container, .slides, .deck, .slideshow, .presentation, .reveal";

/**
 * `aria-label="Slide 7"` is an index wearing a title's clothes. Two decks ship
 * it on every section, and taking it at face value labels the whole rail
 * "Slide 1, Slide 2, …" while real headings sit unused in the markup.
 */
const LABEL_IS_AN_INDEX = /^\s*slide\s*\d+\s*$/i;

function tokens(el: Element): string[] {
  return Array.from(el.classList);
}

/**
 * Candidates scattered across the document are not a deck. Slides are siblings,
 * so group by parent and keep the largest group — in DOM order, which
 * `querySelectorAll` already guarantees.
 */
function largestSiblingGroup(els: HTMLElement[]): HTMLElement[] {
  const byParent = new Map<Element, HTMLElement[]>();
  for (const el of els) {
    const parent = el.parentElement;
    if (!parent) continue;
    const group = byParent.get(parent);
    if (group) group.push(el);
    else byParent.set(parent, [el]);
  }
  let best: HTMLElement[] = [];
  for (const group of byParent.values()) if (group.length > best.length) best = group;
  return best;
}

/**
 * A carousel is also a run of sibling `.slide` elements, and a slide deck is
 * not. Requiring a heading on half of them is what separates the two without
 * reading any CSS.
 */
function mostHaveHeadings(els: HTMLElement[]): boolean {
  const withHeading = els.filter((el) => el.querySelector("h1, h2, h3")).length;
  return withHeading * 2 >= els.length;
}

/**
 * A heading's text with its line breaks kept as spaces. `textContent` has
 * nothing for a `<br>`, so a heading set on two lines would read as one
 * run-together word. Only a `<br>` adds a space: an inline element can sit inside
 * a word, and `<wbr>` says the word carries on.
 */
function textWithBreaks(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if ((node as Element).localName === "br") return " ";
  return Array.from(node.childNodes).map(textWithBreaks).join("");
}

export function slideTitle(el: Element, index: number): string {
  const authored = el.getAttribute("data-title")?.trim();
  if (authored) return authored;

  const heading = el.querySelector("h1, h2, h3");
  const headingText = heading && textWithBreaks(heading).replace(/\s+/g, " ").trim();
  if (headingText) return headingText;

  const label = el.getAttribute("aria-label")?.trim();
  if (label && !LABEL_IS_AN_INDEX.test(label)) return label;

  const id = el.getAttribute("id")?.trim();
  if (id) return id.replace(/[-_]+/g, " ").trim();

  return `Slide ${index + 1}`;
}

function toSlides(
  els: HTMLElement[],
  outerOf: (el: HTMLElement) => HTMLElement = (el) => el,
): Slide[] {
  return els.map((el, index) => ({
    index,
    title: slideTitle(el, index),
    el,
    outer: outerOf(el),
  }));
}

/** Rule 1 — a vendor attribute no prose document has ever carried. */
function scanForeignObject(doc: Document): Slide[] | null {
  const sections = Array.from(
    doc.querySelectorAll<HTMLElement>("svg[data-marpit-svg] > foreignObject > section"),
  );
  if (sections.length < 2) return null;
  return toSlides(sections, (el) => el.closest<HTMLElement>("svg[data-marpit-svg]") ?? el);
}

/** Rule 2 — an explicit `slide` class token. */
function scanSlideClass(doc: Document): Slide[] | null {
  const tagged = Array.from(doc.querySelectorAll<HTMLElement>("[class]")).filter((el) =>
    el.classList.contains("slide"),
  );
  const group = largestSiblingGroup(tagged);
  if (group.length < 2 || !mostHaveHeadings(group)) return null;
  return toSlides(group);
}

/**
 * Rule 3 — authored slide titles.
 *
 * The seed is widened to its whole sibling run on purpose: one deck gives every
 * section a `data-title` except the cover, so matching the attribute alone
 * silently drops slide 1 and renumbers the rest.
 */
function scanAuthoredTitles(doc: Document): Slide[] | null {
  const seed = doc.querySelector<HTMLElement>("section[data-title], article[data-title]");
  if (!seed?.parentElement) return null;
  const token = tokens(seed)[0];
  // No `instanceof HTMLElement` here. The document comes from the FRAME's
  // realm, so it is false for every element in it — the filter would quietly
  // return nothing and this rule would never fire for the decks it exists for.
  // `children` is already an element collection, so the check bought nothing
  // even where it worked.
  const run = Array.from(seed.parentElement.children).filter(
    (el) => el.tagName === seed.tagName && (token ? el.classList.contains(token) : true),
  ) as HTMLElement[];
  if (run.length < 2) return null;
  return toSlides(run);
}

/** Rule 4 — a uniform run of sibling sections sharing a class token. */
function scanUniformRun(doc: Document): Slide[] | null {
  const sections = Array.from(doc.querySelectorAll<HTMLElement>("section, article"));
  const group = largestSiblingGroup(sections);
  if (group.length < 3) return null;
  const shared = tokens(group[0]).find((token) =>
    group.every((el) => el.classList.contains(token)),
  );
  if (!shared) return null;
  return toSlides(group);
}

/** Rule 5 — sibling sections that at least all carry an id. Low confidence. */
function scanIdBearing(doc: Document): Slide[] | null {
  const sections = Array.from(doc.querySelectorAll<HTMLElement>("section[id], article[id]"));
  const group = largestSiblingGroup(sections);
  if (group.length < 3) return null;
  return toSlides(group);
}

export function scanSlides(doc: Document | null): SlideScan {
  if (!doc?.body) return { kind: "none" };

  for (const rule of [
    scanForeignObject,
    scanSlideClass,
    scanAuthoredTitles,
    scanUniformRun,
    scanIdBearing,
  ]) {
    const slides = rule(doc);
    if (slides) return { kind: "slides", slides };
  }

  // Nothing matched. Before calling it prose, check whether this is a deck
  // whose slides simply do not exist yet: an empty framework container plus a
  // script that would have filled it. Saying "not a deck" there is how a reader
  // ends up staring at a blank page with no explanation.
  const container = doc.querySelector(RUNTIME_CONTAINERS);
  if (container && container.childElementCount === 0 && doc.querySelector("script")) {
    return { kind: "script-required" };
  }

  return { kind: "none" };
}

/**
 * Which slide holds a node: the index of the slide whose `outer` contains it,
 * or -1 when it is on none. `outer`, because it contains `el` and, for a slide
 * in foreign content, the box the reader sees.
 */
export function slideOf(slides: readonly Slide[], node: Node | null): number {
  if (!node) return -1;
  for (const slide of slides) if (slide.outer.contains(node)) return slide.index;
  return -1;
}

/**
 * Which slide a person is on, from their presence record (SPEC §16): the slide
 * they share, when this document has one by that number; else the slide that
 * holds the element their reading place names — the last id above the top of
 * their screen, then the next one below it; else -1, for a record that says
 * neither, such as one from a tab on an app that shared no slide.
 *
 * One answer for following them and for the rail that shows where they are,
 * so the two can never disagree about it.
 */
export function slideOfPeer(
  peer: { slide?: number; place?: ReadingPlace },
  slides: readonly Slide[],
  doc: Document | null,
): number {
  if (peer.slide !== undefined && Number.isInteger(peer.slide) && peer.slide >= 0 && peer.slide < slides.length) return peer.slide;
  if (!doc || !peer.place) return -1;
  for (const id of [peer.place.a, peer.place.b]) {
    if (!id) continue;
    const at = slideOf(slides, doc.getElementById(id));
    if (at >= 0) return at;
  }
  return -1;
}

/**
 * Which slide the reader is looking at, from each slide's offset from the top
 * of the frame's own viewport.
 *
 * Measurement is the caller's job because a rect taken inside the frame is
 * relative to the FRAME's viewport, not the parent's — so the caller has to
 * read it through `doc.defaultView`, and this stays a pure function that a test
 * can drive with numbers.
 */
export function activeIndex(tops: number[]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < tops.length; i += 1) {
    const distance = Math.abs(tops[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Whether arrow keys should PAGE rather than scroll.
 *
 * A deck's slide is about one viewport tall; a long-form document's section is
 * not, and hijacking the arrow keys there would trap the reader — they could
 * never scroll within a section, only jump past it. So this is decided by
 * measurement rather than by the markup that got us here, which also means a
 * document that is a deck on a laptop and an essay on a phone is treated
 * correctly in both.
 */
export function isPaged(heights: number[], viewportHeight: number): boolean {
  if (viewportHeight <= 0 || heights.length < 2) return false;
  // Not "fits in the viewport" — a short section fits too, and a document of
  // short sections is prose. A deck's slides are all about ONE viewport tall,
  // so the test is uniformity near that height, which prose never satisfies.
  const slideLike = heights.filter(
    (h) => h >= viewportHeight * 0.6 && h <= viewportHeight * 1.25,
  ).length;
  return slideLike >= heights.length * 0.7;
}

/**
 * Whether the slides sit ON TOP of each other rather than after each other.
 *
 * A deck that runs its own JavaScript usually lays every slide out at
 * `position:absolute; inset:0` and shows one at a time, so every rect has the
 * same top and scrolling to any of them changes nothing. That is the case
 * where navigation has to go through the deck's own keys (see `useDeck`) and
 * position has to be read from what is SHOWN rather than from an offset.
 *
 * "Same top" is judged against the slides' own height, not a pixel count, so
 * sub-pixel drift between boxes does not split the decision.
 */
export function isStacked(rects: readonly { top: number; height: number }[]): boolean {
  if (rects.length < 2) return false;
  const shortest = Math.min(...rects.map((r) => r.height));
  const first = rects[0].top;
  return rects.every((r) => Math.abs(r.top - first) < shortest / 2);
}

/** What the live frame says about the slide, and nothing more. */
export interface SlideComputed {
  display: string;
  visibility: string;
  opacity: string;
  transform: string;
}

export function readComputed(view: Window, el: Element): SlideComputed {
  const style = view.getComputedStyle(el);
  return {
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    transform: style.transform,
  };
}

/**
 * Whether a transform MOVES the slide, as opposed to scaling or rotating it.
 *
 * A carousel parks its off-screen slides with `translate3d(-150%, 0, 0)`, and
 * that has to go. A deck that renders its stage with `scale(0.5)` is doing
 * layout, and taking that away would be the flattening bug again in a new
 * costume. A browser resolves both to a matrix; jsdom echoes the authored
 * string straight back, so both forms are read.
 */
export function hasTranslation(transform: string): boolean {
  if (!transform || transform === "none") return false;
  const matrix = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim());
  if (!matrix) return /translate/i.test(transform);
  const parts = matrix[2].split(",").map((n) => Number(n.trim()));
  // matrix(a,b,c,d,e,f) carries the offset in e,f; matrix3d in 13 and 14.
  const x = matrix[1] ? parts[12] : parts[4];
  const y = matrix[1] ? parts[13] : parts[5];
  // A sub-pixel offset is rounding, not a parked slide.
  return Math.abs(x || 0) > 1 || Math.abs(y || 0) > 1;
}

/**
 * Whether the deck is showing this slide, by the four properties
 * `previewOverrides` already knows a deck hides one with. Anything a preview
 * would have to undo is, here, the reason a slide is not the current one.
 */
export function isShown(computed: SlideComputed): boolean {
  if (computed.display === "none") return false;
  if (computed.visibility === "hidden" || computed.visibility === "collapse") return false;
  // Only a MEASURED zero hides: jsdom reports "" for a property it does not
  // compute, and a browser never reports an empty opacity.
  const opacity = parseFloat(computed.opacity);
  if (!Number.isNaN(opacity) && opacity <= 0) return false;
  return !hasTranslation(computed.transform);
}

/**
 * The reader's position in a stacked deck: the first slide being shown. Falls
 * back to the first slide, as `activeIndex` does, so the rail always has
 * somewhere to be.
 */
export function shownIndex(shown: readonly boolean[]): number {
  const index = shown.indexOf(true);
  return index < 0 ? 0 : index;
}

/** A size a preview is laid out at, before it is scaled into a thumbnail. */
export interface StageSize {
  width: number;
  height: number;
}

/** A box in a frame's viewport, as `getBoundingClientRect` reports one. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How much a wrapper must differ from its slide in size to be the slide's content rather than the slide again. */
const SMALLER_PX = 2;
/** The shapes a letterboxed stage comes in, from a tall page to a wide banner of a slide. */
const STAGE_RATIO_MIN = 0.4;
const STAGE_RATIO_MAX = 3;
/** How far down nested wrappers are followed. */
const WRAPPER_DEPTH = 8;

/** An element's box, with anything a layout did not give a number read as nothing. */
function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  const n = (v: number) => (Number.isFinite(v) ? v : 0);
  return { left: n(r.left), top: n(r.top), width: n(r.width), height: n(r.height) };
}

/**
 * The one thing a slide holds, when it is not the slide's own size. Smaller,
 * it is a LETTERBOXED stage — a slide the size of the window around a stage of
 * a fixed shape, sized from the window (`font-size: min(100vw/80, 100vh/45)`)
 * and centred, so a frame taller than it is wide leaves bands above and below
 * it, so it is as wide or as tall as the slide, in a slide's shape; one thing
 * that is neither — a lone title, a strip — is the slide's content, not its
 * stage. Larger, it is a stage the deck's own script would have scaled down,
 * in a preview, where no script runs. Single wrappers the slide's own size are
 * followed down to the first that is not. A child with no box — a `<style>`,
 * something `display:none` — is not counted. Unclipped: how far it reaches
 * past its slide is what a preview grows by.
 */
export function stageBox(el: Element): Box | null {
  const outer = boxOf(el);
  let at: Element = el;
  for (let depth = 0; depth < WRAPPER_DEPTH; depth += 1) {
    const kids = Array.from(at.children).filter((child) => {
      const r = boxOf(child);
      return r.width >= 2 && r.height >= 2;
    });
    if (kids.length !== 1) return null;
    const inner = boxOf(kids[0]);
    const sameWidth = Math.abs(inner.width - outer.width) <= SMALLER_PX;
    const sameHeight = Math.abs(inner.height - outer.height) <= SMALLER_PX;
    if (sameWidth && sameHeight) {
      at = kids[0];
      continue;
    }
    // Larger: a stage no script scaled down. Smaller: a stage only if it is
    // letterboxed — as wide or as tall as the slide, in a slide's shape — and
    // not a title, a strip or a block a slide happens to hold alone.
    const larger = inner.width > outer.width + SMALLER_PX || inner.height > outer.height + SMALLER_PX;
    const shape = inner.height > 0 ? inner.width / inner.height : 0;
    const letterboxed = (sameWidth || sameHeight) && shape >= STAGE_RATIO_MIN && shape <= STAGE_RATIO_MAX;
    return larger || letterboxed ? inner : null;
  }
  return null;
}

/**
 * Where a slide's content is drawn: its stage (`stageBox`) when it has one,
 * else the slide's own box. Clipped to the slide's box: what spills past the
 * slide is not on it.
 */
export function contentBox(el: Element): Box {
  const outer = boxOf(el);
  const inner = stageBox(el);
  if (!inner) return outer;
  const left = Math.max(inner.left, outer.left);
  const top = Math.max(inner.top, outer.top);
  const right = Math.min(inner.left + inner.width, outer.left + outer.width);
  const bottom = Math.min(inner.top + inner.height, outer.top + outer.height);
  if (right - left < 2 || bottom - top < 2) return outer;
  return { left, top, width: right - left, height: bottom - top };
}

/** What a deck's slides are shaped by (`deckShape`). */
export type DeckShapeKind = "stage" | "page" | "fluid";

export interface DeckShape {
  kind: DeckShapeKind;
  /** Width over height of a thumbnail: one for the whole deck, so the rail is one column. */
  ratio: number;
}

/** A deck whose slides fill the window and reflow in it is shown as on a 1280×720 screen. */
export const FLUID_RATIO = 16 / 9;
export const FLUID_SHAPE: DeckShape = { kind: "fluid", ratio: FLUID_RATIO };

/**
 * The shape every thumbnail of a deck takes: the shape of the slides'
 * CONTENT, never of the reader's window. It used to be the window, and a phone,
 * or a desktop with the explorer, the slide list and the comments open, made
 * every thumbnail of a landscape deck portrait.
 *
 *   - `stage`: the slides hold a smaller wrapper (`contentBox`), a letterboxed
 *     stage, in that stage's shape, whatever the window does around it.
 *   - `page`: the slides do not fill the window — a CV's A4 pages, fixed-size
 *     sections, Marp's SVGs — in the page's own shape, portrait or not.
 *   - `fluid`: each slide fills the window and reflows in it, so its shape is
 *     whatever window it is read in; it is shown landscape, 16:9, laid out as
 *     on a 1280×720 screen. Pavel's choice, over the reader's own window.
 *
 * By most of the slides that have a box, and the median of their shapes,
 * which is a shape a real slide has. Fluid when nothing can be measured.
 */
export function deckShape(viewport: StageSize, slides: readonly Slide[]): DeckShape {
  const votes: Record<DeckShapeKind, number[]> = { stage: [], page: [], fluid: [] };
  for (const slide of slides) {
    const outer = boxOf(slide.outer);
    if (outer.width < 2 || outer.height < 2) continue;
    const content = contentBox(slide.outer);
    if (content.width < outer.width - SMALLER_PX || content.height < outer.height - SMALLER_PX) {
      votes.stage.push(content.width / content.height);
      continue;
    }
    const fills =
      viewport.width > 0 &&
      viewport.height > 0 &&
      outer.width >= viewport.width * 0.97 &&
      Math.abs(outer.height - viewport.height) <= viewport.height * 0.05;
    if (fills) votes.fluid.push(FLUID_RATIO);
    else votes.page.push(outer.width / outer.height);
  }
  const kinds: DeckShapeKind[] = ["stage", "page", "fluid"];
  const kind = kinds.reduce((best, k) => (votes[k].length > votes[best].length ? k : best), "fluid" as DeckShapeKind);
  const ratios = [...votes[kind]].sort((a, b) => a - b);
  if (ratios.length === 0) return FLUID_SHAPE;
  if (kind === "fluid") return FLUID_SHAPE;
  return { kind, ratio: ratios[(ratios.length - 1) >> 1] };
}
