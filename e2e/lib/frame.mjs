// SPDX-License-Identifier: Apache-2.0
// Document-frame geometry, text and Range helpers for driving the viewer's iframe with a real mouse (SPEC §6a).

/**
 * The document lives in `iframe.doc-frame`, which the viewer may SCALE with a
 * CSS transform (a deck fitted into the script-free edit frame, SPEC §6d), and
 * the transform can sit on the iframe or on any ancestor. So a point measured
 * inside the frame (its own viewport, CSS px) maps to the page as
 *
 *   page = rect.origin + (border + padding + inner) × scale
 *
 * where `rect` is the iframe's transformed border box from
 * getBoundingClientRect, and `scale = rect.width / offsetWidth` — the ratio of
 * the painted box to the layout box, which is right whichever element carries
 * the transform. getComputedStyle(iframe).transform alone says "none" when an
 * ancestor does the scaling, and is reported only for evidence.
 *
 * Everything that reads the frame's document goes through the Playwright Frame,
 * which evaluates even in a frame whose sandbox has no allow-scripts. Nothing
 * here writes to the document's DOM, except setSelection, setSelectionBetween
 * and placeCaret, which change only the selection — never a node or an
 * attribute.
 *
 * THE APP'S OWN NODES. The viewer puts nodes of its own into the document it
 * shows (a peer overlay naming the other readers, injected stylesheets), each
 * marked `data-bshd="<value>"` (app/src/brand/dom.ts). They are in the body by
 * design and change as readers come and go, so a text comparison between
 * readers leaves them out: `frameText(frame, {withoutOwn: true})`. By VALUE,
 * from the pinned KNOWN_OWN_VALUES (bytes.mjs), never by the attribute's
 * presence: a document may carry `data-bshd="whatever"` of its own, and that
 * text is the author's.
 *
 * ARRIVAL PROBES. `armArrival(page, id, text)` records, in the page, the
 * moment `text` is first inside the frame's element `#id`, or, with `id`
 * null, ANYWHERE in the frame's body (its textContent includes it): a
 * doubled body (S1, S27) has two elements with one id, getElementById finds
 * only the first, and text typed into the second copy is on the screen
 * without ever being in "#id". `arrival(page,
 * text)` reads it and `waitForArrival(page, text)` waits for it. They run in
 * the TOP page (the app's own realm) and reach into the frame's document: the
 * edit frame runs no script, and an observer installed by evaluating inside
 * such a frame (Playwright's frame.evaluate) is never called, while one
 * installed from the top page is (measured, and pinned in
 * selftest/frame-arrival.test.mjs). The observer is the frame document's own
 * MutationObserver, so it ends with that document. It looks after every
 * change, in the microtask checkpoint that follows it, so the time is when the
 * text was in the DOM, before any render, never when a poll happened to look.
 * The time is the page's `Date.now()`: on one machine, comparable with another
 * page's and with this process's `Date.now()`. The probes live in the top page
 * under a Symbol (no node, no attribute, no string-keyed global): a
 * navigation of the page drops every probe, and a replaced frame document (a
 * remount, a reload) is reported as `reloaded`, because the probe watched the
 * old one.
 *
 * A PROBE FROM THE PARENT'S REALM. `inFrameDoc(page, fn, arg)` runs a spec's
 * own `fn(doc, arg)` in the TOP page with the frame's Document as `doc`, as
 * the app's editor reaches it, rather than inside the frame (frame.evaluate).
 * Nothing then depends on the frame being allowed to run script, a listener
 * or observer it installs is called (one installed inside a scriptless frame
 * is not), and the language built-ins it uses (Array, JSON, Object) are the
 * app's, never ones a trusted document's own script replaced. DOM methods
 * are still looked up on the frame's own prototypes. The same function runs
 * on stored bytes with bytes.mjs `parseAndRun`.
 */

import { createHash } from "node:crypto";
import { KNOWN_OWN_VALUES, probeArg, probeSource } from "./bytes.mjs";

export const DOC_FRAME = "iframe.doc-frame";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The Playwright Frame for the document iframe, or null while there is none. */
export async function docFrame(page, selector = DOC_FRAME) {
  const handle = await page.$(selector);
  if (!handle) return null;
  const frame = await handle.contentFrame();
  await handle.dispose();
  return frame;
}

