// SPDX-License-Identifier: Apache-2.0
// Selection to Anchor, and back (SPEC §6).

import * as textPosition from "dom-anchor-text-position";
import * as textQuote from "dom-anchor-text-quote";
import type { Anchor } from "../types";

/**
 * Two selectors, and the pairing is the whole design.
 *
 * A TEXT QUOTE (exact, with a little context either side) survives the text
 * moving: insert three paragraphs above and the quote still resolves. A TEXT
 * POSITION survives the text CHANGING: reword the sentence and the quote no
 * longer matches, but the offsets still land near it. Neither alone is enough,
 * and the fallback order matters — quote first, because a position that has
 * drifted points confidently at the wrong words.
 *
 * Both are scoped to the nearest ancestor carrying an `id`. That is what makes
 * them survive an edit at all: measured against <body>, every offset in the
 * document shifts when anything above changes, and the quote search has the
 * whole document to get lost in. Scoped to a section, an edit in one section
 * cannot disturb anchors in another.
 *
 * This is also why the Markdown renderer wraps headings in <section id> (SPEC
 * §11), and why the authoring guide asks for an id on every section.
 */

/** Walk up to the nearest ancestor Element carrying an id. */
function nearestIdElement(node: Node | null): Element | null {
  let el: Element | null =
    node && node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : (node?.parentElement ?? null);
  while (el) {
    if (el.id) return el;
    el = el.parentElement;
  }
  return null;
}

/** The element an Anchor is measured against. Falls back to the body. */
function rootForElementId(iframeDoc: Document, elementId: string): Element | null {
  if (elementId) return iframeDoc.getElementById(elementId);
  return iframeDoc.body ?? iframeDoc.documentElement;
}

/**
 * Describe the current selection as an Anchor.
 *
 * Returns null for anything unusable — collapsed, empty, or whitespace only —
 * rather than producing an anchor that can never be resolved.
 */
export function describeAnchorFromSelection(iframeDoc: Document): Anchor | null {
  const sel = iframeDoc.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;
  if (range.toString().trim().length === 0) return null;

  return describeAnchorFromRange(iframeDoc, range);
}

/** Describe an arbitrary Range. Used for peer selections as well as our own. */
export function describeAnchorFromRange(
  iframeDoc: Document,
  range: Range,
): Anchor | null {
  const idEl = nearestIdElement(range.commonAncestorContainer);
  const elementId = idEl?.id ?? "";
  const root = rootForElementId(iframeDoc, elementId);
  if (!root) return null;

  try {
    const quote = textQuote.fromRange(root, range);
    const position = textPosition.fromRange(root, range);
    return {
      elementId,
      exact: quote.exact,
      prefix: quote.prefix ?? "",
      suffix: quote.suffix ?? "",
      start: position.start,
      end: position.end,
    };
  } catch {
    return null;
  }
}

/**
 * Rehydrate an Anchor into a live Range.
 *
 * The position offsets are passed to the quote resolver as a HINT, so when the
 * same words appear more than once the nearest occurrence wins rather than the
 * first. Returns null when the anchored text can no longer be found at all,
 * which the caller renders as an orphaned comment rather than silently dropping.
 */
export function rangeFromAnchor(iframeDoc: Document, anchor: Anchor): Range | null {
  const root = rootForElementId(iframeDoc, anchor.elementId);
  if (!root) return null;

  try {
    const byQuote = textQuote.toRange(
      root,
      { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix },
      { hint: anchor.start },
    );
    if (byQuote) return byQuote;
  } catch {
    // Fall through: a throwing quote resolver is the same situation as a
    // missing match, and the position fallback is exactly what it is for.
  }

  try {
    return textPosition.toRange(root, { start: anchor.start, end: anchor.end });
  } catch {
    return null;
  }
}

/** True when two anchors refer to the same passage. Used to dedupe peer focus. */
export function sameAnchor(a: Anchor | undefined, b: Anchor | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.elementId === b.elementId &&
    a.start === b.start &&
    a.end === b.end &&
    a.exact === b.exact
  );
}
