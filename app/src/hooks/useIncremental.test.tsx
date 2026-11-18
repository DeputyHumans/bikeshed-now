// SPDX-License-Identifier: Apache-2.0
// A long list is drawn 25 at a time, the next batch as its end comes within reach or the button is pressed (SPEC §13 "Grid and list").

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BATCH, useIncremental } from "./useIncremental";
import { MoreItems } from "../components/MoreItems";

/**
 * An IntersectionObserver the test moves, as scrolling would. Each one made is
 * kept, so a test can see that a fresh one watches after every batch.
 */
let observers: Array<{ cb: (entries: Array<{ isIntersecting: boolean }>) => void; live: boolean }> = [];
class FakeObserver {
  private entry: { cb: (entries: Array<{ isIntersecting: boolean }>) => void; live: boolean };
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    this.entry = { cb, live: true };
    observers.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.live = false;
  }
}
const live = () => observers.filter((o) => o.live);
/** The end of the list comes within reach (or not), for every observer watching it. */
const reach = (isIntersecting: boolean) =>
  act(() => {
    for (const o of live()) o.cb([{ isIntersecting }]);
  });

function List({ total, resetKey = "a" }: { total: number; resetKey?: string }) {
  const list = useIncremental(total, resetKey);
  return (
    <main>
      <div className="doc-grid">
        {Array.from({ length: list.shown }, (_, i) => (
          <a key={i} className="doc-card-title" href={`#${i}`}>
            item {i}
          </a>
        ))}
      </div>
      <MoreItems list={list} />
    </main>
  );
}
const drawn = () => document.querySelectorAll("a.doc-card-title").length;

beforeEach(() => {
  observers = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  window.sessionStorage.clear();
  window.history.replaceState(null, "");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a list drawn a batch at a time", () => {
  it("draws 25, says how many of how many, and the button draws the next batch up to the end", () => {
    expect(BATCH).toBe(25);
    render(<List total={60} />);
    expect(drawn()).toBe(25);
    expect(screen.getByRole("status").textContent).toBe("25 of 60");
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    expect(drawn()).toBe(50);
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more" }));
    expect(drawn()).toBe(60);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("moves focus to the first item the button drew, so a keyboard carries on from there", () => {
    render(<List total={60} />);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    expect(document.activeElement?.textContent).toBe("item 25");
    // The last batch takes the button away; focus still lands on what it drew.
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more" }));
    expect(document.activeElement?.textContent).toBe("item 50");
  });

  it("draws nothing more for a list no longer than one batch", () => {
    render(<List total={25} />);
    expect(drawn()).toBe(25);
    expect(screen.queryByRole("button")).toBeNull();
    expect(live()).toHaveLength(0);
  });

  it("starts again at one batch when its key changes, and keeps its place when only the list does", () => {
    const view = render(<List total={60} resetKey="everything" />);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    expect(drawn()).toBe(50);
    view.rerender(<List total={61} resetKey="everything" />);
    expect(drawn()).toBe(50);
    view.rerender(<List total={61} resetKey="folder:plans" />);
    expect(drawn()).toBe(25);
  });

  it("draws the next batch when the end comes within reach, and again while it is still within reach", () => {
    render(<List total={60} />);
    expect(live()).toHaveLength(1);
    reach(true);
    expect(drawn()).toBe(50);
    // A fresh observer watches after the batch, and reports the end still within reach.
    expect(live()).toHaveLength(1);
    expect(observers.length).toBe(2);
    reach(true);
    expect(drawn()).toBe(60);
    expect(live()).toHaveLength(0);
  });

  it("draws nothing while the end is out of reach, and leaves focus where it was", () => {
    render(<List total={60} />);
    const first = screen.getByText("item 0");
    first.focus();
    reach(false);
    expect(drawn()).toBe(25);
    reach(true);
    expect(drawn()).toBe(50);
    expect(document.activeElement).toBe(first);
  });

  it("without an observer, only the button draws more", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<List total={60} />);
    expect(observers).toHaveLength(0);
    expect(drawn()).toBe(25);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    expect(drawn()).toBe(50);
  });
});

describe("Back returns to the same place in a list", () => {
  /** A list that keeps its place for its history entry, its items landing when `ready`. */
  function Remembered({
    total,
    ready = true,
    resetKey = "everything",
    at = "k1",
  }: {
    total: number;
    ready?: boolean;
    resetKey?: string;
    at?: string;
  }) {
    const list = useIncremental(ready ? total : 0, resetKey, { remember: { at, ready } });
    return (
      <main>
        <div className="doc-grid">
          {Array.from({ length: list.shown }, (_, i) => (
            <a key={i} className="doc-card-title" href={`#${i}`}>
              item {i}
            </a>
          ))}
        </div>
        <MoreItems list={list} />
      </main>
    );
  }
  let scrollTo: ReturnType<typeof vi.spyOn>;
  const scrolledTo = (y: number) => {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    window.dispatchEvent(new Event("scroll"));
  };
  /** The reader drew 50, scrolled down, and opened a document: the list unmounted. */
  const leaveAt50 = (y = 1234) => {
    const first = render(<Remembered total={60} />);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    scrolledTo(y);
    first.unmount();
  };

  beforeEach(() => {
    scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    scrolledTo(0);
  });

  it("draws as much as it had and scrolls back, once its items have landed", () => {
    leaveAt50();
    scrolledTo(0);
    const back = render(<Remembered total={60} ready={false} />);
    expect(scrollTo).not.toHaveBeenCalled();
    back.rerender(<Remembered total={60} ready />);
    expect(drawn()).toBe(50);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 1234);
  });

  it("is not overwritten by where a half-drawn page clamps the scroll", () => {
    leaveAt50();
    const early = render(<Remembered total={60} ready={false} />);
    scrolledTo(40);
    early.unmount();
    render(<Remembered total={60} />);
    expect(scrollTo).toHaveBeenCalledWith(0, 1234);
  });

  it("starts at the top, 25 long, for a new visit", () => {
    leaveAt50();
    window.history.replaceState(null, "");
    render(<Remembered total={60} />);
    expect(drawn()).toBe(25);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("starts at the top for another list in the same entry", () => {
    leaveAt50();
    render(<Remembered total={60} resetKey="folder:plans" />);
    expect(drawn()).toBe(25);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("follows the history entry as the page moves on without unmounting: a new one starts at the top, a returning one where it was", () => {
    const view = render(<Remembered total={60} />);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    scrolledTo(1234);
    const everything = window.history.state;

    // Into a folder: the router pushes a new entry, and the workspace stays mounted.
    window.history.replaceState(null, "");
    view.rerender(<Remembered total={60} resetKey="folder:plans" at="k2" />);
    expect(drawn()).toBe(25);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    scrolledTo(300);

    // Back to Everything.
    window.history.replaceState(everything, "");
    view.rerender(<Remembered total={60} at="k1" />);
    expect(drawn()).toBe(50);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 1234);
  });

  it("after a document opened from a page it moved on to, Back returns to that page's place", () => {
    const view = render(<Remembered total={60} />);
    window.history.replaceState(null, "");
    view.rerender(<Remembered total={60} resetKey="folder:plans" at="k2" />);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    scrolledTo(700);
    const folder = window.history.state;
    view.unmount();

    scrollTo.mockClear();
    window.history.replaceState(folder, "");
    render(<Remembered total={60} resetKey="folder:plans" at="k2" />);
    expect(drawn()).toBe(50);
    expect(scrollTo).toHaveBeenCalledWith(0, 700);
  });
});