/** Geometry of the iframe as painted: origin of its content box and its scale. */
export async function frameGeometry(page, selector = DOC_FRAME) {
  const g = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const scaleX = el.offsetWidth ? r.width / el.offsetWidth : 1;
    const scaleY = el.offsetHeight ? r.height / el.offsetHeight : 1;
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    return {
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      layout: { width: el.offsetWidth, height: el.offsetHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight },
      border: { left: el.clientLeft, top: el.clientTop },
      padding: { left: padLeft, top: padTop },
      scaleX,
      scaleY,
      transform: cs.transform,
      src: el.getAttribute("src"),
      sandbox: el.getAttribute("sandbox"),
    };
  }, selector);
  if (!g) throw new Error(`no ${selector} on the page`);
  return g;
}

/** Map a point in the frame's own viewport (CSS px) to page coordinates for page.mouse. */
export function framePointToPage(geom, point) {
  return {
    x: geom.rect.x + (geom.border.left + geom.padding.left + point.x) * geom.scaleX,
    y: geom.rect.y + (geom.border.top + geom.padding.top + point.y) * geom.scaleY,
  };
}

/** Is a page point inside the iframe's painted box (so a click there lands in the frame)? */
export function insideFrame(geom, p) {
  return p.x > geom.rect.x && p.y > geom.rect.y && p.x < geom.rect.x + geom.rect.width && p.y < geom.rect.y + geom.rect.height;
}

/** The frame body's textContent, innerText and innerHTML in one read. */
export async function frameSnapshot(frame) {
  return frame.evaluate(() => {
    const body = document.body;
    return {
      url: location.href,
      readyState: document.readyState,
      textContent: body ? body.textContent : null,
      innerText: body ? body.innerText : null,
      innerHTML: body ? body.innerHTML : null,
      bodyAttrs: body ? Object.fromEntries(body.getAttributeNames().map((n) => [n, body.getAttribute(n)])) : null,
    };
  });
}

/**
 * The frame body's textContent (or, with `selector`, that element's).
 *
 * `withoutOwn: true` leaves out every text node inside an element whose
 * `data-bshd` VALUE is one of KNOWN_OWN_VALUES (the peer overlay, the injected
 * stylesheets); a list of values instead of `true` names them yourself. A node
 * whose `data-bshd` is any other value is the document's own and is kept, and
 * so is the text inside highlight wrappers, which the app unwraps rather than
 * removes. Read in place: nothing is cloned, moved or removed. With no option
 * this is exactly `body.textContent`, as it always was. A `selector` that
 * matches nothing throws.
 */
export async function frameText(frame, { withoutOwn = false, selector = null } = {}) {
  if (!withoutOwn && selector == null) return frame.evaluate(() => document.body?.textContent ?? "");
  let own = [];
  if (withoutOwn === true) own = [...KNOWN_OWN_VALUES];
  else if (Array.isArray(withoutOwn)) own = [...withoutOwn];
  else if (withoutOwn) throw new Error(`frameText: withoutOwn is true or a list of data-bshd values, got ${JSON.stringify(withoutOwn)}`);
  if (own.some((v) => typeof v !== "string" || v === "")) throw new Error(`frameText: data-bshd values are non-empty strings, got ${JSON.stringify(own)}`);
  const r = await frame.evaluate(
    ({ own, selector }) => {
      const root = selector == null ? document.body : document.querySelector(selector);
      if (!root) return selector == null ? { text: "" } : { error: `no element ${selector}` };
      if (own.length === 0) return { text: root.textContent };
      const values = new Set(own);
      const verdicts = new Map();
      // Inside one of the app's own nodes? By the attribute's VALUE, up to the document.
      const ours = (el) => {
        if (!el) return false;
        if (verdicts.has(el)) return verdicts.get(el);
        const v = el.getAttribute("data-bshd");
        const yes = (v != null && values.has(v)) || ours(el.parentElement);
        verdicts.set(el, yes);
        return yes;
      };
      // textContent's own definition: every Text (and CDATA) descendant, in order.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION);
      let text = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!ours(n.parentElement)) text += n.data;
      return { text };
    },
    { own, selector },
  );
  if (r.error) throw new Error(r.error);
  return r.text;
}

