// SPDX-License-Identifier: Apache-2.0
// A long wait says so, then offers a way out, and each stage keeps its own clock.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Loading, SLOW_MS, STUCK_MS } from "./Spinner";

const SLOW = /taking longer than it should/i;
const retryButton = () => screen.queryByRole("button", { name: "Try again" });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Loading", () => {
  it("says nothing more, and offers nothing, where no retry is given", () => {
    render(<Loading label="Loading the activity" />);
    act(() => vi.advanceTimersByTime(STUCK_MS * 2));
    expect(screen.queryByText(SLOW)).toBeNull();
    expect(retryButton()).toBeNull();
  });

  it("admits a slow stage, then offers to start it again", () => {
    const onRetry = vi.fn();
    render(<Loading label="Opening the document" onRetry={onRetry} />);
    expect(screen.getByText("Opening the document…")).toBeTruthy();

    act(() => vi.advanceTimersByTime(SLOW_MS - 1));
    expect(screen.queryByText(SLOW)).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText(SLOW)).toBeTruthy();
    expect(retryButton()).toBeNull();

    act(() => vi.advanceTimersByTime(STUCK_MS - SLOW_MS));
    fireEvent.click(retryButton()!);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("starts the clock again when the wait moves to its next stage", () => {
    // The sequence a reader actually sees: signing in, then the document.
    // Time spent signing in must not make the document look slow.
    const { rerender } = render(<Loading label="Signing in" onRetry={() => {}} />);
    act(() => vi.advanceTimersByTime(SLOW_MS - 500));
    rerender(<Loading label="Opening the document" onRetry={() => {}} />);
    act(() => vi.advanceTimersByTime(SLOW_MS - 500));
    expect(screen.queryByText(SLOW)).toBeNull();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByText(SLOW)).toBeTruthy();
  });

  it("starts the clock again after Try again, when the stage keeps its name", () => {
    // Reloading the frame waits under the same label, so without this the
    // button would come straight back the moment it was pressed.
    render(<Loading label="Loading the page" onRetry={() => {}} />);
    act(() => vi.advanceTimersByTime(STUCK_MS));
    fireEvent.click(retryButton()!);
    expect(screen.queryByText(SLOW)).toBeNull();
    expect(retryButton()).toBeNull();
    act(() => vi.advanceTimersByTime(SLOW_MS));
    expect(screen.getByText(SLOW)).toBeTruthy();
  });

  it("does not restart the clock when only the retry function is new", () => {
    // DocViewer passes a fresh arrow on every render, and it re-renders often.
    const { rerender } = render(<Loading label="Signing in" onRetry={() => {}} />);
    act(() => vi.advanceTimersByTime(SLOW_MS - 500));
    rerender(<Loading label="Signing in" onRetry={() => {}} />);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByText(SLOW)).toBeTruthy();
  });
});
