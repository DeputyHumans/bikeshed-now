// SPDX-License-Identifier: Apache-2.0
// A reply posts once, however it is sent (SPEC §6).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Annotation } from "../types";

const { addComment } = vi.hoisted(() => ({ addComment: vi.fn() }));

vi.mock("../firestore", () => ({
  addComment,
  listComments: () => () => {},
  setResolved: vi.fn(),
  formatRelative: () => "just now",
}));
vi.mock("../analytics", () => ({ logEvent: vi.fn() }));

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
