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
export const HL_RESOLVED_CLASS = "bshd-hl--resolved";

/**
 * The annotation id carried by a highlight.
 *
 * Namespaced deliberately: in the design this replaces it was a bare
 * `data-ann-id`, which leaked an un-namespaced attribute into every document
 * the product touched.
 */
export const ANN_ATTR = "data-bshd-ann";

/** The author-colour custom property a highlight reads (SPEC §16). */
export const AUTHOR_COLOR_VAR = "--bshd-author";

/** Marks an id-bearing container the author left for a script to fill. */
export const EMPTY_ATTR = "data-bshd-empty";

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
