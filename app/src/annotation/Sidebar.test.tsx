// SPDX-License-Identifier: Apache-2.0
// A reply posts once, and a suggestion offers only what its reader may do (SPEC §6, §22).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Annotation } from "../types";

const { addComment, comments, rejectSuggestion, withdrawSuggestion } = vi.hoisted(() => ({
  addComment: vi.fn(),
  comments: { current: [] as unknown[] },
  rejectSuggestion: vi.fn(async () => ({ state: "rejected" })),
  withdrawSuggestion: vi.fn(async () => ({ state: "withdrawn" })),
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
vi.mock("../suggestions", () => ({ rejectSuggestion, withdrawSuggestion }));

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

function mountWith(annotation: Annotation, props: { uid?: string; isApprover?: boolean; stale?: string[] } = {}) {
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
      />
    </ToastProvider>,
  );
}

describe("a suggestion's thread", () => {
  it("says the change in words, and is counted as a suggestion", () => {
    mountWith(SUGGESTION);
    const change = document.querySelector(".suggestion-change")!;
    expect(change.textContent).toBe("Replace a single weekend with  → two weekends");
    expect(screen.getByText(/1 open/).textContent).toMatch(/\(1 suggestion\)/);
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
});
