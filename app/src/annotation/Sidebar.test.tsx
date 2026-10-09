// SPDX-License-Identifier: Apache-2.0
// A reply posts once, and a suggestion offers only what its reader may do (SPEC §6, §22).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Annotation } from "../types";

const { addComment, comments, rejectSuggestion, reviseSuggestion, withdrawSuggestion } = vi.hoisted(() => ({
  addComment: vi.fn(),
  comments: { current: [] as unknown[] },
  rejectSuggestion: vi.fn(async () => ({ state: "rejected" })),
  withdrawSuggestion: vi.fn(async () => ({ state: "withdrawn" })),
  reviseSuggestion: vi.fn(async () => ({ state: "pending" })),
}));

vi.mock("../firestore", () => ({
  addComment,
  listComments: (_d: string, _v: string, _a: string, cb: (c: unknown[]) => void) => {
    cb(comments.current);
    return () => {};
  },
  setResolved: vi.fn(),
  formatRelative: () => "just now",
}));
vi.mock("../analytics", () => ({ logEvent: vi.fn() }));
vi.mock("../suggestions", () => ({ rejectSuggestion, reviseSuggestion, withdrawSuggestion }));

import { Sidebar } from "./Sidebar";
import { ToastProvider } from "../components/Toast";

const THREAD = {
  annId: "a1",
  resolved: false,
  authorEmail: "author@example.com",
  anchor: { exact: "the passage" },
} as Annotation;

function mount() {
  render(
    <ToastProvider>
      <Sidebar
        docId="d1"
        versionId="v1"
        annotations={[THREAD]}
        orphaned={[]}
        selectedId={null}
        canComment
        signedIn
        peers={[]}
        uid="u1"
        emailLower="me@example.com"
        onSelect={() => {}}
        onComposing={() => {}}
        onSignIn={() => {}}
        onClose={() => {}}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  addComment.mockReset();
  rejectSuggestion.mockClear();
  withdrawSuggestion.mockClear();
  comments.current = [];
});

describe("replying", () => {
  it("posts once when Enter is pressed again while the first is in flight", async () => {
    // Enter never passes through the button's `disabled`, so the button alone
    // does not stop a second post.
    let finish!: () => void;
    addComment.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    mount();
    const box = screen.getByPlaceholderText("Reply");
    fireEvent.change(box, { target: { value: "Agreed." } });

    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(addComment).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Reply" }).getAttribute("aria-busy")).toBe("true");

    await act(async () => finish());
    expect((box as HTMLTextAreaElement).value).toBe("");
  });
});

const SUGGESTION = {
  annId: "s1",
  resolved: false,
  authorUid: "u-sug",
  authorEmail: "sug@example.com",
  anchor: { exact: "a single weekend" },
  suggestion: { replacement: "two weekends", state: "pending" },
} as Annotation;

function mountWith(
  annotation: Annotation,
  props: { uid?: string; isApprover?: boolean; stale?: string[]; onReview?: (annId?: string) => void } = {},
) {
  render(
    <ToastProvider>
      <Sidebar
        docId="d1"
        versionId="v1"
        annotations={[annotation]}
        orphaned={[]}
        stale={props.stale ?? []}
        isApprover={props.isApprover ?? false}
        selectedId={null}
        canComment
        signedIn
        peers={[]}
        uid={props.uid ?? "u-reader"}
        emailLower="reader@example.com"
        onSelect={() => {}}
        onComposing={() => {}}
        onSignIn={() => {}}
        onClose={() => {}}
        onReview={props.onReview}
      />
    </ToastProvider>,
  );
}

