// SPDX-License-Identifier: Apache-2.0
// Strict anchor resolution, for text that is about to be REPLACED (SPEC §22).

import * as textPosition from "dom-anchor-text-position";
import type { Anchor } from "../types";

/**
 * Why a second resolver exists beside `rangeFromAnchor`.
 *
 * A comment's highlight may land approximately: if the sentence was reworded,
 * the nearest fuzzy match, or the old offsets, is still the right thing to
 * point at. `rangeFromAnchor` does exactly that — `dom-anchor-text-quote`
 * matches with diff-match-patch, and falls back to positions.
 *
 * A suggestion is going to DELETE what it resolves to. Approximately right is
 * wrong words deleted. So this resolver matches the quote exactly (with only
 * whitespace normalised, because reflowed markup is the same text), uses the
 * context to choose between repeats, and returns null rather than guess. A
 * null is a STALE suggestion: shown as such, and only rejectable (ADR 0013).
 */

/** Collapse whitespace runs to one space, keeping a map back to raw offsets. */
function normalise(raw: string): { text: string; rawAt: number[] } {
  let text = "";
  const rawAt: number[] = [];
  let inSpace = false;
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      if (inSpace) continue;
      inSpace = true;
      text += " ";
    } else {
      inSpace = false;
      text += raw[i];
    }
    rawAt.push(i);
  }
  rawAt.push(raw.length);
  return { text, rawAt };
}

const squash = (s: string) => s.replace(/\s+/g, " ");

/** The element an anchor is measured against; the body when its id is gone. */
function rootOf(doc: Document, anchor: Pick<Anchor, "elementId">): Element | null {
  return (anchor.elementId && doc.getElementById(anchor.elementId)) || doc.body || null;
}

/** Every index at which `needle` starts in `hay`. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * The one place a quote stands, chosen by its context, or null.
 *
 *   1. the unique occurrence whose prefix AND suffix still match;
 *   2. else the unique occurrence where either does;
 *   3. else nothing.
 *
 * Empty context matches anything, so a quote at the very start or end of its
 * section is not penalised for having nothing beside it.
 */
function locate(
  text: string,
  q: { exact: string; prefix: string; suffix: string },
): { start: number; end: number } | null {
  const exact = squash(q.exact).trim();
  if (!exact) return null;
  const prefix = squash(q.prefix).trimEnd();
  const suffix = squash(q.suffix).trimStart();
  const scored = occurrences(text, exact).map((at) => {
    const before = text.slice(0, at).trimEnd();
    const after = text.slice(at + exact.length).trimStart();
    return {
      at,
      pre: prefix === "" || before.endsWith(prefix),
      suf: suffix === "" || after.startsWith(suffix),
    };
  });
  const both = scored.filter((c) => c.pre && c.suf);
  const either = scored.filter((c) => c.pre || c.suf);
  const pick = both.length === 1 ? both[0] : both.length === 0 && either.length === 1 ? either[0] : null;
  return pick ? { start: pick.at, end: pick.at + exact.length } : null;
}

/** A live Range over exactly the anchored text, or null when it is not unambiguously there. */
export function exactRangeFromAnchor(doc: Document, anchor: Anchor): Range | null {
  const root = rootOf(doc, anchor);
  if (!root) return null;
  const { text, rawAt } = normalise(root.textContent ?? "");
  const found = locate(text, anchor);
  if (!found) return null;
  try {
    return textPosition.toRange(root, { start: rawAt[found.start], end: rawAt[found.end - 1] + 1 });
  } catch {
    return null;
  }
}

/**
 * Has this replacement already been made where the anchor stood? True when the
 * replacement, between the anchor's own context, occurs exactly once. This is
 * what lets an Accept that was interrupted after the edit but before it was
 * recorded be finished without making the edit twice.
 */
export function alreadyApplied(doc: Document, anchor: Anchor, replacement: string): boolean {
  const root = rootOf(doc, anchor);
  if (!root) return false;
  const tail = squash(anchor.prefix).trimEnd().slice(-24);
  const head = squash(anchor.suffix).trimStart().slice(0, 24);
  if (!tail && !head) return false; // nothing to recognise the spot by
  const text = normalise(root.textContent ?? "").text;
  const glue = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);
  // Either side may or may not have kept a space at the join, and a deletion
  // leaves the two contexts touching; try the plausible spellings.
  const body = squash(replacement).trim();
  const candidates = new Set(
    body
      ? [glue(glue(tail, body), head), `${tail}${body}${head}`, glue(tail, `${body}${head}`), glue(`${tail}${body}`, head)]
      : [glue(tail, head), `${tail}${head}`],
  );
  return [...candidates].some((c) => occurrences(text, c).length === 1);
}

/** The elements whose contents are one run of text for the purpose of a suggestion. */
const BLOCKS = new Set([
  "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH", "DT", "DD",
  "BLOCKQUOTE", "PRE", "FIGCAPTION", "CAPTION", "SUMMARY", "LEGEND", "LABEL",
  "DIV", "SECTION", "ARTICLE", "ASIDE", "MAIN", "HEADER", "FOOTER", "NAV", "BODY",
]);

/** What a suggestion may not contain: anything that is not text. */
const NOT_TEXT =
  "br, hr, img, picture, svg, math, video, audio, iframe, object, embed, canvas, " +
  "input, select, textarea, button, table, ul, ol, dl";

function blockOf(node: Node): Element | null {
  let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && !BLOCKS.has(el.tagName.toUpperCase())) el = el.parentElement;
  return el;
}

function insideSvg(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(el?.closest("svg, math"));
}

/**
 * May this range be the subject of a suggestion? True, or why not, in words a
 * reader is shown beside the disabled action.
 *
 * Text inside ONE block, with nothing but text in it. A replacement is typed
 * in with `insertText`, which would flatten anything structural the range held
 * — a line break, a list, an image — and a range across two paragraphs would
 * merge them. Text inside a figure is not editable text at all.
 */
export function suggestibleRange(range: Range): true | { reason: string } {
  if (range.collapsed || range.toString().trim() === "") {
    return { reason: "Select some text to suggest an edit to it." };
  }
  if (insideSvg(range.startContainer) || insideSvg(range.endContainer)) {
    return { reason: "Text inside a figure can’t be edited." };
  }
  if (blockOf(range.startContainer) !== blockOf(range.endContainer)) {
    return { reason: "A suggestion stays within one paragraph." };
  }
  if (range.cloneContents().querySelector(NOT_TEXT)) {
    return {
      reason: "A suggestion can only change text, and this includes a line break, list, table or image.",
    };
  }
  return true;
}

/**
 * The same range without whitespace at either end. A selection made by
 * double-clicking or dragging often takes a trailing space with it, and a
 * quote that ends in one asks the author to retype a space they cannot see.
 */
export function trimToText(range: Range): Range {
  const text = range.toString();
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  if ((lead === 0 && trail === 0) || lead + trail >= text.length) return range;
  const common = range.commonAncestorContainer;
  const root = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
  if (!root) return range;
  try {
    const at = textPosition.fromRange(root, range);
    return textPosition.toRange(root, { start: at.start + lead, end: at.end - trail }) ?? range;
  } catch {
    return range;
  }
}