/** sha256 of the frame body's innerHTML — the I1 convergence oracle. */
export async function bodyHash(frame) {
  const html = await frame.evaluate(() => document.body?.innerHTML ?? "");
  return { hash: sha256(html), length: html.length };
}

/** Authored reader DOM: remove only independently pinned owned marker values. */
export function readerBodyInPage(own) {
  const body = document.body;
  if (!body) return "";
  const clone = body.cloneNode(true);
  const values = new Set(own);
  for (const el of [...clone.querySelectorAll("[data-bshd]")]) if (values.has(el.getAttribute("data-bshd"))) el.remove();
  return clone.innerHTML;
}

/** Idle readers differ in presence paint; compare their authored body only. */
export async function readerBodyHash(frame) {
  const html = await frame.evaluate(readerBodyInPage, [...KNOWN_OWN_VALUES]);
  return { hash: sha256(html), length: html.length };
}

/** Attributes on the frame's <body>, as {name: value}. */
export async function bodyAttributes(frame) {
  return frame.evaluate(() => {
    const b = document.body;
    return b ? Object.fromEntries(b.getAttributeNames().map((n) => [n, b.getAttribute(n)])) : null;
  });
}

/**
 * CSS selector for an id, safe for ids starting with a digit — `#1` is not a
 * valid selector, `[id="1"]` is.
 */
export function idSelector(id) {
  return `[id="${String(id).replace(/["\\]/g, "\\$&")}"]`;
}

/**
 * Locate `exact` inside the element matching `selector` (its Nth occurrence in
 * the element's text) and return the client rects of that text — in the
 * frame's viewport — plus the rect of its first and last character.
 * Scrolls the element into view first, so the rects are on screen.
 */
export async function rangeRects(frame, selector, exact, { occurrence = 0, scroll = true } = {}) {
  return frame.evaluate(
    ({ selector, exact, occurrence, scroll }) => {
      const el = document.querySelector(selector);
      if (!el) return { error: `no element ${selector}` };
      if (scroll) el.scrollIntoView({ block: "center", inline: "nearest" });
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let all = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n, start: all.length });
        all += n.data;
      }
      let at = -1;
      for (let i = 0, from = 0; i <= occurrence; i += 1) {
        at = all.indexOf(exact, from);
        if (at < 0) break;
        from = at + 1;
      }
      if (at < 0) return { error: `"${exact}" not found in ${selector} (text: ${JSON.stringify(all.slice(0, 200))})` };
      const locate = (offset, preferEnd) => {
        for (let i = 0; i < nodes.length; i += 1) {
          const { node, start } = nodes[i];
          const end = start + node.data.length;
          if (offset < end || (preferEnd && offset === end)) return { node, offset: offset - start };
        }
        const last = nodes[nodes.length - 1];
        return { node: last.node, offset: last.node.data.length };
      };
      const s = locate(at, false);
      const e = locate(at + exact.length, true);
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      const charRect = (pos) => {
        const p = locate(pos, false);
        const r = document.createRange();
        r.setStart(p.node, p.offset);
        r.setEnd(p.node, Math.min(p.offset + 1, p.node.data.length));
        const b = r.getClientRects()[0] ?? r.getBoundingClientRect();
        return { x: b.left, y: b.top, width: b.width, height: b.height };
      };
      const rects = Array.from(range.getClientRects()).map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height }));
      return {
        text: range.toString(),
        rects,
        first: charRect(at),
        last: charRect(at + exact.length - 1),
        viewport: { width: innerWidth, height: innerHeight },
      };
    },
    { selector, exact, occurrence, scroll },
  );
}

