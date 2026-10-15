// SPDX-License-Identifier: Apache-2.0
// Two editing hosts, one document, typing at the same time (SPEC §6b).

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { bindSync } from "./sync";
import { HL_CLASS, OWN_ATTR } from "../brand/dom";

/**
 * A peer is a DOM host plus its own Y.Doc, wired to the others by hand. The
 * transport is tested in log.test.ts; what is under test here is the BINDING —
 * that a change made in one host reaches the other's DOM, and that neither
 * one's own change comes back to it as a remote patch.
 */
function peer(html: string, syncFrom?: Y.Doc) {
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = html;
  const y = new Y.Doc();
  // A peer arriving second syncs BEFORE it binds. That ordering is the whole
  // protocol: bindSync seeds only an empty fragment, so whoever has already
  // received the shared document adopts it instead of publishing a second copy
  // of the bytes they happened to load.
  if (syncFrom) Y.applyUpdate(y, Y.encodeStateAsUpdate(syncFrom));
  const sync = bindSync(y.getXmlFragment("body"), doc.body);
  return { doc, y, sync, body: doc.body };
}

/** Deliver every pending update in both directions until they agree. */
function exchange(...peers: { y: Y.Doc }[]) {
  for (const from of peers) {
    const update = Y.encodeStateAsUpdate(from.y);
    for (const to of peers) if (to !== from) Y.applyUpdate(to.y, update);
  }
}

