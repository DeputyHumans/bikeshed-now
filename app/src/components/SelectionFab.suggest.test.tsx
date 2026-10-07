// SPDX-License-Identifier: Apache-2.0
// Suggest edit sits beside Comment, and explains itself when it cannot help (SPEC §22).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionFab } from "./SelectionFab";

/**
 * jsdom measures nothing, and the bar only appears over a selection with a
 * size, so the selection is given one here.
 */
beforeEach(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, left: 100, width: 80, height: 20, bottom: 120, right: 180, x: 100, y: 100 }),
  });
});
afterEach(() => {
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

function select(selector: string, from: number, to: number) {
  const node = document.querySelector(selector)!.firstChild!;
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function mount() {
  document.body.innerHTML = `<p id="p">We can cut over in a single weekend.</p><svg><text id="t">label</text></svg>`;
  const onComment = vi.fn();
  const onSuggest = vi.fn();
  const onRefused = vi.fn();
  render(
    <SelectionFab doc={document} epoch={1} enabled onComment={onComment} suggest={{ onSuggest, onRefused }} />,
    { container: document.body.appendChild(document.createElement("div")) },
  );
  return { onComment, onSuggest, onRefused };
}

describe("Suggest edit", () => {
  it("opens the form for text it can take", () => {
    const { onSuggest, onRefused } = mount();
    select("#p", 19, 35);
    fireEvent.pointerDown(screen.getByRole("button", { name: /Suggest edit/ }));
    expect(onSuggest).toHaveBeenCalledTimes(1);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("says why, rather than doing nothing, for text it cannot take", () => {
    const { onSuggest, onRefused } = mount();
    select("#t", 0, 5);
    const button = screen.getByRole("button", { name: /Suggest edit/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toMatch(/figure/);
    fireEvent.pointerDown(button);
    expect(onRefused).toHaveBeenCalledWith(expect.stringMatching(/figure/));
    expect(onSuggest).not.toHaveBeenCalled();
  });

  it("answers the keyboard, and a pointer press only once", () => {
    const { onSuggest, onComment } = mount();
    select("#p", 19, 35);
    const button = screen.getByRole("button", { name: /Suggest edit/ });
    fireEvent.pointerDown(button);
    fireEvent.click(button, { detail: 1 }); // the click that follows a press
    expect(onSuggest).toHaveBeenCalledTimes(1);
    fireEvent.click(button, { detail: 0 }); // Enter or Space
    expect(onSuggest).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: /Comment/ }), { detail: 0 });
    expect(onComment).toHaveBeenCalledTimes(1);
  });
});