/** Set the frame's selection to `exact` inside `selector` (no mouse). Returns the selected text. */
export async function setSelection(frame, selector, exact, { occurrence = 0 } = {}) {
  return frame.evaluate(
    ({ selector, exact, occurrence }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no element ${selector}`);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let all = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n, start: all.length });
        all += n.data;
      }
      let at = -1;
      for (let i = 0, from = 0; i <= occurrence; i += 1) {
        at = all.indexOf(exact, from);
        if (at < 0) break;
        from = at + 1;
      }
      if (at < 0) throw new Error(`"${exact}" not in ${selector}`);
      const locate = (offset, preferEnd) => {
        for (const { node, start } of nodes) {
          const end = start + node.data.length;
          if (offset < end || (preferEnd && offset === end)) return [node, offset - start];
        }
        const last = nodes[nodes.length - 1].node;
        return [last, last.data.length];
      };
      const range = document.createRange();
      range.setStart(...locate(at, false));
      range.setEnd(...locate(at + exact.length, true));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    },
    { selector, exact, occurrence },
  );
}

/**
 * Runs in the frame. The Range from the first character of `from.exact`
 * (its `from.occurrence`th occurrence in `from.sel`'s text) to the last
 * character of `to.exact` in `to.sel`, located as setSelection locates one.
 * `apply` makes it the selection; otherwise the current selection is compared
 * with it. Self-contained: Playwright sends its source.
 */
function rangeBetweenInFrame({ from, to, apply }) {
  const find = (end, which) => {
    const el = document.querySelector(end.sel);
    if (!el) return { error: `no element ${end.sel}` };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let all = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: all.length });
      all += n.data;
    }
    let at = -1;
    for (let i = 0, f = 0; i <= (end.occurrence ?? 0); i += 1) {
      at = all.indexOf(end.exact, f);
      if (at < 0) break;
      f = at + 1;
    }
    if (at < 0) return { error: `"${end.exact}" not found in ${end.sel} (text: ${JSON.stringify(all.slice(0, 200))})` };
    const offset = which === "start" ? at : at + end.exact.length;
    for (const { node, start } of nodes) {
      const stop = start + node.data.length;
      if (offset < stop || (which === "end" && offset === stop)) return { el, node, offset: offset - start };
    }
    const last = nodes[nodes.length - 1].node;
    return { el, node: last, offset: last.data.length };
  };
  const s = find(from, "start");
  if (s.error) return { error: s.error };
  const e = find(to, "end");
  if (e.error) return { error: e.error };
  const want = document.createRange();
  want.setStart(s.node, s.offset);
  if (want.comparePoint(e.node, e.offset) < 0) return { error: `"${to.exact}" in ${to.sel} comes before "${from.exact}" in ${from.sel}` };
  want.setEnd(e.node, e.offset);
  const sel = getSelection();
  if (apply) {
    sel.removeAllRanges();
    sel.addRange(want);
    return { want: want.toString(), text: sel.rangeCount ? sel.getRangeAt(0).toString() : "" };
  }
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { want: want.toString(), text: "", startIn: false, endIn: false, ok: false };
  const r = sel.getRangeAt(0);
  const startIn = s.el.contains(r.startContainer);
  const endIn = e.el.contains(r.endContainer);
  const text = r.toString();
  return { want: want.toString(), text, startIn, endIn, ok: startIn && endIn && text.trim() === want.toString().trim() };
}

function checkEnd(name, end) {
  if (!end || typeof end.sel !== "string" || typeof end.exact !== "string" || end.exact === "") {
    throw new Error(`${name}: want {sel, exact, occurrence?} with a non-empty exact, got ${JSON.stringify(end)}`);
  }
  if (end.occurrence != null && !(Number.isInteger(end.occurrence) && end.occurrence >= 0)) {
    throw new Error(`${name}: occurrence is a whole number, got ${JSON.stringify(end.occurrence)}`);
  }
  return { sel: end.sel, exact: end.exact, occurrence: end.occurrence ?? 0 };
}

/**
 * Set the frame's selection (no mouse) from the first character of
 * `from.exact` inside `from.sel` to the last of `to.exact` inside `to.sel`,
 * across whatever lies between: paragraphs, a <br>, a list, a table. Each end
 * is `{sel, exact, occurrence = 0}`. Returns the Range's text
 * (Range.toString(), the raw text anchors are measured against; the
 * Selection's own toString() is the rendered text instead). Throws when an
 * end is not found or `to` comes before `from`.
 */
export async function setSelectionBetween(frame, from, to) {
  const r = await frame.evaluate(rangeBetweenInFrame, { from: checkEnd("from", from), to: checkEnd("to", to), apply: true });
  if (r.error) throw new Error(r.error);
  return r.text;
}

/**
 * Does the frame's current selection run from `from` to `to` (as
 * setSelectionBetween would set it)? `{ok, text, want, startIn, endIn}`:
 * `text` is the current Range's text, `want` the text the ends name, and `ok`
 * needs the Range to start inside `from.sel`, end inside `to.sel` and hold
 * `want` (both trimmed). Throws when an end is not found.
 */
export async function selectionBetween(frame, from, to) {
  const r = await frame.evaluate(rangeBetweenInFrame, { from: checkEnd("from", from), to: checkEnd("to", to), apply: false });
  if (r.error) throw new Error(r.error);
  return r;
}

/** The frame's current selection text. */
export async function selectionText(frame) {
  return frame.evaluate(() => getSelection()?.toString() ?? "");
}

/**
 * Collapse the frame's selection at the start or end of the element's text
 * (or at a character offset into it). Only the selection moves.
 */
export async function placeCaret(frame, selector, at = "end") {
  return frame.evaluate(
    ({ selector, at }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no element ${selector}`);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const texts = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
      const range = document.createRange();
      if (texts.length === 0) {
        range.selectNodeContents(el);
        range.collapse(at !== "end");
      } else if (at === "start") {
        range.setStart(texts[0], 0);
        range.collapse(true);
      } else if (at === "end") {
        const last = texts[texts.length - 1];
        range.setStart(last, last.data.length);
        range.collapse(true);
      } else {
        let left = Number(at);
        let placed = false;
        for (const t of texts) {
          if (left <= t.data.length) {
            range.setStart(t, left);
            placed = true;
            break;
          }
          left -= t.data.length;
        }
        if (!placed) {
          const last = texts[texts.length - 1];
          range.setStart(last, last.data.length);
        }
        range.collapse(true);
      }
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return { collapsed: sel.isCollapsed, focusOffset: sel.focusOffset };
    },
    { selector, at },
  );
}

