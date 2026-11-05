// SPDX-License-Identifier: Apache-2.0
// A reply posts once, and a suggestion offers only what its reader may do (SPEC §6, §22).

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function mount(selectedId: string | null = null) {
  render(
    <ToastProvider>
      <Sidebar
        docId="d1"
        versionId="v1"
        annotations={[THREAD]}
        orphaned={[]}
        selectedId={selectedId}
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

describe("what acted on a comment", () => {
  const COMMENTS = [
    { commentId: "c1", body: "From a token.", authorEmail: "ana@example.com", actor: { channel: "cli", via: "CLI on mbp" } },
    { commentId: "c2", body: "From the browser.", authorEmail: "bo@example.com", actor: { channel: "web" } },
  ];

  it("reads agent on the comment an agent posted, with the words in its title, and nothing on a person's", () => {
    comments.current = COMMENTS;
    mount();
    const [fromToken, fromPerson] = [...document.querySelectorAll(".comment")] as HTMLElement[];
    expect(fromToken.querySelector(".comment-head")?.textContent).toContain("agent");
    expect(fromToken.textContent).not.toContain("CLI on mbp");
    expect(fromToken.querySelector(".badge-automated")?.getAttribute("title")).toBe("Posted on ana@example.com's behalf by CLI on mbp");
    expect(fromPerson.querySelector(".badge-automated")).toBeNull();
  });

  it("a tap shows the words and does not also select the thread, which would jump to its passage", () => {
    comments.current = COMMENTS;
    const onSelect = vi.fn();
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
          onSelect={onSelect}
          onComposing={() => {}}
          onSignIn={() => {}}
          onClose={() => {}}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "agent" }));
    expect(screen.getByText("Posted on ana@example.com's behalf by CLI on mbp")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

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

  it("offers nothing that would be refused while somebody else is applying it, and lets go when that lapses", () => {
    // The server refuses each of these under another person's live claim; the
    // buttons stayed enabled, and the notice stayed after the claim had lapsed.
    vi.useFakeTimers();
    try {
      const held = (ms: number) =>
        ({
          ...SUGGESTION,
          suggestion: {
            ...SUGGESTION.suggestion,
            claim: { uid: "u-appr", email: "appr@example.com", until: { toMillis: () => Date.now() + ms } },
          },
        }) as unknown as Annotation;
      const until = Date.now() + 1000;
      const claimed = {
        ...SUGGESTION,
        suggestion: { ...SUGGESTION.suggestion, claim: { uid: "u-appr", email: "appr@example.com", until: { toMillis: () => until } } },
      } as unknown as Annotation;
      mountWith(claimed, { uid: "u-sug" });
      expect(screen.getByText(/appr@example\.com is applying it/)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(screen.queryByText(/is applying it/)).toBeNull();
      expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(false);
      cleanup();

      mountWith(held(60_000), { uid: "u-owner", isApprover: true });
      expect((screen.getByRole("button", { name: "Reject…" }) as HTMLButtonElement).disabled).toBe(true);
      cleanup();
      // Its own claim leaves its holder free to decide.
      mountWith(held(60_000), { uid: "u-appr", isApprover: true });
      expect((screen.getByRole("button", { name: "Reject…" }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

  it("marks a decision an agent made with the badge beside the approver, and says what acted only behind it", () => {
    mountWith({
      ...SUGGESTION,
      resolved: true,
      suggestion: { replacement: "x", state: "accepted", decidedBy: { email: "owner@example.com", channel: "mcp", via: "CLI on mbp" } },
    } as unknown as Annotation);
    fireEvent.click(screen.getByRole("button", { name: "Show resolved" }));
    const status = document.querySelector(".suggestion-status")!;
    expect(status.textContent).toBe("Accepted by owner@example.com agent");
    expect(status.querySelector(".badge-automated")?.getAttribute("title")).toBe("Accepted through CLI on mbp, not by a person in the browser");
  });

  it("gives no badge to a decision made in the browser", () => {
    mountWith({
      ...SUGGESTION,
      suggestion: { replacement: "x", state: "rejected", decidedBy: { email: "owner@example.com", channel: "web" } },
    } as unknown as Annotation);
    const status = document.querySelector(".suggestion-status")!;
    expect(status.textContent).toBe("Rejected by owner@example.com");
    expect(status.querySelector(".badge-automated")).toBeNull();
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


describe("scrolling to the selected thread", () => {
  it.each([true, false])("honours reduced motion %s when a highlight selects its card", (reduce) => {
    const scroll = vi.fn();
    const old = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    const original = window.matchMedia;
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...original(query), matches: reduce }));
    try {
      mount(THREAD.annId);
      expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    } finally {
      cleanup();
      media.mockRestore();
      if (old) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", old);
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

it("an archive keeps feedback visible while removing every mutation, including an already open form", () => {
  comments.current = [{ commentId: "c", authorEmail: "reader@example.com", body: "archived feedback" }];
  const props = { docId: "d", versionId: "v1", annotations: [SUGGESTION], orphaned: [], selectedId: null,
    canComment: true, signedIn: true, peers: [], uid: "u-sug", emailLower: "sug@example.com", isApprover: true,
    onSelect: () => {}, onComposing: () => {}, onSignIn: () => {}, onClose: () => {}, onReview: () => {} };
  const { rerender } = render(<ToastProvider><Sidebar {...props} /></ToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  rerender(<ToastProvider><Sidebar {...props} readOnly /></ToastProvider>);
  expect(screen.getByText("archived feedback")).toBeTruthy();
  for (const name of ["Save", "Edit", "Withdraw", "Reject…", "Review", "Review all", "Reply"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  expect(screen.queryByPlaceholderText("Reply")).toBeNull();
  expect(addComment).not.toHaveBeenCalled();
});
