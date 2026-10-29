// SPDX-License-Identifier: Apache-2.0
// Late format metadata cannot offer formatting that the source cannot preserve (SPEC §11).

import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { EditToolbar } from "./EditToolbar";

it("holds presentation controls until format is known while keeping common text controls usable", () => {
  const props = { doc: null, saveState: "saved" as const, onCommit: () => {}, onExit: () => {} };
  const view = render(<EditToolbar {...props} format={null} />);
  for (const name of ["Underline", "Align left", "Align centre", "Font", "Text colour"]) {
    const control = screen.getByLabelText(name) as HTMLButtonElement;
    expect(control.disabled, name).toBe(true);
    expect(control.title, name).toContain("Loading document format");
  }
  expect((screen.getByRole("button", { name: "Bold" }) as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<EditToolbar {...props} format="markdown" />);
  expect((screen.getByRole("button", { name: "Underline" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Underline" }).title).toContain("Markdown cannot express");
  view.rerender(<EditToolbar {...props} format="html" />);
  for (const name of ["Underline", "Align left", "Align centre", "Font", "Text colour"]) expect((screen.getByLabelText(name) as HTMLButtonElement).disabled, name).toBe(false);
});
