// SPDX-License-Identifier: Apache-2.0
// Every identifier this app injects into a document it does not own (SPEC §10.1).

/**
 * This module is a CORRECTNESS boundary, not a naming convention.
 *
 * `serializeCleanHtml` DELETES every `[data-bshd]` node it finds before writing
 * a version, so a namespace collision with an uploaded bundle is silent data
 * loss: an author who happens to use the same attribute would watch their own
 * markup disappear one save at a time.
 *
 * Two defences, and both are needed:
 *
 *   1. A prefix long enough to be collision-proof against arbitrary HTML.
 *   2. A VALUE check. The serializer removes a `[data-bshd]` node only when its
 *      value is one WE write, which is what `OWN_MARKERS` and `isOwnMarker`
 *      exist for. The prefix alone would still delete a stranger's node.
 *
 * Every identifier is defined exactly once, here. In the design this replaces,
 * one of these strings was a literal in two files and another in three, and
 * every drift bug in that codebase came from exactly that.
 */

/** The attribute every injected node carries. */
export const OWN_ATTR = "data-bshd";

/**
 * The complete set of values we ever write to `OWN_ATTR`.
 *
 * Adding an injection means adding its marker here. The dev-only invariant
 * assertion and the serializer both read this set, so an unlisted marker fails
 * loudly rather than surviving into a published version.
 */
export const OWN_MARKERS = [
  "hl-style",
  "edit-placeholders",
  "edit-fonts",
  "peers",
  "peer-style",
] as const;

export type OwnMarker = (typeof OWN_MARKERS)[number];

const MARKER_SET: ReadonlySet<string> = new Set(OWN_MARKERS);

/** True only for a node this app injected. */
export function isOwnMarker(el: Element): boolean {
  const value = el.getAttribute(OWN_ATTR);
  return value != null && MARKER_SET.has(value);
}

/** Tag a node as ours, so the serializer will strip it. */
export function markOwn(el: Element, marker: OwnMarker): void {
  el.setAttribute(OWN_ATTR, marker);
}

/** CSS selector matching only our own injected nodes. */
export const OWN_SELECTOR = OWN_MARKERS.map(
  (m) => `[${OWN_ATTR}="${m}"]`,
).join(", ");

// --- Injected element ids --------------------------------------------------

export const HL_STYLE_ID = "bshd-hl-style";
export const EDIT_FONTS_ID = "bshd-edit-fonts";
export const EDIT_PLACEHOLDERS_ID = "bshd-edit-placeholders";
export const PEER_STYLE_ID = "bshd-peer-style";
export const PEER_LAYER_ID = "bshd-peers";

// --- Classes and attributes inside the document ----------------------------

export const HL_CLASS = "bshd-hl";

/**
 * The elements a highlight wraps text in: `<mark>` in HTML, `<tspan>` inside
 * SVG text. Two, because SVG renders no foreign child of a text content
 * element — an HTML `<mark>` inside `<text>` paints nothing at all, and a
 * commented label in a figure simply vanished.
 */
export const HL_TAGS = ["mark", "tspan"] as const;

/** CSS selector matching a highlight wrapper of either kind. */
export const HL_SELECTOR = HL_TAGS.map((t) => `${t}.${HL_CLASS}`).join(", ");

/**
 * True for a node `highlightRange` wrapped around text.
 *
 * Through the selector, not `tagName`: that is `"MARK"` for the HTML wrapper
 * and lowercase `"tspan"` for the SVG one, so a tag comparison written for one
 * silently misses the other.
 */
export function isHighlightWrapper(el: Element): boolean {
  return el.matches(HL_SELECTOR);
}

/**
 * The annotation id carried by a highlight.
 *
 * Namespaced deliberately: in the design this replaces it was a bare
 * `data-ann-id`, which leaked an un-namespaced attribute into every document
 * the product touched.
 */
export const ANN_ATTR = "data-bshd-ann";

/**
 * Marks a highlight that belongs to a SUGGESTED EDIT, whose text it strikes
 * through (SPEC §22). The value is the annotation id.
 *
 * Deliberately NOT in `OWN_MARKERS`: it sits on a highlight wrapper, which the
 * strip legs UNWRAP through `HL_SELECTOR` — keeping the author's text — rather
 * than delete. Put in that set, the serializer would delete the wrapper whole,
 * and the author's words inside it with it.
 */
