// SPDX-License-Identifier: Apache-2.0
// Accepting is an edit in the live session, applied once, saved before it is recorded (SPEC §22).

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applySuggestion, resolveSuggestion } from "../annotation/exact";
import { serializeCleanHtml } from "../annotation/highlighter";
import { bindSync } from "../crdt/sync";
import type { Anchor } from "../types";
import { acceptInSession } from "./useSuggestionReview";

/** How the stand-in editor misbehaves, when a test wants it to. */
interface Quirks {
  /** Type something other than what was asked. */
  mangle?: boolean;
  /** Have no undo. */
  noUndo?: boolean;
}

/**
 * jsdom has no `execCommand`. This stands in for the browser's: it replaces
 * the selection the way `insertText` and `delete` do, through the DOM, so the
 * CRDT binding sees an ordinary edit — which is the whole point of accepting
 * by editing. `undo` puts back the body as it was before the last edit.
 */
function giveExecCommand(doc: Document, quirks: Quirks = {}) {
  const history: string[] = [];
  (doc as Document & { execCommand: unknown }).execCommand = (cmd: string, _ui: boolean, value?: string) => {
    if (cmd === "undo") {
      const before = history.pop();
      if (quirks.noUndo || before === undefined) return false;
      doc.body.innerHTML = before;
      return true;
    }
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    if (cmd !== "insertText" && cmd !== "delete") return false;
    history.push(doc.body.innerHTML);
    const range = sel.getRangeAt(0);
    range.deleteContents();
    if (cmd === "insertText") range.insertNode(doc.createTextNode(`${value ?? ""}${quirks.mangle ? "!" : ""}`));
    sel.collapseToEnd?.();
    return true;
  };
}

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const f of frames.splice(0)) f.remove();
});

