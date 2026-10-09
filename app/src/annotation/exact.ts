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

/** Where a text stands in the normalised text, and how many sides of its context agree. */
interface Match {
  start: number;
  end: number;
  sides: 1 | 2;
}

/**
 * The one place a text stands, chosen by its context, or null.
 *
 *   1. the unique occurrence whose prefix AND suffix still match;
 *   2. else the unique occurrence where either does;
 *   3. else nothing.
 *
 * Empty context matches anything, so a quote at the very start or end of its
 * section is not penalised for having nothing beside it.
 */
function locate(text: string, q: { exact: string; prefix: string; suffix: string }): Match | null {
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
  if (both.length === 1) return { start: both[0].at, end: both[0].at + exact.length, sides: 2 };
  if (both.length === 0 && either.length === 1) return { start: either[0].at, end: either[0].at + exact.length, sides: 1 };
  return null;
}

/**
 * Where a deletion was made: the one point where the prefix ends and the
 * suffix begins. Only with both sides, because one side alone stands there
 * whether or not the quote between them is gone.
 */
function locateJoin(text: string, q: { prefix: string; suffix: string }): Match | null {
  const prefix = squash(q.prefix).trim();
  const suffix = squash(q.suffix).trim();
  if (!prefix || !suffix) return null;
  const joins = occurrences(text, prefix)
    .map((at) => at + prefix.length)
    .filter((p) => text.slice(p).trimStart().startsWith(suffix));
  return joins.length === 1 ? { start: joins[0], end: joins[0], sides: 2 } : null;
}

/**
 * A Range over raw characters `start` to `end` of `root`'s text, held tight:
 * it starts in the text node holding the first character and ends in the one
 * holding the last.
 *
 * Not `dom-anchor-text-position`'s `toRange`, which resolves an end that falls
 * on a node boundary to offset 0 of the NEXT text node. A quote ending its
 * paragraph then ends in the whitespace between blocks, its range spans two,
 * and the last words of every paragraph of rendered Markdown were refused.
 */
function rangeAt(root: Node, start: number, end: number): Range | null {
  const doc = root.ownerDocument ?? (root as Document);
  const nodes = doc.createNodeIterator(root, 4 /* NodeFilter.SHOW_TEXT */);
  const range = doc.createRange();
  let at = 0;
  let started = false;
  for (let n = nodes.nextNode() as Text | null; n; n = nodes.nextNode() as Text | null) {
    const len = n.data.length;
    if (!started && start < at + len) {
      range.setStart(n, start - at);
      started = true;
    }
    if (started && end <= at + len) {
      range.setEnd(n, end - at);
      return range;
    }
    at += len;
  }
  return null;
}

/** A live Range over exactly the anchored text, or null when it is not unambiguously there. */
export function exactRangeFromAnchor(doc: Document, anchor: Anchor): Range | null {
  const root = rootOf(doc, anchor);
  if (!root) return null;
  const { text, rawAt } = normalise(root.textContent ?? "");
  const found = locate(text, anchor);
  return found ? rangeAt(root, rawAt[found.start], rawAt[found.end - 1] + 1) : null;
}

export type Resolution = { state: "pending"; range: Range } | { state: "applied" } | { state: "stale" };

/**
 * Where a suggestion stands in the document as it is NOW: still to be made
 * (with the range it replaces), already made, or stale.
 *
 * The quote and its replacement are looked for by ONE rule, between the same
 * context. Two rules are how this went wrong: the quote was found by either
 * side of its context, the result was then checked for by both, and an edit
 * beside the quote left a change made in the document and "nothing was
 * accepted" on the screen.
 *
 *   - Where one contains the other, the larger is what stands there. A
 *     replacement that keeps its quote ("X" → "Y, X") is not pending again
 *     because X is still visible; a quote that contains its replacement is
 *     not applied because the shorter text is visible inside it.
 *   - Otherwise whichever agrees with more of the context wins, and a tie
 *     is stale: nothing is changed on a guess.
 *
 * Without any context at all a replacement cannot be recognised, so only the
 * quote counts, as it always did.
 */