export const SUG_ATTR = "data-bshd-sug";

/**
 * The proposed replacement, as an ATTRIBUTE on the last wrapper of a
 * suggestion, shown by the injected stylesheet as generated content
 * (`content: attr(…)`). Never as a text node: a node would add to the
 * document's `textContent`, which every anchor is measured against, so every
 * comment and peer selection made while it was shown would be anchored to text
 * that is not in the document. Outside `OWN_MARKERS` for the reason above.
 */
export const INS_ATTR = "data-bshd-ins";

/** The author-colour custom property a highlight reads (SPEC §16). */
export const AUTHOR_COLOR_VAR = "--bshd-author";

/** Marks an id-bearing container the author left for a script to fill. */
export const EMPTY_ATTR = "data-bshd-empty";

/**
 * Marks the one slide inside a thumbnail preview, so the preview's own
 * stylesheet can force it visible without flattening its layout.
 *
 * Deliberately NOT in `OWN_MARKERS`, for two separate reasons:
 *
 *   - That list enumerates legal values of `data-bshd`, a different attribute.
 *     An entry would make `isOwnMarker` and `OWN_SELECTOR` claim
 *     `data-bshd="preview"`, which nothing writes.
 *   - `OWN_MARKERS` means "a node the serializer deletes whole". This lands on
 *     the AUTHOR's own slide element, so were it ever in that set and ever to
 *     reach a live node, `serializeCleanHtml` would delete the author's slide
 *     on the next save. `EMPTY_ATTR` sits outside the set for the same reason.
 *
 * It needs no cleanup path because it cannot reach a live node at all: it is
 * set on a clone, in a document the parent builds, which is handed to `srcDoc`
 * and never adopted into the reader's frame. `SlideThumb.test.tsx` pins that.
 */
export const PREVIEW_ATTR = "data-bshd-preview";

/**
 * Marks an element inside a preview's slide that the page itself still hides —
 * content a deck reveals only once its script shows the slide, which a preview
 * never runs. The preview's stylesheet forces whatever carries it visible.
 *
 * Outside `OWN_MARKERS` for the same reasons as `PREVIEW_ATTR`, and needing no
 * cleanup for the same reason: it is written only into the preview document,
 * after it has loaded, never into the frame the reader reads.
 */
export const REVEAL_ATTR = "data-bshd-reveal";

/**
 * On a link that leaves the document, in an engine that delivers the viewer no
 * clicks from a sandboxed frame: the author's own `target` and `rel`, saved as
 * JSON (`{"target": …, "rel": …}`, null for an attribute that was absent)
 * while the viewer has set them to open the link beside the document. The
 * strip legs RESTORE them from it and remove it, so it is outside
 * `OWN_MARKERS` for the same reason as `SUG_ATTR`: it sits on the author's
 * element, which must never be deleted.
 */
export const LINK_ATTR = "data-bshd-link";

/**
 * The event the viewer dispatches into a document it has just loaded, to learn
 * whether a listener it adds there is ever called (viewer/frameWatch.ts).
 * Never seen by the document's own script, which a document that refuses
 * listeners runs none of; a trusted one may see it, and nothing follows from it.
 */
export const FRAME_PROBE_EVENT = "bshd-frame-probe";

// --- Export stamps ---------------------------------------------------------

export const PRINT_MARK_CLASS = "bshd-print-mark";
export const PRINT_FOOTER_CLASS = "bshd-print-footer";

// --- Environment variable names --------------------------------------------
// Named here so the app, the scripts and the functions cannot disagree.

export const FUNCTIONS_ORIGIN_ENV = "BIKESHED_FUNCTIONS_ORIGIN";
export const BUCKET_ENV = "BIKESHED_BUCKET";

/**
 * Parent-application DOM names are deliberately NOT prefixed.
 *
 * `.btn`, `.card`, `data-tip` and their kind never enter the document iframe,
 * so they cannot collide with anything an author wrote, and prefixing them
 * would make the app's own stylesheet harder to read for no benefit.
 */