describe("a suggestion's thread", () => {
  it("says the change in words, and is counted as a suggestion", () => {
    mountWith(SUGGESTION);
    const change = document.querySelector(".suggestion-change")!;
    expect(change.textContent).toBe("Replace a single weekend with  → two weekends");
    expect(screen.getByText("1 suggested edit is waiting")).toBeTruthy();
    expect(screen.getByText("Waiting for the owner or an approver.")).toBeTruthy();
  });

  it("has no Resolve button for anybody, since only a decision settles it", () => {
    mountWith(SUGGESTION, { isApprover: true, uid: "u-sug" });
    expect(screen.queryByRole("button", { name: /Resolve/ })).toBeNull();
  });

  it("offers a reader nothing to decide", () => {
    mountWith(SUGGESTION);
    expect(screen.queryByRole("button", { name: /Reject/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("lets an approver reject it, with a reason if they give one", async () => {
    mountWith(SUGGESTION, { isApprover: true });
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    fireEvent.change(screen.getByLabelText("Why reject it? (optional)"), { target: { value: " Keep it. " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    });
    expect(rejectSuggestion).toHaveBeenCalledWith({ docId: "d1", versionId: "v1", annId: "s1", reason: "Keep it." });
  });

  it("lets its author withdraw it, and nobody else", async () => {
    mountWith(SUGGESTION, { uid: "u-sug" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    });
    expect(withdrawSuggestion).toHaveBeenCalledWith({ docId: "d1", versionId: "v1", annId: "s1" });
  });

  it("lets its author change what they suggested, in place", async () => {
    mountWith(SUGGESTION, { uid: "u-sug" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByLabelText(/Replace/) as HTMLTextAreaElement;
    expect(field.value).toBe("two weekends");
    fireEvent.change(field, { target: { value: "a fortnight" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(reviseSuggestion).toHaveBeenCalledWith({ docId: "d1", versionId: "v1", annId: "s1", replacement: "a fortnight" });
    expect(screen.queryByLabelText(/Replace/)).toBeNull();
  });

  it("takes an approver to the review pass, on this one or from the first", () => {
    const onReview = vi.fn();
    mountWith(SUGGESTION, { isApprover: true, onReview });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenLastCalledWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "Review all" }));
    expect(onReview).toHaveBeenLastCalledWith();
  });

  it("offers no review of a stale one, which can only be rejected", () => {
    mountWith(SUGGESTION, { isApprover: true, onReview: vi.fn(), stale: ["s1"] });
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject…" })).toBeTruthy();
  });

  it("says when its text has changed underneath it", () => {
    mountWith(SUGGESTION, { stale: ["s1"] });
    expect(screen.getByText(/changed since this was suggested, so it can’t be applied/)).toBeTruthy();
  });

  it("reads as a deletion when the replacement is empty", () => {
    mountWith({ ...SUGGESTION, suggestion: { replacement: "", state: "pending" } } as Annotation);
    expect(document.querySelector(".suggestion-change")!.textContent).toMatch(/^Delete a single weekend/);
  });

  it("hides the opener the server wrote, and keeps a note and every decision", () => {
    comments.current = [
      { commentId: "c1", body: "Suggested replacing …", authorEmail: "sug@example.com", opensSuggestion: true, generated: true },
      { commentId: "c2", body: "Rejected: Keep it.", authorEmail: "owner@example.com", generated: true },
    ];
    mountWith({ ...SUGGESTION, resolved: true, suggestion: { replacement: "x", state: "rejected", decidedBy: { email: "owner@example.com" } } } as Annotation);
    fireEvent.click(screen.getByRole("button", { name: "Show resolved" }));
    expect(screen.queryByText("Suggested replacing …")).toBeNull();
    expect(screen.getByText("Rejected: Keep it.")).toBeTruthy();
    expect(screen.getByText("Rejected by owner@example.com")).toBeTruthy();
  });

  it("lists what its author proposed before changing it, oldest first, with a replaced note", () => {
    const at = { toDate: () => new Date() };
    mountWith({
      ...SUGGESTION,
      suggestion: {
        replacement: "a month",
        state: "pending",
        revisions: [
          { replacement: "two weekends", at, actor: { channel: "web" } },
          { replacement: "", note: "Dual-write.", at, actor: { channel: "mcp" } },
        ],
      },
    } as unknown as Annotation);
    expect(screen.getByText("Changed 2 times")).toBeTruthy();
    const items = [...document.querySelectorAll(".suggestion-history li")].map((li) => li.textContent);
    expect(items).toEqual(["two weekends · replaced just now", "(delete) · replaced just nowDual-write."]);
    // The current text stays the change; the history is only what it replaced.
    expect(document.querySelector(".suggestion-change ins")!.textContent).toBe("a month");
  });

  it("shows no history for a suggestion never changed", () => {
    mountWith(SUGGESTION);
    expect(document.querySelector(".suggestion-history")).toBeNull();
  });

  it("keeps a withdrawn one as a closed thread, saying so, with nothing left to do", () => {
    comments.current = [
      { commentId: "c1", body: "Withdrawn.", authorEmail: "sug@example.com", generated: true },
    ];
    const withdrawn = {
      ...SUGGESTION,
      resolved: true,
      suggestion: { replacement: "two weekends", state: "withdrawn", decidedBy: { email: "sug@example.com" } },
    } as Annotation;
    mountWith(withdrawn, { uid: "u-sug", isApprover: true, onReview: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Show resolved" }));
    expect(screen.getByText("Withdrawn by sug@example.com")).toBeTruthy();
    expect(screen.queryByText("Waiting for the owner or an approver.")).toBeNull();
    expect(screen.getByText("Withdrawn.")).toBeTruthy();
    for (const name of ["Withdraw", "Edit", "Reject…", "Review"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});
