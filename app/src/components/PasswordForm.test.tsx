// SPDX-License-Identifier: Apache-2.0
// Password-policy failures defer to Auth without leaving signup permanently disabled (SPEC §14).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PasswordForm } from "./PasswordForm";
const sdk = vi.hoisted(() => ({ validate: vi.fn(), signUp: vi.fn(async () => {}), signIn: vi.fn(async () => {}) }));
vi.mock("firebase/auth", () => ({ validatePassword: sdk.validate }));
vi.mock("../firebase", () => ({ auth: {} }));
vi.mock("../auth", () => ({ useAuth: () => ({ signUpWithPassword: sdk.signUp, signInWithPassword: sdk.signIn, resetPassword: vi.fn(), error: null }) }));
beforeEach(() => { vi.clearAllMocks(); sdk.validate.mockReset(); });
const valid = { isValid: true, passwordPolicy: { customStrengthOptions: {} } };
function form() {
  render(<PasswordForm busy={false} setBusy={() => {}} />);
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "reader@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Password1!" } });
  return screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement;
}

it("a failed policy request enables signup and explains that Auth will check on submit", async () => {
  sdk.validate.mockRejectedValue(new Error("policy unavailable"));
  const submit = form();
  await waitFor(() => expect(submit.disabled).toBe(false));
  expect(screen.getByRole("status").textContent).toMatch(/check your password when you create/i);
  fireEvent.click(submit);
  await waitFor(() => expect(sdk.signUp).toHaveBeenCalledWith("reader@example.com", "Password1!"));
});

it("a valid SDK verdict with no displayed requirements permits signup", async () => {
  sdk.validate.mockResolvedValue(valid);
  const submit = form();
  await waitFor(() => expect(submit.disabled).toBe(false));
  expect(screen.queryByRole("list")).toBeNull();
});

it("a known-invalid password stays disabled and displays the requirement", async () => {
  sdk.validate.mockResolvedValue({ isValid: false, meetsMinPasswordLength: false, passwordPolicy: { customStrengthOptions: { minPasswordLength: 20 } } });
  const submit = form();
  await waitFor(() => expect(screen.getByText("At least 20 characters")).toBeDefined());
  expect(submit.disabled).toBe(true);
  fireEvent.click(submit);
  expect(sdk.signUp).not.toHaveBeenCalled();
});

it("changing the password drops the previous verdict while the next check is pending", async () => {
  let finish: (value: typeof valid) => void = () => {};
  sdk.validate.mockResolvedValueOnce({ ...valid, meetsMinPasswordLength: true, passwordPolicy: { customStrengthOptions: { minPasswordLength: 6 } } })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const submit = form();
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "new-password" } });
  expect(submit.disabled).toBe(true);
  await act(async () => finish(valid));
  expect(submit.disabled).toBe(false);
});

it("a delayed previous password verdict cannot replace the current one", async () => {
  let first: (value: typeof valid) => void = () => {};
  sdk.validate.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }))
    .mockResolvedValueOnce({ isValid: false, meetsMinPasswordLength: false, passwordPolicy: { customStrengthOptions: { minPasswordLength: 20 } } });
  const submit = form();
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "new-password" } });
  await waitFor(() => expect(screen.getByText("At least 20 characters")).toBeDefined());
  await act(async () => first(valid));
  expect(submit.disabled).toBe(true);
  expect(screen.getByText("At least 20 characters")).toBeDefined();
});
