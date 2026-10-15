// SPDX-License-Identifier: Apache-2.0
// Anonymous legal routes render their promised documents and navigation with no ambient deployment config (SPEC §21, §23).
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { Terms, Privacy } from "./Legal";
vi.mock("../config", () => ({ LEGAL_CONTACT: "" }));
vi.mock("../analytics", () => ({ analyticsConfigured: () => false }));
afterEach(cleanup);
it.each([["Terms of service", Terms], ["Privacy policy", Privacy]] as const)("renders %s for an anonymous reader", (heading, Component) => {
  render(<MemoryRouter><Component /></MemoryRouter>);
  expect(screen.getByRole("heading", { level: 1, name: heading })).toBeTruthy();
  expect(screen.getByText(/^Last updated /)).toBeTruthy();
  expect(Array.from(document.querySelectorAll(".legal__nav a"), (link) => link.textContent)).toEqual(["Back to your documents", "Terms", "Privacy"]);
});
