// SPDX-License-Identifier: Apache-2.0
// Accepting is an edit in the live session, applied once, saved before it is recorded (SPEC §22).

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applySuggestion } from "../annotation/exact";
import { serializeCleanHtml } from "../annotation/highlighter";
import { bindSync } from "../crdt/sync";
import type { Anchor } from "../types";
import { acceptInSession } from "./useSuggestionReview";

/**
 * jsdom has no `execCommand`. This stands in for the browser's: it replaces
 * the selection the way `insertText` and `delete` do, through the DOM, so the
 * CRDT binding sees an ordinary edit — which is the whole point of accepting
 * by editing.
 */
function giveExecCommand(doc: Document) {
  (doc as Document & { execCommand: unknown }).execCommand = (cmd: string, _ui: boolean, value?: string) => {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    if (cmd === "insertText") range.insertNode(doc.createTextNode(value ?? ""));
    else if (cmd !== "delete") return false;
    sel.collapseToEnd?.();
    return true;
  };
}

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const f of frames.splice(0)) f.remove();
});

/** An editing peer: a real frame (it has a window, so it has a selection) bound to its own Y.Doc. */
function peer(html: string, syncFrom?: Y.Doc) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = html;
  giveExecCommand(doc);
  // jsdom implements no window.focus and says so on every call.
  frame.contentWindow!.focus = () => {};
  const y = new Y.Doc();
  if (syncFrom) Y.applyUpdate(y, Y.encodeStateAsUpdate(syncFrom));
  const sync = bindSync(y.getXmlFragment("body"), doc.body);
  return { doc, y, sync };
}

function exchange(...peers: { y: Y.Doc }[]) {
  for (const from of peers) {
    const update = Y.encodeStateAsUpdate(from.y);
    for (const to of peers) if (to !== from) Y.applyUpdate(to.y, update);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const HTML = `<section id="s1"><p>We can cut over in a single weekend, without downtime.</p></section>`;
const ANCHOR: Anchor = {
  elementId: "s1",
  exact: "a single weekend",
  prefix: "We can cut over in ",
  suffix: ", without downtime.",
  start: 19,
  end: 35,
};

describe("applying a suggestion", () => {
  it("is an ordinary edit, which reaches a co-editor through the shared document", async () => {
    const approver = peer(HTML);
    await settle();
    const editor = peer("", approver.y);
    await settle();

    expect(applySuggestion(approver.doc, ANCHOR, "two weekends")).toBe("applied");
    await settle();
    exchange(approver, editor);
    await settle();

    expect(editor.doc.body.textContent).toBe("We can cut over in two weekends, without downtime.");
  });

  it("is not made twice by a second approver who has received the first", async () => {
    const a = peer(HTML);
    await settle();
    const b = peer("", a.y);
    await settle();
    expect(applySuggestion(a.doc, ANCHOR, "two weekends")).toBe("applied");
    await settle();
    exchange(a, b);
    await settle();

    expect(applySuggestion(b.doc, ANCHOR, "two weekends")).toBe("already-applied");
    await settle();
    exchange(a, b);
    await settle();
    expect(count(a.doc.body.textContent!, "two weekends")).toBe(1);
    expect(count(b.doc.body.textContent!, "two weekends")).toBe(1);
  });

  it("touches nothing when the text has changed underneath it", async () => {
    const a = peer(HTML.replace("a single weekend", "one long weekend"));
    await settle();
    const before = a.doc.body.innerHTML;
    expect(applySuggestion(a.doc, ANCHOR, "two weekends")).toBe("stale");
    expect(a.doc.body.innerHTML).toBe(before);
  });

  it("deletes, for an empty replacement", async () => {
    const a = peer(HTML);
    await settle();
    expect(applySuggestion(a.doc, ANCHOR, "")).toBe("applied");
    expect(a.doc.body.textContent).toBe("We can cut over in , without downtime.");
  });

  it("reports an editor that refused, rather than claiming success", async () => {
    const a = peer(HTML);
    await settle();
    (a.doc as Document & { execCommand: unknown }).execCommand = () => false;
    expect(applySuggestion(a.doc, ANCHOR, "two weekends")).toBe("failed");
    // A quote with no context has nothing to verify by afterwards, so the
    // editor's own refusal is the only signal there is, and it is heeded.
    const bare = { ...ANCHOR, prefix: "", suffix: "" };
    expect(applySuggestion(a.doc, bare, "two weekends")).toBe("failed");
  });
});

describe("acceptInSession: claim, apply, save, and only then record", () => {
  it("saves the draft with the change in it before it says anything was accepted", async () => {
    const a = peer(HTML);
    await settle();
    const order: string[] = [];
    let saved = "";
    const outcome = await acceptInSession({
      claim: async () => void order.push("claim"),
      apply: () => (order.push("apply"), applySuggestion(a.doc, ANCHOR, "two weekends")),
      flush: async () => {
        order.push("save");
        saved = serializeCleanHtml(a.doc);
      },
      saveFailed: () => false,
      record: async () => {
        order.push("record");
        // What the server is told was accepted is already in the saved bytes.
        expect(count(saved, "two weekends")).toBe(1);
      },
    });
    expect(outcome).toBe("applied");
    expect(order).toEqual(["claim", "apply", "save", "record"]);
  });

  it("records nothing when the draft did not save", async () => {
    const order: string[] = [];
    const outcome = await acceptInSession({
      claim: async () => void order.push("claim"),
      apply: () => "applied",
      flush: async () => void order.push("save"),
      saveFailed: () => true,
      record: async () => void order.push("record"),
    });
    expect(outcome).toBe("unsaved");
    expect(order).toEqual(["claim", "save"]);
  });

  it("records nothing, and saves nothing, when there was nothing it could apply", async () => {
    for (const result of ["stale", "failed"] as const) {
      const order: string[] = [];
      const outcome = await acceptInSession({
        claim: async () => void order.push("claim"),
        apply: () => result,
        flush: async () => void order.push("save"),
        saveFailed: () => false,
        record: async () => void order.push("record"),
      });
      expect(outcome).toBe(result);
      expect(order).toEqual(["claim"]);
    }
  });

  it("finishes an acceptance that was interrupted after the edit, without making it again", async () => {
    const a = peer(HTML.replace("a single weekend", "two weekends"));
    await settle();
    const recorded: string[] = [];
    const outcome = await acceptInSession({
      claim: async () => {},
      apply: () => applySuggestion(a.doc, ANCHOR, "two weekends"),
      flush: async () => {},
      saveFailed: () => false,
      record: async () => void recorded.push("accepted"),
    });
    expect(outcome).toBe("already-applied");
    expect(recorded).toEqual(["accepted"]);
    expect(count(a.doc.body.textContent!, "two weekends")).toBe(1);
  });

  it("goes no further when another approver holds the claim", async () => {
    const order: string[] = [];
    await expect(
      acceptInSession({
        claim: async () => {
          throw new Error("appr@example.com is applying it right now");
        },
        apply: () => (order.push("apply"), "applied"),
        flush: async () => void order.push("save"),
        saveFailed: () => false,
        record: async () => void order.push("record"),
      }),
    ).rejects.toThrow(/applying it right now/);
    expect(order).toEqual([]);
  });
});