export function resolveSuggestion(doc: Document, anchor: Anchor, replacement: string): Resolution {
  const root = rootOf(doc, anchor);
  if (!root) return { state: "stale" };
  const { text, rawAt } = normalise(root.textContent ?? "");
  const quote = locate(text, anchor);
  const hasContext = Boolean(anchor.prefix.trim() || anchor.suffix.trim());
  const made = !hasContext
    ? null
    : squash(replacement).trim() === ""
      ? locateJoin(text, anchor)
      : locate(text, { exact: replacement, prefix: anchor.prefix, suffix: anchor.suffix });

  const pending = (): Resolution => {
    const range = rangeAt(root, rawAt[quote!.start], rawAt[quote!.end - 1] + 1);
    return range && suggestibleRange(range) === true ? { state: "pending", range } : { state: "stale" };
  };
  if (quote && made) {
    const within = (a: Match, b: Match) => a.start >= b.start && a.end <= b.end;
    if (within(quote, made)) return { state: "applied" };
    if (within(made, quote)) return pending();
    if (made.sides !== quote.sides) return made.sides > quote.sides ? { state: "applied" } : pending();
    return { state: "stale" };
  }
  if (made) return { state: "applied" };
  if (quote) return pending();
  return { state: "stale" };
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
    return rangeAt(root, at.start + lead, at.end - trail) ?? range;
  } catch {
    return range;
  }
}

/** What may follow a deleted word directly, so the space before it goes instead. */
const CLOSING = /^[.,;:!?)\]}…'"’”]/;

/**
 * A deletion widened by the one space it would otherwise leave doubled.
 *
 * Deleting "OpenAI" from "vs. OpenAI Codex" by its characters leaves two
 * spaces, which the browser keeps visible as `&nbsp; ` and the next version
 * keeps for good. Between two spaces the one after goes; before punctuation or
 * at the end of the block, the one before; at the start of the block, the one
 * after. Measured within the block, so it never reaches into the next one.
 */
function widenDeletion(range: Range): Range {
  const block = blockOf(range.startContainer);
  if (!block) return range;
  const text = block.textContent ?? "";
  let at: { start: number; end: number };
  try {
    at = textPosition.fromRange(block, range);
  } catch {
    return range;
  }
  const before = text[at.start - 1];
  const after = text[at.end];
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  let { start, end } = at;
  if (space(before) && space(after)) end += 1;
  else if (space(before) && (after === undefined || CLOSING.test(after))) start -= 1;
  else if (before === undefined && space(after)) end += 1;
  else return range;
  return rangeAt(block, start, end) ?? range;
}

export type ApplyResult = "applied" | "already-applied" | "stale" | "failed" | "unverified";

/**
 * Make a suggested edit in the live editing session, as a person would.
 *
 * The range is found exactly, in the document as it is NOW — the draft, with
 * every co-editor's changes in it — selected, and replaced with `insertText`
 * (or `delete` for an empty replacement). That is the same path as typing over
 * a selection, so the CRDT carries it to every peer and autosave stores it,
 * with nothing special about it anywhere downstream (SPEC §22).
 *
 *   applied          made now, and the text reads exactly as asked
 *   already-applied  the replacement already stands where the quote stood —
 *                    an earlier attempt that was not recorded; do not repeat it
 *   stale            the quote is not unambiguously there, or now spans
 *                    structure: nothing is touched
 *   failed           the editor refused, or did something else and that was
 *                    undone: the document is as it was
 *   unverified       the editor did something else and it could not be
 *                    undone: the passage has changed and needs looking at
 *
 * Checked by what the text must now be, not by finding the spot again: the
 * spot was found once, and finding it again by a stricter rule is how a made
 * change was once reported as not made.
 */
export function applySuggestion(doc: Document, anchor: Anchor, replacement: string): ApplyResult {
  const found = resolveSuggestion(doc, anchor, replacement);
  if (found.state === "applied") return "already-applied";
  if (found.state === "stale") return "stale";
  const range = replacement === "" ? widenDeletion(found.range) : found.range;

  const textNow = () => rootOf(doc, anchor)?.textContent ?? "";
  const same = (a: string, b: string) => squash(a).trim() === squash(b).trim();
  const root = rootOf(doc, anchor)!;
  const before = root.textContent ?? "";
  let expected: string;
  try {
    const at = textPosition.fromRange(root, range);
    expected = before.slice(0, at.start) + replacement + before.slice(at.end);
  } catch {
    return "stale";
  }

  // The editing host must have focus for execCommand to act on the frame
  // (the toolbar does the same before every command).
  try {
    doc.defaultView?.focus();
  } catch {
    /* a detached document has no window to focus */
  }
  const sel = doc.getSelection();
  if (!sel) return "failed";
  sel.removeAllRanges();
  sel.addRange(range);
  const ok =
    replacement === ""
      ? doc.execCommand("delete", false)
      : doc.execCommand("insertText", false, replacement);
  if (!ok) return same(textNow(), before) ? "failed" : "unverified";
  if (same(textNow(), expected)) return "applied";
  // Something other than what was asked. Take it back through the editor, so
  // the shared document and autosave see the undo as they saw the edit.
  doc.execCommand("undo", false);
  return same(textNow(), before) ? "failed" : "unverified";
}
