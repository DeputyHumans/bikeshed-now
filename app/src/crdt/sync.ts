// SPDX-License-Identifier: Apache-2.0
// Keeping one editing host and one CRDT in step, both ways (SPEC §6b, §16).

import * as Y from "yjs";
import { seedFragment } from "./binding";
import { COMMENT_TAG } from "./binding";
import { EMPTY_ATTR, isHighlightWrapper, isOwnMarker } from "../brand/dom";

/**
 * The two directions are not symmetrical, and pretending otherwise is how a
 * binding like this eats somebody's caret.
 *
 * LOCAL -> CRDT is driven by a MutationObserver, because `execCommand` edits
 * the DOM directly and there is no other way to learn what it did. ADR 0007
 * chose execCommand precisely so the browser decides what a paragraph split
 * means; the cost is that we find out afterwards.
 *
 * CRDT -> LOCAL is driven by `observeDeep`, and it patches only the subtree
 * that changed. Re-rendering the host would be far simpler and is what most
 * naive bindings do — and it destroys the local selection on every remote
 * keystroke, which makes the feature unusable the moment two people type at
 * once. The point of this module is to not do that.
 *
 * ORIGIN is what stops the loop. Every write this module makes into the CRDT
 * carries a transaction origin, and the CRDT observer ignores its own; every
 * write it makes into the DOM is bracketed so the MutationObserver's records
 * are discarded. Without both, one keystroke ping-pongs forever.
 */

type YNode = Y.XmlElement | Y.XmlText;

export interface Sync {
  destroy(): void;
  /** Publish queued local mutations before a remote update changes their base. */
  flush(): void;
  /** The document as the CRDT currently holds it. */
  html(): string;
}

/** Decoration, which must never enter the shared document. See binding.ts. */
function isDecoration(el: Element): boolean {
  return isOwnMarker(el) || isHighlightWrapper(el);
}

// Only the host's attributes are editor overrides, and the host is outside
// the fragment. A descendant's contenteditable belongs to the author.
const INJECTED_ATTRS = new Set([EMPTY_ATTR]);