/**
 * A point inside the element, in the frame's viewport: the middle of its last
 * line's end (`end`), its first line's start (`start`) or its centre.
 * Scrolls it into view first.
 */
export async function elementPoint(frame, selector, where = "end") {
  const p = await frame.evaluate(
    ({ selector, where }) => {
      const el = document.querySelector(selector);
      if (!el) return { error: `no element ${selector}` };
      // A long collaborative paragraph can be taller than the frame. Centering
      // that element hides both text boundaries; align the boundary we will
      // actually click, without changing selection or any document content.
      const oversized = el.getBoundingClientRect().height > innerHeight;
      el.scrollIntoView({ block: oversized && (where === "start" || where === "end") ? where : "center", inline: "nearest" });
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      const box = el.getBoundingClientRect();
      if (where === "center" || rects.length === 0) return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      if (where === "start") return { x: rects[0].left + 1, y: rects[0].top + rects[0].height / 2 };
      const last = rects[rects.length - 1];
      return { x: Math.max(last.left + 1, last.right - 1), y: last.top + last.height / 2 };
    },
    { selector, where },
  );
  if (p.error) throw new Error(p.error);
  return p;
}

/** Where the arrival probes live in the top page: `window[Symbol.for(ARRIVAL_KEY)]`, a Map from text to probe. */
export const ARRIVAL_KEY = "bikeshed-e2e.arrivals";

/** A Page, or anything with one (a User). */
const pageOf = (p) => (p && typeof p.evaluate !== "function" && p.page && typeof p.page.evaluate === "function" ? p.page : p);

function checkArrivalArgs(name, id, text) {
  if (id !== undefined && (typeof id !== "string" || id === "")) throw new Error(`${name}: id is an element id (a non-empty string), got ${JSON.stringify(id)}`);
  if (typeof text !== "string" || text === "") throw new Error(`${name}: text is a non-empty string, got ${JSON.stringify(text)}`);
}

/** Where a probe looks, in words: `in #<id>`, or anywhere in the body for an id-less probe. */
const probePlace = (id) => (id === null ? "anywhere in the frame's body" : `in #${id}`);