/** MutationObserver is async; flush it. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("local edits reach the CRDT", () => {
  it("records typing into a text node", async () => {
    const a = peer(`<p>hello</p>`);
    a.body.querySelector("p")!.firstChild!.nodeValue = "hello world";
    await flush();
    expect(a.sync.html()).toBe(`<p>hello world</p>`);
  });

  it("records a new element", async () => {
    const a = peer(`<p>one</p>`);
    a.body.appendChild(Object.assign(a.doc.createElement("p"), { textContent: "two" }));
    await flush();
    expect(a.sync.html()).toBe(`<p>one</p><p>two</p>`);
  });

  it("records a removal", async () => {
    const a = peer(`<p>one</p><p>two</p>`);
    a.body.querySelector("p")!.remove();
    await flush();
    expect(a.sync.html()).toBe(`<p>two</p>`);
  });

  it("records an attribute change", async () => {
    const a = peer(`<p id="x">t</p>`);
    a.body.querySelector("p")!.setAttribute("id", "y");
    await flush();
    expect(a.sync.html()).toBe(`<p id="y">t</p>`);
  });

  it("ignores the editing host's own attributes", async () => {
    const a = peer(`<p>t</p>`);
    a.body.setAttribute("contenteditable", "true");
    a.body.setAttribute("spellcheck", "true");
    await flush();
    expect(a.sync.html()).toBe(`<p>t</p>`);
  });

  it("replicates authored descendant editing attributes on existing and inserted elements", async () => {
    const a = peer(`<p>t</p>`);
    a.body.querySelector("p")!.setAttribute("contenteditable", "false");
    a.body.querySelector("p")!.setAttribute("spellcheck", "false");
    const inserted = a.doc.createElement("div");
    inserted.setAttribute("contenteditable", "plaintext-only");
    inserted.textContent = "new";
    a.body.appendChild(inserted);
    await flush();
    expect(a.sync.html()).toBe(`<p contenteditable="false" spellcheck="false">t</p><div contenteditable="plaintext-only">new</div>`);
  });

  it("never lets a highlight into the shared document", async () => {
    // The fourth contaminant path: a highlight reaching the CRDT arrives in
    // EVERY peer's copy and is then indistinguishable from the author's markup.
    const a = peer(`<p>t</p>`);
    const mark = a.doc.createElement("mark");
    mark.className = HL_CLASS;
    mark.textContent = "x";
    a.body.querySelector("p")!.appendChild(mark);
    const style = a.doc.createElement("style");
    style.setAttribute(OWN_ATTR, "hl-style");
    a.body.appendChild(style);
    await flush();
    expect(a.sync.html()).toBe(`<p>t</p>`);
  });

  it("never lets a highlight inside SVG text into the shared document either", async () => {
    // Inside <text> the wrapper is a <tspan>, and a tagName check written for
    // <mark> would wave it through.
    const a = peer(`<svg><text>t</text></svg>`);
    const tspan = a.doc.createElementNS("http://www.w3.org/2000/svg", "tspan");
    tspan.setAttribute("class", HL_CLASS);
    tspan.textContent = "x";
    a.body.querySelector("text")!.appendChild(tspan);
    await flush();
    expect(a.sync.html()).toBe(`<svg><text>t</text></svg>`);
  });
});

describe("remote edits reach the DOM", () => {
  it("delivers a peer's typing", async () => {
    const a = peer(`<p>hello</p>`);
    const b = peer(``);
    exchange(a, b);
    await flush();
    expect(b.body.innerHTML).toBe(`<p>hello</p>`);

    a.body.querySelector("p")!.firstChild!.nodeValue = "hello there";
    await flush();
    exchange(a, b);
    await flush();
    expect(b.body.innerHTML).toBe(`<p>hello there</p>`);
  });

  it("delivers a peer's new paragraph", async () => {
    const a = peer(`<p>one</p>`);
    const b = peer(``);
    exchange(a, b);
    await flush();
    a.body.appendChild(Object.assign(a.doc.createElement("p"), { textContent: "two" }));
    await flush();
    exchange(a, b);
    await flush();
    expect(b.body.innerHTML).toBe(`<p>one</p><p>two</p>`);
  });

  it("does NOT echo a remote patch back as a local change", async () => {
    // If the observer's records from applying a remote patch were treated as
    // local edits, every keystroke would ping-pong between peers forever.
    const a = peer(`<p>x</p>`);
    const b = peer(``);
    exchange(a, b);
    await flush();
    const before = Y.encodeStateVector(b.y);
    a.body.querySelector("p")!.firstChild!.nodeValue = "xy";
    await flush();
    exchange(a, b);
    await flush();
    const afterFirst = Y.encodeStateVector(b.y);
    // Settling again must produce nothing new: B contributed no updates of
    // its own for a change it only received.
    exchange(a, b);
    await flush();
    expect([...Y.encodeStateVector(b.y)]).toEqual([...afterFirst]);
    expect([...afterFirst]).not.toEqual([...before]);
  });
});

describe("simultaneous typing", () => {
  it("keeps both people's words in the same paragraph", async () => {
    const a = peer(`<p id="p">The fox.</p>`);
    const b = peer(``);
    exchange(a, b);
    await flush();

    // Neither has seen the other yet: this is the concurrent case.
    a.body.querySelector("p")!.firstChild!.nodeValue = "The quick fox.";
    b.body.querySelector("p")!.firstChild!.nodeValue = "The fox. Jumped.";
    await flush();
    exchange(a, b);
    await flush();

    expect(a.body.innerHTML).toBe(b.body.innerHTML);
    expect(a.body.textContent).toContain("quick");
    expect(a.body.textContent).toContain("Jumped");
  });

  it("converges when one types and the other deletes the paragraph", async () => {
    const a = peer(`<p id="a">one</p><p id="b">two</p>`);
    const b = peer(``);
    exchange(a, b);
    await flush();

    a.body.querySelector("#b")!.remove();
    b.body.querySelector("#b")!.firstChild!.nodeValue = "two edited";
    await flush();
    exchange(a, b);
    await flush();
    exchange(a, b);
    await flush();

    expect(a.body.innerHTML).toBe(b.body.innerHTML);
  });

  it("leaves the local selection alone when the change is elsewhere", async () => {
    // The whole reason this patches subtrees instead of re-rendering: a peer
    // typing in another paragraph must not move your caret.
    const a = peer(`<p id="mine">mine</p><p id="theirs">theirs</p>`);
    const b = peer(``);
    exchange(a, b);
    await flush();

    const caretHost = a.body.querySelector("#mine")!.firstChild as Text;
    b.body.querySelector("#theirs")!.firstChild!.nodeValue = "theirs edited";
    await flush();
    exchange(a, b);
    await flush();

    // The node the caret would be in is the SAME object, not a replacement.
    expect(a.body.querySelector("#mine")!.firstChild).toBe(caretHost);
    expect(a.body.querySelector("#theirs")!.textContent).toBe("theirs edited");
  });
});

describe("the two guards that are easy to think are load-bearing and are not", () => {
  it("a local change writes to the CRDT and NOT back into the DOM", async () => {
    // The origin check. Without it, applying our own transaction re-enters the
    // remote path, which rebuilds children and calls takeRecords() — discarding
    // local mutations that have not been delivered yet. Counting DOM writes is
    // the only way to see it: the document ends up correct either way.
    const a = peer(`<p>one</p>`);
    let domWrites = 0;
    const real = a.body.replaceChildren.bind(a.body);
    a.body.replaceChildren = ((...nodes: Node[]) => {
      domWrites += 1;
      return real(...nodes);
    }) as typeof a.body.replaceChildren;

    a.body.appendChild(Object.assign(a.doc.createElement("p"), { textContent: "two" }));
    await flush();

    expect(a.sync.html()).toBe(`<p>one</p><p>two</p>`);
    expect(domWrites).toBe(0);
  });

  it("a remote insertion keeps the sibling nodes the caret may be in", async () => {
    // Node reuse in rebuildChildren. A text-only remote change never reaches
    // that path, so proving reuse needs a STRUCTURAL change: a peer inserting a
    // paragraph must not replace the paragraph you are typing in.
    const a = peer(`<p id="mine">mine</p>`);
    const b = peer(``, a.y);
    await flush();

    const mine = a.body.querySelector("#mine")!;
    const caretHost = mine.firstChild;

    const inserted = b.doc.createElement("p");
    inserted.id = "theirs";
    inserted.textContent = "theirs";
    b.body.insertBefore(inserted, b.body.firstChild);
    await flush();
    exchange(a, b);
    await flush();

    expect(a.body.innerHTML).toBe(`<p id="theirs">theirs</p><p id="mine">mine</p>`);
    // Same objects, not replacements: a rebuilt subtree takes the caret with it.
    expect(a.body.querySelector("#mine")).toBe(mine);
    expect(a.body.querySelector("#mine")!.firstChild).toBe(caretHost);
  });
});

describe("joining", () => {
  it("adopts the shared document over the bytes it loaded", async () => {
    // A peer who arrives second loaded the PUBLISHED document; the shared one
    // already has edits theirs does not. Seeding again would duplicate it.
    const a = peer(`<p>edited already</p>`);
    const b = peer(`<p>stale from disk</p>`, a.y);
    await flush();
    expect(b.sync.html()).toBe(`<p>edited already</p>`);
    expect(b.body.innerHTML).toBe(`<p>edited already</p>`);
  });

  it("stops tracking once destroyed", async () => {
    const a = peer(`<p>x</p>`);
    a.sync.destroy();
    a.body.querySelector("p")!.firstChild!.nodeValue = "changed";
    await flush();
    expect(a.sync.html()).toBe(`<p>x</p>`);
  });
});

describe("the real selection during remote changes", () => {
  it("keeps a collapsed caret after preceding remote text and before a concurrent insertion at the caret", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p id="p">hello world</p>';
    doc.body.contentEditable = "true";
    const y = new Y.Doc();
    const binding = bindSync(y.getXmlFragment("body"), doc.body);
    const remote = peer("", y);
    const node = doc.querySelector("p")!.firstChild!;
    const selection = doc.getSelection()!;
    selection.setBaseAndExtent(node, 5, node, 5);
    try {
      remote.body.querySelector("p")!.firstChild!.nodeValue = "REMOTE hello world";
      await flush();
      Y.applyUpdate(y, Y.encodeStateAsUpdate(remote.y));
      expect(selection.anchorNode).toBe(node);
      expect(selection.anchorOffset).toBe(12);
      expect(selection.isCollapsed).toBe(true);
      // The caret stays with this writer's word, rather than jumping after a
      // peer's insertion and splitting the writer's next keystroke from it.
      remote.body.querySelector("p")!.firstChild!.nodeValue = "REMOTE helloPEER world";
      await flush();
      Y.applyUpdate(y, Y.encodeStateAsUpdate(remote.y));
      expect(selection.anchorOffset).toBe(12);
      expect(node.textContent).toBe("REMOTE helloPEER world");
    } finally { binding.destroy(); remote.sync.destroy(); y.destroy(); remote.y.destroy(); iframe.remove(); }
  });

  it("retains a backwards selection when a remote sibling insertion moves the selected nodes", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p id="p">selected text</p>';
    const y = new Y.Doc();
    const binding = bindSync(y.getXmlFragment("body"), doc.body);
    const remote = peer("", y);
    const node = doc.querySelector("p")!.firstChild!;
    const selection = doc.getSelection()!;
    selection.setBaseAndExtent(node, 8, node, 2);
    try {
      remote.body.insertBefore(Object.assign(remote.doc.createElement("p"), { textContent: "before" }), remote.body.firstChild);
      await flush();
      Y.applyUpdate(y, Y.encodeStateAsUpdate(remote.y));
      expect(selection.anchorNode).toBe(node);
      expect(selection.focusNode).toBe(node);
      expect([selection.anchorOffset, selection.focusOffset]).toEqual([8, 2]);
    } finally { binding.destroy(); remote.sync.destroy(); y.destroy(); remote.y.destroy(); iframe.remove(); }
  });
});

describe("browser edit intent preserves text item identity", () => {
  function writer(html: string) {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = html;
    const y = new Y.Doc();
    const sync = bindSync(y.getXmlFragment("body"), doc.body);
    return { doc, y, sync, body: doc.body, destroy() { sync.destroy(); y.destroy(); iframe.remove(); } };
  }

  async function input(w: ReturnType<typeof writer>, at: number, remove: number, text: string, type = "insertText", selectionEnd = at) {
    const node = w.body.querySelector("p")!.firstChild as Text;
    w.doc.getSelection()!.setBaseAndExtent(node, at, node, selectionEnd);
    node.parentElement!.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: type, data: text || null }));
    const start = type === "deleteContentBackward" && at === selectionEnd ? at - remove : at;
    node.replaceData(start, remove, text);
    w.doc.getSelection()!.collapse(node, start + text.length);
    node.parentElement!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type, data: text || null }));
    await flush();
  }

  it("keeps a repeated typed letter in its token when a peer deletes the original word", async () => {
    const a = writer("<p>russet Umber</p>");
    const b = peer("", a.y);
    try {
      await input(a, 0, 0, "r");
      await input(a, 1, 0, "X");
      b.body.querySelector("p")!.firstChild!.nodeValue = "Umber";
      await flush();
      exchange(a, b);
      expect(a.body.textContent).toBe("rXUmber");
      expect(b.body.textContent).toBe("rXUmber");
    } finally { a.destroy(); b.sync.destroy(); b.y.destroy(); }
  });

  for (const type of ["deleteContentBackward", "deleteContentForward"] as const) {
    it(`deletes the intended repeated letter with ${type} while a peer types beside it`, async () => {
      const a = writer("<p>aaa</p>");
      const b = peer("", a.y);
      try {
        await input(a, type === "deleteContentBackward" ? 1 : 0, 1, "", type);
        b.body.querySelector("p")!.firstChild!.nodeValue = "aXaa";
        await flush();
        exchange(a, b);
        expect(a.body.textContent).toBe("Xaa");
        expect(b.body.textContent).toBe("Xaa");
      } finally { a.destroy(); b.sync.destroy(); b.y.destroy(); }
    });
  }

  it("uses the browser target range for an equal-text replacement, even when the selection differs", async () => {
    const a = writer("<p>aaa</p>");
    const b = peer("", a.y);
    try {
      const node = a.body.querySelector("p")!.firstChild as Text;
      a.doc.getSelection()!.collapse(node, 3);
      const event = new InputEvent("beforeinput", { bubbles: true, inputType: "insertReplacementText", data: "a" });
      Object.defineProperty(event, "getTargetRanges", { value: () => [{ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }] });
      node.parentElement!.dispatchEvent(event);
      node.replaceData(0, 1, "a");
      node.parentElement!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: "a" }));
      await flush();
      // The other writer deletes the original first item. The new replacement
      // has equal bytes but a different identity, so it must survive.
      const text = (b.y.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      text.delete(0, 1);
      exchange(a, b);
      expect(a.body.textContent).toBe("aaa");
      expect(b.body.textContent).toBe("aaa");
    } finally { a.destroy(); b.sync.destroy(); b.y.destroy(); }
  });

  it("falls back to the text diff when a mutation does not match the captured input range", async () => {
    const a = writer("<p>one two</p>");
    try {
      const node = a.body.querySelector("p")!.firstChild as Text;
      a.doc.getSelection()!.collapse(node, 0);
      node.parentElement!.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "x" }));
      node.data = "one TWO";
      node.parentElement!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "x" }));
      await flush();
      expect(a.sync.html()).toBe("<p>one TWO</p>");
    } finally { a.destroy(); }
  });
});

it("notifies autosave once after a changed remote transaction is applied, without echoing it", async () => {
  const a = peer("<p>one</p>");
  const doc = document.implementation.createHTMLDocument("");
  const y = new Y.Doc();
  Y.applyUpdate(y, Y.encodeStateAsUpdate(a.y));
  const seen: string[] = [];
  const binding = bindSync(y.getXmlFragment("body"), doc.body, () => { seen.push(doc.body.innerHTML); });
  try {
    expect(seen).toEqual([]);
    a.body.querySelector("p")!.firstChild!.nodeValue = "two";
    await flush();
    Y.applyUpdate(y, Y.encodeStateAsUpdate(a.y));
    expect(seen).toEqual(["<p>two</p>"]);
    const vector = [...Y.encodeStateVector(y)];
    await flush();
    Y.applyUpdate(y, Y.encodeStateAsUpdate(a.y));
    expect([...Y.encodeStateVector(y)]).toEqual(vector);
    expect(seen).toEqual(["<p>two</p>"]);
    doc.body.querySelector("p")!.firstChild!.nodeValue = "local";
    await flush();
    expect(seen).toEqual(["<p>two</p>"]);
  } finally { binding.destroy(); y.destroy(); a.sync.destroy(); a.y.destroy(); }
});
