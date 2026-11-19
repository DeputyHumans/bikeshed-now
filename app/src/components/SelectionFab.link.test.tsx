// SPDX-License-Identifier: Apache-2.0
// Copy link sits beside Comment for any reader, when the selection has a place to link to (SPEC §6e).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Target } from "../viewer/target";
import { SelectionFab } from "./SelectionFab";

/**
 * jsdom measures nothing, and the controls only appear over a selection with
 * a size, so the selection is given one here.
 */
beforeEach(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, left: 100, width: 80, height: 20, bottom: 120, right: 180, x: 100, y: 100 }),
  });
});
afterEach(() => {
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  document.body.innerHTML = "";
});

function select(selector: string) {
  const node = document.querySelector(selector)!.firstChild!;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 4);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

/** A target for anything inside `#pricing`, and none elsewhere, as `targetForNode` would say. */
const targetOf = (range: Range): Target | null =>
  range.startContainer.parentElement?.closest("#pricing") ? { kind: "id", id: "pricing" } : null;

function mount(commenter: boolean) {
  document.body.innerHTML = `<section id="pricing"><p id="p">Forty dollars a seat.</p></section><p id="loose">Loose words here.</p>`;
  const onComment = vi.fn();
  const onCopy = vi.fn();
  render(
    <SelectionFab
      doc={document}
      epoch={1}
      enabled
      onComment={commenter ? onComment : undefined}
      link={{ targetOf, onCopy }}
    />,
    { container: document.body.appendChild(document.createElement("div")) },
  );
  return { onComment, onCopy };
}

describe("Copy link", () => {
  it("is offered alone to a reader who may not comment, and copies the place the selection is in", () => {
    const { onCopy } = mount(false);
    select("#p");
    expect(screen.queryByRole("button", { name: /Comment/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }), { detail: 0 });
    expect(onCopy).toHaveBeenCalledWith({ kind: "id", id: "pricing" });
  });

  it("sits beside Comment, and is not offered where there is no place to link to", () => {
    mount(true);
    select("#p");
    expect(screen.getByRole("button", { name: /Comment/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    select("#loose");
    expect(screen.getByRole("button", { name: /Comment/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  });

  it("shows nothing at all to a reader who may not comment, over words with no place to link to", () => {
    mount(false);
    select("#loose");
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("answers the keyboard, and a pointer press only once", () => {
    const { onCopy } = mount(false);
    select("#p");
    const button = screen.getByRole("button", { name: "Copy link" });
    fireEvent.pointerDown(button);
    fireEvent.click(button, { detail: 1 });
    expect(onCopy).toHaveBeenCalledTimes(1);
    fireEvent.click(button, { detail: 0 });
    expect(onCopy).toHaveBeenCalledTimes(2);
  });
});