/** Runs in the top page. Arms (or re-arms) the probe for `text` on the frame's current document; `id` null looks anywhere in its body. */
function armInPage({ sel, id, text, key }) {
  const el = document.querySelector(sel);
  if (!el) return { error: `no ${sel} on the page` };
  let d = null;
  try {
    d = el.contentDocument;
  } catch {
    d = null;
  }
  if (!d || !d.documentElement) return { error: `${sel} has no document this page can reach (not loaded yet, or sandboxed without allow-same-origin)` };
  const store = (window[Symbol.for(key)] ??= new Map());
  store.get(text)?.observer?.disconnect();
  // Anywhere: the body read at each check (a body replaced whole is the new one), all of its text, every copy.
  const has = id === null ? () => (d.body?.textContent ?? "").includes(text) : () => d.getElementById(id)?.textContent.includes(text) === true;
  const rec = { id, at: null, armedAt: Date.now(), already: false, doc: d, observer: null };
  if (has()) {
    rec.at = rec.armedAt;
    rec.already = true;
  } else {
    const Observer = d.defaultView?.MutationObserver ?? MutationObserver;
    rec.observer = new Observer(() => {
      if (rec.at !== null || !has()) return;
      rec.at = Date.now();
      rec.observer.disconnect();
    });
    rec.observer.observe(d, { childList: true, subtree: true, characterData: true });
  }
  store.set(text, rec);
  return { armedAt: rec.armedAt, already: rec.already };
}

/** Runs in the top page. The probe for `text`, as plain data. */
function arrivalInPage({ sel, text, key }) {
  const rec = window[Symbol.for(key)]?.get(text);
  if (!rec) return { armed: false, id: null, at: null, armedAt: null, already: false, reloaded: false };
  let d = null;
  try {
    d = document.querySelector(sel)?.contentDocument ?? null;
  } catch {
    d = null;
  }
  return { armed: true, id: rec.id, at: rec.at, armedAt: rec.armedAt, already: rec.already, reloaded: rec.doc !== d };
}

/**
 * Arm a probe for the moment `text` is first inside the frame's element
 * `#id` (its textContent includes it), on the frame's CURRENT document (see
 * ARRIVAL PROBES in the header). `id` null arms it ANYWHERE in the frame's
 * body instead: the body's textContent (every element, every copy of a
 * doubled body; the body read afresh at each check, so one that replaced the
 * old is watched) includes it. That is one text of the whole body, so an
 * element boundary does not separate (a token whose halves end one paragraph
 * and start the next has arrived); a typed token is contiguous. It costs one
 * read of the body's text per batch of mutations. Timed exactly as an id's
 * probe. `page` is a Page or a User; `frame` the
 * iframe's selector. Resolves `{armedAt, already}` (the page's Date.now();
 * `already`: the text was there when armed, and then `at` is `armedAt`).
 * One probe per text per page: arming the same text again replaces it. Throws
 * when there is no frame, or its document is out of the page's reach, or
 * `id` is neither a non-empty string nor null (undefined included). Arm it
 * BEFORE the action that brings the text.
 */
export async function armArrival(page, id, text, { frame = DOC_FRAME } = {}) {
  if (id !== null && (typeof id !== "string" || id === "")) throw new Error(`armArrival: id is an element id (a non-empty string), or null for anywhere in the frame's body, got ${id === undefined ? "undefined" : JSON.stringify(id)}`);
  checkArrivalArgs("armArrival", undefined, text);
  const r = await pageOf(page).evaluate(armInPage, { sel: frame, id, text, key: ARRIVAL_KEY });
  if (r.error) throw new Error(`armArrival: ${r.error}`);
  return r;
}

/**
 * The probe for `text`: `{armed, id, at, armedAt, already, reloaded}`. `at`
 * is when the text arrived (the page's Date.now()), null until then;
 * `armed: false` when this page has no probe for it (never armed, or the page
 * navigated since); `reloaded` when the frame's document is no longer the one
 * the probe watched, so an `at` still null will never be set. `id` is the
 * element's id, or null for a probe armed anywhere in the body (`armed:
 * true`) and for no probe (`armed: false`); the keys are the same either way.
 */
export async function arrival(page, text, { frame = DOC_FRAME } = {}) {
  checkArrivalArgs("arrival", undefined, text);
  return pageOf(page).evaluate(arrivalInPage, { sel: frame, text, key: ARRIVAL_KEY });
}

function arrivalError(reason, message, probe) {
  const err = new Error(message);
  err.code = "E2E_ARRIVAL";
  err.reason = reason;
  err.arrival = probe;
  return err;
}