/** An editing peer: a real frame (it has a window, so it has a selection) bound to its own Y.Doc. */
function peer(html: string, syncFrom?: Y.Doc, quirks?: Quirks) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = html;
  giveExecCommand(doc, quirks);
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

  it("deletes, for an empty replacement, with the space it leaves behind", async () => {
    const a = peer(HTML);
    await settle();
    expect(applySuggestion(a.doc, ANCHOR, "")).toBe("applied");
    expect(a.doc.body.textContent).toBe("We can cut over in, without downtime.");
  });

  it("deletes a word between two spaces with one of them", async () => {
    // What the first acceptance on a real document left: "vs.&nbsp; Codex".
    const a = peer(`<section id="h"><h1>Claude Code vs. OpenAI Codex</h1></section>`);
    await settle();
    const word = { elementId: "h", exact: "OpenAI", prefix: "Claude Code vs. ", suffix: " Codex", start: 16, end: 22 };
    expect(applySuggestion(a.doc, word, "")).toBe("applied");
    expect(a.doc.body.textContent).toBe("Claude Code vs. Codex");
  });

  it("deletes a block's first word with the space after it", async () => {
    const a = peer(`<section id="s"><p>Start here and go.</p></section>`);
    await settle();
    const first = { elementId: "s", exact: "Start", prefix: "", suffix: " here and go.", start: 0, end: 5 };
    expect(applySuggestion(a.doc, first, "")).toBe("applied");
    expect(a.doc.body.textContent).toBe("here and go.");
  });

  it("applies it where the text after the quote has since changed, and says so", async () => {
    // The reported failure: the edit was made, and "nothing was accepted" said.
    const a = peer(HTML.replace("without downtime", "with an hour of downtime"));
    await settle();
    expect(applySuggestion(a.doc, ANCHOR, "two weekends")).toBe("applied");
    expect(a.doc.body.textContent).toBe("We can cut over in two weekends, with an hour of downtime.");
  });

  it("inserts a replacement that contains its quote once, however often it is accepted", async () => {
    const ins: Anchor = {
      elementId: "s1",
      exact: "developers and engineering leads",
      prefix: "Audience: ",
      suffix: ". Next",
      start: 10,
      end: 42,
    };
    const rep = "product managers, developers and engineering leads";
    for (const before of ["Audience", "Readers"]) {
      const a = peer(`<section id="s1"><p>${before}: developers and engineering leads. Next</p></section>`);
      await settle();
      expect(applySuggestion(a.doc, ins, rep)).toBe("applied");
      expect(applySuggestion(a.doc, ins, rep)).toBe("already-applied");
      expect(count(a.doc.body.textContent!, "product managers")).toBe(1);
    }
  });

  it("undoes an edit that did not come out as suggested, and says nothing was made", async () => {
    const a = peer(HTML, undefined, { mangle: true });
    await settle();
    const before = a.doc.body.innerHTML;
    expect(applySuggestion(a.doc, ANCHOR, "two weekends")).toBe("failed");
    expect(a.doc.body.innerHTML).toBe(before);
  });

  it("says when an edit that did not come out as suggested could not be undone", async () => {
    const a = peer(HTML, undefined, { mangle: true, noUndo: true });
    await settle();
    expect(applySuggestion(a.doc, ANCHOR, "two weekends")).toBe("unverified");
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
      check: () => "pending",
      claim: async () => void order.push("claim"),
      release: async () => {},
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
      check: () => "pending",
      claim: async () => void order.push("claim"),
      release: async () => {},
      apply: () => "applied",
      flush: async () => void order.push("save"),
      saveFailed: () => true,
      record: async () => void order.push("record"),
    });
    expect(outcome).toBe("unsaved");
    expect(order).toEqual(["claim", "save"]);
  });

  it("records nothing, and saves nothing, when there was nothing it could apply", async () => {
    for (const result of ["stale", "failed", "unverified"] as const) {
      const order: string[] = [];
      const outcome = await acceptInSession({
        check: () => "pending",
        claim: async () => void order.push("claim"),
        release: async () => void order.push("release"),
        apply: () => result,
        flush: async () => void order.push("save"),
        saveFailed: () => false,
        record: async () => void order.push("record"),
      });
      expect(outcome).toBe(result);
      // Its claim let go at once: two minutes of other approvers, and the
      // author, kept off a suggestion nobody is applying.
      expect(order).toEqual(["claim", "release"]);
    }
  });

  it("says the change is in the draft when only recording it fails", async () => {
    // "Failed to fetch" is all the approver was told, over a draft that has
    // the change: accepting again finds it made and records it.
    const order: string[] = [];
    const outcome = await acceptInSession({
      check: () => "pending",
      claim: async () => void order.push("claim"),
      release: async () => {},
      apply: () => (order.push("apply"), "applied"),
      flush: async () => void order.push("save"),
      saveFailed: () => false,
      record: async () => {
        order.push("record");
        throw new Error("Failed to fetch");
      },
    });
    expect(outcome).toBe("unrecorded");
    expect(order).toEqual(["claim", "apply", "save", "record"]);
  });

  it("takes no claim on a suggestion that is already stale", async () => {
    // A claim keeps every other approver, and the author, off it for two
    // minutes. Taking one only to find nothing to apply held them off for nothing.
    const order: string[] = [];
    const outcome = await acceptInSession({
      check: () => "stale",
      claim: async () => void order.push("claim"),
      release: async () => {},
      apply: () => (order.push("apply"), "applied"),
      flush: async () => void order.push("save"),
      saveFailed: () => false,
      record: async () => void order.push("record"),
    });
    expect(outcome).toBe("stale");
    expect(order).toEqual([]);
  });

  it("finishes an acceptance that was interrupted after the edit, without making it again", async () => {
    const a = peer(HTML.replace("a single weekend", "two weekends"));
    await settle();
    const recorded: string[] = [];
    const outcome = await acceptInSession({
      check: () => resolveSuggestion(a.doc, ANCHOR, "two weekends").state,
      claim: async () => {},
      release: async () => {},
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
        check: () => "pending",
        claim: async () => {
          throw new Error("appr@example.com is applying it right now");
        },
        release: async () => {},
        apply: () => (order.push("apply"), "applied"),
        flush: async () => void order.push("save"),
        saveFailed: () => false,
        record: async () => void order.push("record"),
      }),
    ).rejects.toThrow(/applying it right now/);
    expect(order).toEqual([]);
  });
});
