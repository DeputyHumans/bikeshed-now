// SPDX-License-Identifier: Apache-2.0
// The DOM <-> CRDT binding: shared document state without a schema (SPEC §6b, §16).

import * as Y from "yjs";
import { EMPTY_ATTR, isHighlightWrapper, isOwnMarker } from "../brand/dom";

/**
 * Why a hand-written binding rather than y-prosemirror
 * ----------------------------------------------------
 * Every off-the-shelf rich-text binding normalizes a document into an editor's
 * own schema. For hand-authored HTML — a deck with inline SVG, a <details>
 * tree, a scroll observer — normalizing is destruction, which is the whole
 * reason this product edits the authored DOM in place (ADR 0007).
 *
 * Yjs's XML types are the exception: `Y.XmlElement` is a name, a string map and
 * a child list. It has no opinion about what an element may be called, what
 * attributes it may carry, or what may nest inside what. So it can mirror an
 * arbitrary DOM exactly, and the schema question never arises — the document
 * stays whatever its author wrote it to be.
 *
 * That is the property this module exists to hold, and the round-trip test is
 * what holds it: both sample bundles, byte-identical, through the wire format.
 *
 * Three places it is easy to lose:
 *
 *   1. NAMESPACES. `document.createElement("svg")` makes an HTML element, and
 *      an HTML element lowercases its attribute names — so `viewBox` comes back
 *      as `viewbox` and the graphic silently stops scaling. Inside <svg> every
 *      element must be created with `createElementNS`, and `xlink:href` needs
 *      its own namespace or it is inert. This is not hypothetical: it is what
 *      the first version of this module did to the tour deck.
 *   2. COMMENTS. Yjs has no comment node, and a bundle's licence header is a
 *      comment. They are carried as a reserved element and restored on the way
 *      out, so a round trip cannot quietly eat one.
 *   3. DECORATION. See below.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * The element a comment is carried as.
 *
 * Deliberately inside the `bshd-` namespace so it is collision-proof against
 * arbitrary HTML, and deliberately NOT in `OWN_MARKERS`: those are nodes the
 * serializer deletes, and this one must become a comment again instead.
 */
export const COMMENT_TAG = "bshd-comment";

/**
 * Decoration must never enter the shared document.
 *
 * This is the fourth leg of the §13 invariant, and the CRDT adds a path it did
 * not have to cover before: anything in the local DOM when the document is
 * seeded or observed is replicated to every peer and then serialized into the
 * next version. A highlight that reached the CRDT would not just contaminate
 * one save — it would arrive in everyone's document and be impossible to tell
 * from the author's own markup afterwards.
 *
 * So the binding refuses it at the boundary, on the same terms as
 * `serializeCleanHtml`: an own-marked node is dropped whole, and a highlight
 * mark is unwrapped with its children kept. By VALUE, never by prefix — a
 * document may legitimately contain `data-bshd="something-else"`, and deleting
 * it would be silent data loss in a document we do not own.
 */
function skipEntirely(el: Element): boolean {
  return isOwnMarker(el);
}

function unwrapOnly(el: Element): boolean {
  return isHighlightWrapper(el);
}

/**
 * Attributes we inject onto nodes we otherwise keep.
 *
 * Exactly the set `serializeCleanHtml` removes, and no more. `data-bshd` is
 * NOT here, and must never be: a node carrying a value that is not one of ours
 * belongs to the document's author, and stripping it by prefix would be silent
 * data loss in a document we do not own. A node whose value IS ours never gets
 * this far — `skipEntirely` has already dropped it whole.
 */
const INJECTED_ATTRS = new Set(["contenteditable", EMPTY_ATTR]);

// --- DOM -> CRDT -------------------------------------------------------------

/** One node, or null when it is decoration the shared document must not carry. */
function nodeToY(node: Node): Y.XmlElement | Y.XmlText | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return new Y.XmlText((node as Text).data);
  }
  if (node.nodeType === Node.COMMENT_NODE) {
    const carrier = new Y.XmlElement(COMMENT_TAG);
    carrier.insert(0, [new Y.XmlText((node as Comment).data)]);
    return carrier;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as Element;
  if (skipEntirely(el)) return null;

  // `localName` rather than `tagName`: it keeps SVG's camelCase intact
  // (linearGradient stays linearGradient) where tagName would shout DIV at us
  // for every HTML element.
  const out = new Y.XmlElement(el.localName);
  for (const attr of Array.from(el.attributes)) {
    if (INJECTED_ATTRS.has(attr.name)) continue;
    out.setAttribute(attr.name, attr.value);
  }
  const children = childrenToY(el);
  if (children.length > 0) out.insert(0, children);
  return out;
}

function childrenToY(parent: Node): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  for (const child of Array.from(parent.childNodes)) {
    // An unwrapped highlight contributes its CHILDREN in its place, so the text
    // it wraps survives and only the wrapper goes.
    if (child.nodeType === Node.ELEMENT_NODE && unwrapOnly(child as Element)) {
      out.push(...childrenToY(child));
      continue;
    }
    const y = nodeToY(child);
    if (y) out.push(y);
  }
  return out;
}

/**
 * Fill an empty fragment from a document body.
 *
 * Seeding is not a merge: it is how the FIRST editor turns the published bytes
 * into shared state. Seeding a fragment that already has content would
 * duplicate the document, so it refuses instead — whoever arrives second syncs
 * from the peers rather than re-reading the bytes.
 */
export function seedFragment(fragment: Y.XmlFragment, body: Element): boolean {
  if (fragment.length > 0) return false;
  const children = childrenToY(body);
  if (children.length > 0) fragment.insert(0, children);
  return true;
}

// --- CRDT -> DOM -------------------------------------------------------------

/** The namespace a child of `name` belongs to, given its parent's. */
function namespaceFor(name: string, parent: string | null): string | null {
  if (name === "svg") return SVG_NS;
  if (name === "math") return MATHML_NS;
  // foreignObject hands control back to HTML in the middle of an SVG subtree.
  if (parent === SVG_NS && name === "foreignObject") return null;
  return parent;
}

function yToNode(y: Y.XmlElement | Y.XmlText, doc: Document, ns: string | null): Node {
  if (y instanceof Y.XmlText) return doc.createTextNode(y.toString());

  const name = y.nodeName;
  if (name === COMMENT_TAG) {
    return doc.createComment(y.toArray().map((c) => c.toString()).join(""));
  }

  const childNs = namespaceFor(name, ns);
  const el = childNs ? doc.createElementNS(childNs, name) : doc.createElement(name);
  for (const [key, value] of Object.entries(y.getAttributes())) {
    if (typeof value !== "string") continue;
    if (key.startsWith("xlink:")) el.setAttributeNS(XLINK_NS, key, value);
    else el.setAttribute(key, value);
  }
  for (const child of y.toArray()) {
    el.appendChild(yToNode(child as Y.XmlElement | Y.XmlText, doc, childNs));
  }
  return el;
}

/** Render a fragment into `target`, replacing whatever is there. */
export function renderFragment(fragment: Y.XmlFragment, target: Element): void {
  const doc = target.ownerDocument;
  const next = doc.createDocumentFragment();
  for (const child of fragment.toArray()) {
    next.appendChild(yToNode(child as Y.XmlElement | Y.XmlText, doc, null));
  }
  target.replaceChildren(next);
}

/** The fragment as HTML, without touching a live document. */
export function fragmentToHtml(fragment: Y.XmlFragment, doc: Document): string {
  const host = doc.createElement("div");
  renderFragment(fragment, host);
  return host.innerHTML;
}
