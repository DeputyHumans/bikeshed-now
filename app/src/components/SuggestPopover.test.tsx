// SPDX-License-Identifier: Apache-2.0
// Writing a suggestion: three moves, one line, nothing lost on the way (SPEC §22).

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SuggestForm, popoverPosition } from "./SuggestPopover";

describe("popoverPosition", () => {
  const FRAME = { width: 1000, height: 800 };
  const SIZE = { width: 340, height: 200 };

  it("sits below the selection, so the text being rewritten stays in view", () => {
    expect(popoverPosition({ top: 100, left: 300, width: 80, height: 20 }, FRAME, SIZE)).toEqual({
      top: 128,
      left: 300,
      width: 340,
    });
  });

  it("goes above when there is no room below", () => {
    expect(popoverPosition({ top: 700, left: 300, width: 80, height: 20 }, FRAME, SIZE).top).toBe(700 - 200 - 8);
  });

  it("stays below when there is no room above either", () => {
    expect(popoverPosition({ top: 50, left: 300, width: 80, height: 20 }, { width: 1000, height: 150 }, SIZE).top).toBe(78);
  });

  it("never runs off the right edge, and fits a phone", () => {
    expect(popoverPosition({ top: 100, left: 900, width: 80, height: 20 }, FRAME, SIZE).left).toBe(1000 - 340 - 8);
    const phone = popoverPosition({ top: 100, left: 10, width: 80, height: 20 }, { width: 320, height: 640 }, SIZE);
    expect(phone).toEqual({ top: 128, left: 8, width: 304 });
  });
});

function form(props: Partial<Parameters<typeof SuggestForm>[0]> = {}) {
  const onSubmit = vi.fn(async () => {});
  const onCancel = vi.fn();
  render(
    <SuggestForm
      exact="a single weekend"
      initial="a single weekend"
      submitLabel="Suggest"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />,
  );
  const field = screen.getByLabelText(/Replace/) as HTMLTextAreaElement;
  return { field, onSubmit, onCancel };
}

describe("SuggestForm", () => {
  it("starts with the quoted text, the caret at its end", () => {
    const { field } = form();
    expect(field.value).toBe("a single weekend");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe("a single weekend".length);
  });

  it("will not submit an unchanged quote", () => {
    const { field, onSubmit } = form();
    expect((screen.getByRole("button", { name: "Suggest" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits on Enter, with the note trimmed", () => {
    const { field, onSubmit } = form();
    fireEvent.change(field, { target: { value: "two weekends" } });
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "  dual-write  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("two weekends", "dual-write");
  });

  it("turns a pasted line break into a space, since a replacement is one line", () => {
    const { field } = form();
    fireEvent.change(field, { target: { value: "two\nweekends" } });
    expect(field.value).toBe("two weekends");
  });

  it("says that an empty replacement deletes the text", () => {
    const { field, onSubmit } = form();
    fireEvent.change(field, { target: { value: "" } });
    expect(screen.getByText("Left empty, this suggests deleting it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Suggest" }));
    expect(onSubmit).toHaveBeenCalledWith("", "");
  });

  it("closes on Escape", () => {
    const { field, onCancel } = form();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