/**
 * Wait until `text` has arrived, and resolve the probe (as `arrival` gives
 * it; `reloaded` may be true when it arrived before the frame was replaced).
 * Throws `E2E_ARRIVAL` with `reason`: "unarmed" (no probe in this page),
 * "reloaded" (the frame was replaced before the text came), "timeout"; the
 * message names the place (`in #<id>`, or `anywhere in the frame's body`).
 * Polling here only reads the probe; the time was taken in the page.
 */
export async function waitForArrival(page, text, { timeout = 15_000, interval = 50, frame = DOC_FRAME } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const a = await arrival(page, text, { frame });
    if (!a.armed) throw arrivalError("unarmed", `no arrival probe for ${JSON.stringify(text)} in this page: arm it with armArrival first (a navigation of the page drops every probe)`, a);
    if (a.at !== null) return a;
    if (a.reloaded) throw arrivalError("reloaded", `the document frame was replaced before ${JSON.stringify(text)} arrived ${probePlace(a.id)}: the probe watched the old document, arm it again`, a);
    if (Date.now() >= deadline) throw arrivalError("timeout", `${JSON.stringify(text)} did not arrive ${probePlace(a.id)} within ${timeout} ms`, a);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Does the frame's document have focus, and where is its caret? */
export async function focusState(frame) {
  return frame.evaluate(() => {
    const sel = getSelection();
    return {
      hasFocus: document.hasFocus(),
      active: document.activeElement?.tagName ?? null,
      anchor: sel?.anchorNode ? (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement?.id || sel.anchorNode.parentElement?.tagName : sel.anchorNode.id || sel.anchorNode.nodeName) : null,
      collapsed: sel?.isCollapsed ?? null,
    };
  });
}

/**
 * Runs in the top page, sent as source with the probe (see inFrameDoc): the
 * probe on the frame's CURRENT Document, reached as the app reaches it.
 */
async function frameDocRunner(cfg, fn, arg) {
  const el = document.querySelector(cfg.sel);
  if (!el) return { error: `no ${cfg.sel} on the page` };
  let d = null;
  try {
    d = el.contentDocument;
  } catch {
    d = null;
  }
  if (!d || !d.documentElement) return { error: `${cfg.sel} has no document this page can reach (not loaded yet, or sandboxed without allow-same-origin)` };
  try {
    const value = await fn(d, arg);
    if (value && typeof value === "object" && typeof value.nodeType === "number" && typeof value.nodeName === "string") {
      return { error: "the probe returned a DOM node: return plain data" };
    }
    return { value };
  } catch (e) {
    return { error: `the probe threw: ${String(e?.message ?? e)}` };
  }
}

/**
 * Run `fn(doc, arg)` with the document frame's CURRENT Document as `doc`,
 * from the TOP page's realm (see A PROBE FROM THE PARENT'S REALM in the
 * header), and resolve its return value, which must be plain data (JSON, as
 * Playwright returns it). `fn` may be async; it is sent as source, so it may
 * use nothing from the spec's scope but `arg` (JSON). `page` is a Page or a
 * User; `frame` the iframe's selector.
 *
 * The frame's document must be reachable from the page: same origin, or a
 * sandbox with `allow-same-origin` (the edit frame; a trusted document's
 * unsandboxed frame). Wait for the document first (User.waitForFrame): a
 * frame still loading is its initial empty document. Throws "inFrameDoc: …"
 * when there is no frame, its document is out of reach, the probe throws, or
 * it returns a DOM node. bytes.mjs `parseAndRun(parser, html, fn, arg)` runs
 * the same function on stored bytes.
 */
export async function inFrameDoc(page, fn, arg = null, { frame = DOC_FRAME } = {}) {
  if (typeof frame !== "string" || frame.trim() === "") throw new Error(`inFrameDoc: frame is the iframe's selector, got ${JSON.stringify(frame)}`);
  const src = probeSource(fn, "inFrameDoc: fn");
  const argJson = probeArg(arg, "inFrameDoc");
  const p = pageOf(page);
  if (!p || typeof p.evaluate !== "function") throw new Error("inFrameDoc: page is a Playwright Page or a User");
  const r = await p.evaluate(`(${frameDocRunner.toString()})(${JSON.stringify({ sel: frame })}, ${src}, ${argJson})`);
  if (!r || r.error) throw new Error(`inFrameDoc: ${r?.error ?? "the page returned nothing"}`);
  return r.value;
}
