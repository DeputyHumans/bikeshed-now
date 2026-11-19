// SPDX-License-Identifier: Apache-2.0
// A place in a document as the part of its address after `#`: a section or slide by its id, a slide by number, a comment thread (SPEC §6e).

import { OWN_SELECTOR } from "../brand/dom";
import { slideOf, type Slide } from "./deck";

/**
 * The part after `#` on Bikeshed's own address for a document, never the
 * document's own (a deck's script keeps that inside the frame, in a format of
 * its own, and nothing reads it). Three forms, chosen so a person can read and
 * type them and so the server never sees them (ADR 0035):
 *
 *   `#<id>`               an element the author gave an id — a section, a heading, a slide
 *   `#slide=<n>`          a slide by its place in reading order, from 1, for a slide with no id
 *   `#comment=<thread>`   a comment thread, always on the path of the version it is on
 *
 * The two reserved forms win over an author's id spelled the same way, and an
 * id spelled that way is never linked to by id.
 */

export type Target =
  | { kind: "id"; id: string }
  | { kind: "slide"; n: number }
  | { kind: "comment"; id: string };

const SLIDE = "slide=";
const COMMENT = "comment=";
/** A slide number as a link may carry it: a whole number from 1, as long as the presence rules allow (SLIDE_MAX + 1). */
const SLIDE_NUMBER = /^[1-9][0-9]{0,3}$/;

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Read the part after `#`, with or without the `#`. Null for nothing, or for something no link here would say. */
export function parseTarget(hash: string): Target | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  if (raw.startsWith(COMMENT)) {
    const id = decode(raw.slice(COMMENT.length));
    return id && !/[\s/]/.test(id) ? { kind: "comment", id } : null;
  }
  if (raw.startsWith(SLIDE)) {
    const n = raw.slice(SLIDE.length);
    return SLIDE_NUMBER.test(n) ? { kind: "slide", n: Number(n) } : null;
  }
  const id = decode(raw);
  return id && !/\s/.test(id) ? { kind: "id", id } : null;
}

/** Whether an author's id can stand in a link as itself: not empty, no whitespace, and not one of the reserved forms. */
export function linkableId(id: string): boolean {
  return id.length > 0 && !/\s/.test(id) && !id.startsWith(SLIDE) && !id.startsWith(COMMENT);
}

/** The part after `#`, with the `#`. */
export function formatTarget(target: Target): string {
  switch (target.kind) {
    case "comment":
      return `#${COMMENT}${encodeURIComponent(target.id)}`;
    case "slide":
      return `#${SLIDE}${target.n}`;
    case "id":
      return `#${encodeURIComponent(target.id)}`;
  }
}

/** `?k=` as the reader's own address carries it, and nothing else of the query. */
export function keyQuery(search: string): string {
  const k = new URLSearchParams(search).get("k");
  return k ? `?k=${encodeURIComponent(k)}` : "";
}

/**
 * A link to a place, built on the address the reader is on: its path, and
 * `?k=` if it has one. A comment thread's link always names the version the
 * thread is on, so it keeps working after the next version is published and is
 * the same link the comment email and the agent tools give.
 */
export function targetUrl(
  here: { origin: string; pathname: string; search: string },
  target: Target,
  thread?: { docId: string; versionId: string },
): string {
  const path = target.kind === "comment" && thread
    ? `/d/${encodeURIComponent(thread.docId)}/${encodeURIComponent(thread.versionId)}`
    : here.pathname;
  return `${here.origin}${path}${keyQuery(here.search)}${formatTarget(target)}`;
}

/**
 * How a slide is linked to: by its own id when it has one that finds it again,
 * which survives slides added before it, else by its number.
 */
export function slideTarget(slide: Slide): Target {
  const doc = slide.el.ownerDocument;
  for (const el of [slide.el, slide.outer]) {
    if (el.id && linkableId(el.id) && doc.getElementById(el.id) === el) return { kind: "id", id: el.id };
  }
  return { kind: "slide", n: slide.index + 1 };
}

/**
 * What "Copy link" on a passage links to: the nearest element around it that
 * the author gave an id — the same element a comment there is anchored in
 * (SPEC §6) — or, on a deck, its slide when nothing inside the slide has one.
 * Our own nodes and an id another element took first are passed over. Null
 * when there is neither, and then no link is offered.
 */
export function targetForNode(node: Node | null, slides: readonly Slide[], paged: boolean): Target | null {
  if (!node) return null;
  const doc = node.ownerDocument;
  if (!doc) return null;
  const slide = paged ? slideOf(slides, node) : -1;
  const stop = slide >= 0 ? slides[slide].outer : null;
  let el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
  for (; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    if (el.id && linkableId(el.id) && doc.getElementById(el.id) === el && !el.closest(OWN_SELECTOR)) {
      return { kind: "id", id: el.id };
    }
    // Not past the slide: an element around the whole deck is no place on one slide.
    if (el === stop) break;
  }
  return slide >= 0 ? slideTarget(slides[slide]) : null;
}

/**
 * Which slide a target is on, or -1: a slide by number, the slide holding an
 * element, or the slide holding a thread's passage (`passage` finds it).
 */
export function slideOfTarget(
  doc: Document,
  target: Target | null,
  slides: readonly Slide[],
  passage: (threadId: string) => Element | null,
): number {
  if (!target) return -1;
  if (target.kind === "slide") return target.n <= slides.length ? target.n - 1 : -1;
  if (target.kind === "id") return slideOf(slides, doc.getElementById(target.id));
  return slideOf(slides, passage(target.id));
}

/** Put text on the clipboard. False where the clipboard is missing or refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
