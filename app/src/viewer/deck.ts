// SPDX-License-Identifier: Apache-2.0
// What counts as a slide, and where the reader is in one (SPEC §6d).

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

export function slideTitle(el: Element, index: number): string {
  const authored = el.getAttribute("data-title")?.trim();
  if (authored) return authored;

  const heading = el.querySelector("h1, h2, h3")?.textContent?.trim();
  if (heading) return heading;

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
  const run = Array.from(seed.parentElement.children).filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement &&
      el.tagName === seed.tagName &&
      (token ? el.classList.contains(token) : true),
  );
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
