// SPDX-License-Identifier: Apache-2.0
// The review pass: who is told what, and what each control will do (SPEC §22).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Annotation } from "../types";
import { ReviewBar } from "./ReviewBar";

const s = (annId: string, exact: string, replacement: string): Annotation =>
  ({
    annId,
    authorEmail: "sug@example.com",
    anchor: { exact },
    suggestion: { replacement, state: "pending" },
  }) as Annotation;

const PENDING = [s("a", "a single weekend", "two weekends"), s("b", "very", "")];

function bar(props: Partial<Parameters<typeof ReviewBar>[0]> = {}) {
  const handlers = {
    onStart: vi.fn(),
    onGo: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(async () => true),
    onDone: vi.fn(),
  };
  render(
    <ReviewBar
      pending={PENDING}
      canDecide
      reviewing
      currentId="a"
      stale={new Set()}
      ready
      busy={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("ReviewBar", () => {
  it("says nothing when nothing is waiting", () => {
    const { container } = render(
      <ReviewBar pending={[]} canDecide reviewing={false} currentId={null} stale={new Set()} ready busy={false}
        onStart={() => {}} onGo={() => {}} onAccept={() => {}} onReject={async () => true} onDone={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("tells somebody who cannot decide who can, and offers them nothing", () => {
    bar({ canDecide: false, reviewing: false });
    expect(screen.getByText(/2 suggested edits are waiting\. Only the owner or an approver can accept or reject them\./)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers an approver the way in", () => {
    const { onStart } = bar({ reviewing: false });
    fireEvent.click(screen.getByRole("button", { name: "Review them" }));
    expect(onStart).toHaveBeenCalled();
  });

  it("shows where it is, and the change in words", () => {
    bar();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(document.querySelector(".review-change")!.textContent).toMatch(
      /sug@example\.com suggests: .*replace a single weekend with .*two weekends/,
    );
  });

  it("accepts the one on screen", () => {
    const { onAccept } = bar();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledWith(PENDING[0]);
  });

  it("will not accept a stale one, or before the live document is joined", () => {
    bar({ stale: new Set(["a"]) });
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/can’t be applied/)).toBeTruthy();
  });

  it("waits for the live document before it will accept", () => {
    bar({ ready: false });
    const accept = screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(accept.title).toMatch(/Joining/);
  });

  it("rejects with a reason, from the keyboard", () => {
    const { onReject } = bar();
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    const field = screen.getByLabelText("Why reject it? (optional)");
    fireEvent.change(field, { target: { value: " Keep it. " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onReject).toHaveBeenCalledWith(PENDING[0], "Keep it.");
  });

  it("forgets a half-written rejection when the suggestion on screen changes under it", () => {
    // Another approver decides "a", or its author withdraws it: the pass moves
    // to "b". A reason still open here would reject "b" on Enter, for "a"'s reason.
    const props = { canDecide: true, reviewing: true, stale: new Set<string>(), ready: true, busy: false,
      onStart: vi.fn(), onGo: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(async () => true), onDone: vi.fn() };
    const { rerender } = render(<ReviewBar pending={PENDING} currentId="a" {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    fireEvent.change(screen.getByLabelText("Why reject it? (optional)"), { target: { value: "Not this one." } });
    rerender(<ReviewBar pending={[PENDING[1]]} currentId="b" {...props} />);
    expect(screen.queryByLabelText("Why reject it? (optional)")).toBeNull();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(props.onReject).not.toHaveBeenCalled();
  });

  it("keeps the reason when the rejection fails", async () => {
    const onReject = vi.fn(async () => false);
    bar({ onReject });
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    const field = screen.getByLabelText("Why reject it? (optional)") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Keep it." } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {});
    expect(onReject).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Why reject it? (optional)") as HTMLInputElement).value).toBe("Keep it.");
  });

  it("does not reject from the keyboard while a decision is in flight", () => {
    const props = { pending: PENDING, currentId: "a", canDecide: true, reviewing: true, stale: new Set<string>(), ready: true,
      onStart: vi.fn(), onGo: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(async () => true), onDone: vi.fn() };
    const { rerender } = render(<ReviewBar {...props} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    rerender(<ReviewBar {...props} busy />);
    fireEvent.keyDown(screen.getByLabelText("Why reject it? (optional)"), { key: "Enter" });
    expect(props.onReject).not.toHaveBeenCalled();
  });

  it("moves round the list either way", () => {
    const { onGo } = bar({ currentId: "b" });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onGo).toHaveBeenLastCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onGo).toHaveBeenLastCalledWith("a");
  });
});