export function bindSync(
  fragment: Y.XmlFragment,
  host: Element,
  onRemote?: () => void,
  /**
   * Called after an edit typed HERE has changed the shared document: never
   * for a peer's edit applied to this host, nor for decoration, which never
   * enters it. What the editor counts as "this person changed something"
   * where the frame delivers it no `input` events (viewer/frameWatch.ts).
   */
  onLocalChange?: () => void,
): Sync {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const ORIGIN = Symbol("local");

  const domOf = new Map<YNode, Node>();
  const yOf = new WeakMap<Node, YNode>();
  let applyingRemote = false;
  type InputIntent = { node: Text; before: string; start: number; end: number; event: InputEvent };
  let inputIntent: InputIntent | null = null;

  const link = (y: YNode, node: Node) => {
    domOf.set(y, node);
    yOf.set(node, y);
  };

  // --- CRDT -> DOM -----------------------------------------------------------

  function materialise(y: YNode, ns: string | null): Node {
    if (y instanceof Y.XmlText) {
      const text = doc.createTextNode(y.toString());
      link(y, text);
      return text;
    }
    const name = y.nodeName;
    if (name === COMMENT_TAG) {
      const c = doc.createComment(y.toArray().map((x) => x.toString()).join(""));
      link(y, c);
      return c;
    }
    const childNs = name === "svg" ? "http://www.w3.org/2000/svg" : name === "foreignObject" ? null : ns;
    const el = childNs ? doc.createElementNS(childNs, name) : doc.createElement(name);
    for (const [k, v] of Object.entries(y.getAttributes())) {
      if (typeof v === "string") el.setAttribute(k, v);
    }
    for (const child of y.toArray()) el.appendChild(materialise(child as YNode, childNs));
    link(y, el);
    return el;
  }

  /** Walk an existing DOM alongside the CRDT that was just seeded from it. */
  function linkExisting(y: YNode, node: Node): void {
    link(y, node);
    if (y instanceof Y.XmlText) return;
    const children = y.toArray();
    const domKids = [...node.childNodes].filter(
      (n) => !(n.nodeType === Node.ELEMENT_NODE && isDecoration(n as Element)),
    );
    for (let i = 0; i < children.length && i < domKids.length; i += 1) {
      linkExisting(children[i] as YNode, domKids[i]);
    }
  }

  type FocusPoint = { node: Node; offset: number };
  const focusPath = (node: Node | null, offset: number): FocusPoint[] => {
    if (!node || !host.contains(node)) return [];
    const path: FocusPoint[] = [{ node, offset }];
    while (node !== host && node.parentNode) {
      const parent: ParentNode = node.parentNode;
      path.push({ node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) });
      node = parent;
    }
    return path;
  };
  const shift = (offset: number, delta: { retain?: number; delete?: number; insert?: unknown }[]): number => {
    let at = 0;
    let next = offset;
    for (const part of delta) {
      if (part.retain) at += part.retain;
      if (part.insert != null && at < offset) next += typeof part.insert === "string" || Array.isArray(part.insert) ? part.insert.length : 1;
      if (part.delete) { next -= Math.min(part.delete, Math.max(0, offset - at)); at += part.delete; }
    }
    return next;
  };

  function applyRemote(events: Y.YEvent<any>[]): void {
    const selection = doc.getSelection();
    const anchor = focusPath(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
    const focus = focusPath(selection?.focusNode ?? null, selection?.focusOffset ?? 0);
    // Text.data and replaceChildren both reset native Range offsets, even when
    // the original nodes survive. Move the captured offsets through the remote
    // delta, preserving direction and keeping a writer before a concurrent
    // insertion exactly at their caret so their word remains contiguous.
    for (const event of events) {
      const node = event.target === fragment ? host : domOf.get(event.target as YNode);
      for (const point of [...anchor, ...focus]) {
        if (point.node === node) point.offset = shift(point.offset, event.changes.delta);
      }
    }
    applyingRemote = true;
    try {
      for (const event of events) {
        const target = event.target as YNode | Y.XmlFragment;
        if (target instanceof Y.XmlText) {
          const node = domOf.get(target) as Text | undefined;
          // Replacing only `data` leaves the caret alone when it is elsewhere
          // in the document, which is the common case while somebody types.
          if (node && node.data !== target.toString()) node.data = target.toString();
          continue;
        }
        const node = target === fragment ? host : (domOf.get(target as YNode) as Element | undefined);
        if (!node) continue;
        if (event instanceof Y.YXmlEvent && event.attributesChanged.size > 0) {
          const attrs = (target as Y.XmlElement).getAttributes();
          for (const key of event.attributesChanged) {
            const value = attrs[key];
            if (typeof value === "string") (node as Element).setAttribute(key, value);
            else (node as Element).removeAttribute(key);
          }
        }
        if (event.changes.delta.length > 0) rebuildChildren(target, node as Element);
      }
    } finally {
      applyingRemote = false;
      const surviving = (path: FocusPoint[]) => path.find((p) => host.contains(p.node));
      const a = surviving(anchor);
      const f = surviving(focus);
      const limit = (p: FocusPoint) => Math.min(p.offset, p.node.nodeType === Node.TEXT_NODE ? (p.node as Text).length : p.node.childNodes.length);
      if (selection && a && f) selection.setBaseAndExtent(a.node, limit(a), f.node, limit(f));
    }
  }

  /**
   * Re-materialise one parent's children, reusing the nodes we already have.
   *
   * Reuse is what keeps a remote structural change from throwing away the
   * subtree the local caret is sitting in. Only genuinely new children are
   * built; everything else is moved.
   */
  function rebuildChildren(y: YNode | Y.XmlFragment, node: Element): void {
    const ns = node.namespaceURI === "http://www.w3.org/2000/svg" ? node.namespaceURI : null;
    const next: Node[] = [];
    for (const child of (y as Y.XmlFragment).toArray()) {
      const existing = domOf.get(child as YNode);
      next.push(existing ?? materialise(child as YNode, ns));
    }
    node.replaceChildren(...next);
  }

  // --- DOM -> CRDT -----------------------------------------------------------

  function toY(node: Node): YNode | null {
    if (node.nodeType === Node.TEXT_NODE) return new Y.XmlText((node as Text).data);
    if (node.nodeType === Node.COMMENT_NODE) {
      const c = new Y.XmlElement(COMMENT_TAG);
      c.insert(0, [new Y.XmlText((node as Comment).data)]);
      return c;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as Element;
    if (isOwnMarker(el)) return null;
    const out = new Y.XmlElement(el.localName);
    for (const a of Array.from(el.attributes)) {
      if (!INJECTED_ATTRS.has(a.name)) out.setAttribute(a.name, a.value);
    }
    const kids: YNode[] = [];
    for (const child of Array.from(el.childNodes)) {
      const y = toY(child);
      if (y) kids.push(y);
    }
    if (kids.length) out.insert(0, kids);
    return out;
  }

  /** The CRDT parent for a DOM node, and the index its children sit at. */
  function parentOf(node: Node): Y.XmlElement | Y.XmlFragment | null {
    const parent = node.parentNode;
    if (!parent) return null;
    if (parent === host) return fragment;
    return (yOf.get(parent) as Y.XmlElement | undefined) ?? null;
  }

  function indexOf(node: Node): number {
    const parent = node.parentNode;
    if (!parent) return -1;
    let i = 0;
    for (const sibling of Array.from(parent.childNodes)) {
      if (sibling === node) return i;
      if (sibling.nodeType === Node.ELEMENT_NODE && isDecoration(sibling as Element)) continue;
      i += 1;
    }
    return -1;
  }

  function onMutations(records: MutationRecord[]): void {
    if (applyingRemote) return;
    let intent = inputIntent;
    inputIntent = null;
    fragment.doc?.transact(() => {
      for (const record of records) {
        if (record.type === "characterData") {
          const y = yOf.get(record.target) as Y.XmlText | undefined;
          if (!y) continue;
          const now = (record.target as Text).data;
          const was = y.toString();
          // Equal adjacent characters do not have equal CRDT identities. Use
          // the browser's pre-edit range when its unchanged surroundings prove
          // the splice; a longest-prefix diff alone can swap a typed letter
          // with its neighbour and lose it to a concurrent deletion.
          let start = intent?.start ?? 0;
          let until = intent?.end ?? 0;
          const inputType = intent?.event.inputType ?? "";
          if (intent && start === until && inputType.startsWith("delete")) {
            const removed = Math.max(0, was.length - now.length);
            if (inputType.endsWith("Backward")) start -= removed;
            else if (inputType.endsWith("Forward")) until += removed;
          }
          let end = was.length - until;
          const intended = intent?.node === record.target && intent.before === was && !intent.event.defaultPrevented &&
            start >= 0 && until <= was.length && start <= until && now.length >= start + end &&
            now.slice(0, start) === was.slice(0, start) && now.slice(now.length - end) === was.slice(until);
          if (intent?.node === record.target) intent = null;
          if (now === was && !intended) continue;
          if (!intended) {
            // Programmatic changes and structural edits have no single text
            // range. Keep the minimal diff as their conservative fallback.
            start = 0;
            while (start < was.length && start < now.length && was[start] === now[start]) start += 1;
            end = 0;
            while (
              end < was.length - start &&
              end < now.length - start &&
              was[was.length - 1 - end] === now[now.length - 1 - end]
            ) {
              end += 1;
            }
          }
          const removed = was.length - start - end;
          if (removed > 0) y.delete(start, removed);
          const added = now.slice(start, now.length - end);
          if (added) y.insert(start, added);
          continue;
        }

        if (record.type === "attributes") {
          const el = record.target as Element;
          const y = yOf.get(el) as Y.XmlElement | undefined;
          const name = record.attributeName;
          if (!y || !name || INJECTED_ATTRS.has(name)) continue;
          const value = el.getAttribute(name);
          if (value == null) y.removeAttribute(name);
          else y.setAttribute(name, value);
          continue;
        }

        // childList.
        for (const removedNode of Array.from(record.removedNodes)) {
          const y = yOf.get(removedNode);
          if (!y) continue;
          const parent = (y.parent as Y.XmlElement | Y.XmlFragment | null) ?? null;
          if (!parent) continue;
          const at = parent.toArray().indexOf(y as never);
          if (at >= 0) parent.delete(at, 1);
          domOf.delete(y);
        }
        for (const addedNode of Array.from(record.addedNodes)) {
          if (yOf.has(addedNode)) continue;
          if (
            addedNode.nodeType === Node.ELEMENT_NODE &&
            isDecoration(addedNode as Element)
          ) {
            continue;
          }
          const parent = parentOf(addedNode);
          if (!parent) continue;
          const y = toY(addedNode);
          if (!y) continue;
          const at = Math.max(0, Math.min(indexOf(addedNode), parent.length));
          parent.insert(at, [y as never]);
          linkExisting(y, addedNode);
        }
      }
    }, ORIGIN);
  }

  // --- Start -----------------------------------------------------------------

  if (fragment.length === 0) {
    // First one in: the authored DOM becomes the shared document, and the host
    // is left exactly as it is. Re-rendering here would be a visible flicker
    // and would move the caret for no reason.
    seedFragment(fragment, host);
    const kids = fragment.toArray();
    const domKids = [...host.childNodes].filter(
      (n) => !(n.nodeType === Node.ELEMENT_NODE && isDecoration(n as Element)),
    );
    for (let i = 0; i < kids.length && i < domKids.length; i += 1) {
      linkExisting(kids[i] as YNode, domKids[i]);
    }
  } else {
    // Somebody else is already editing: their document wins over the bytes we
    // loaded, because theirs includes edits ours does not.
    applyingRemote = true;
    try {
      host.replaceChildren(
        ...fragment.toArray().map((c) => materialise(c as YNode, null)),
      );
    } finally {
      applyingRemote = false;
    }
  }

  // The HOST's own constructor, because the editing host lives in an iframe and
  // a cross-realm MutationObserver silently observes nothing. The global is the
  // fallback for a detached document, which has no defaultView at all — and
  // where the previous version of this line quietly bound nothing.
  const MO = win?.MutationObserver ?? globalThis.MutationObserver;
  const observer = MO ? new MO(onMutations) : null;
  observer?.observe(host, {
    subtree: true,
    childList: true,
    characterData: true,
    characterDataOldValue: false,
    attributes: true,
  });

  const flushLocal = () => {
    const records = observer?.takeRecords() ?? [];
    if (records.length) onMutations(records);
  };
  const beforeInput = (event: Event) => {
    flushLocal();
    inputIntent = null;
    const input = event as InputEvent;
    const ranges = input.getTargetRanges?.() ?? [];
    const selection = doc.getSelection();
    const range = ranges.length === 1 ? ranges[0] : ranges.length === 0 && selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
    if (!range || range.startContainer !== range.endContainer || range.startContainer.nodeType !== Node.TEXT_NODE || !host.contains(range.startContainer)) return;
    const node = range.startContainer as Text;
    if (!(yOf.get(node) instanceof Y.XmlText)) return;
    inputIntent = { node, before: node.data, start: range.startOffset, end: range.endOffset, event: input };
  };
  const afterInput = () => {
    flushLocal();
    inputIntent = null;
  };
  host.addEventListener("beforeinput", beforeInput);
  host.addEventListener("input", afterInput);

  const onDeep = (events: Y.YEvent<any>[], tx: Y.Transaction) => {
    if (tx.origin === ORIGIN) {
      onLocalChange?.();
      return;
    }
    // Anything the observer has queued but not delivered describes the DOM as
    // it was BEFORE this remote patch, so acting on it afterwards would replay
    // stale structure into the shared document.
    observer?.takeRecords();
    inputIntent = null;
    applyRemote(events);
    observer?.takeRecords();
    if (events.length) onRemote?.();
  };
  fragment.observeDeep(onDeep);

  return {
    flush: flushLocal,
    destroy() {
      observer?.disconnect();
      host.removeEventListener("beforeinput", beforeInput);
      host.removeEventListener("input", afterInput);
      fragment.unobserveDeep(onDeep);
      domOf.clear();
    },
    html() {
      const probe = doc.createElement("div");
      probe.append(
        ...fragment.toArray().map((c) => {
          const clone = materialise(c as YNode, null);
          return clone;
        }),
      );
      return probe.innerHTML;
    },
  };
}
