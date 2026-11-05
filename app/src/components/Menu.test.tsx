// SPDX-License-Identifier: Apache-2.0
// Where a ⋮ menu opens: below its trigger, or above it at the bottom of the window (SPEC §13).

import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, menuPosition } from "./Menu";

/** The window the menu was reported cropped in, and a document card's menu. */
const VIEW = { width: 1232, height: 570 };
const MENU = { width: 200, height: 250 };
const UNSCROLLED = { x: 0, y: 0 };

describe("menuPosition", () => {
  it("opens below its trigger when there is room", () => {
    const pos = menuPosition({ top: 100, bottom: 132, left: 500 }, VIEW, MENU, UNSCROLLED);
    expect(pos).toEqual({ top: 132 + 4, left: 500 });
  });

  it("opens ABOVE a trigger at the bottom of the window", () => {
    // The last card of a list scrolled to its end: below, only "Open" and half
    // of "Share…" were on screen, and scrolling to the rest closes the menu.
    const pos = menuPosition({ top: 518, bottom: 560, left: 520 }, VIEW, MENU, UNSCROLLED);
    expect(pos.top).toBe(518 - 4 - 250);
  });

  it("stays below while it just fits, and flips a pixel later", () => {
    const fits = VIEW.height - 8 - MENU.height - 4;
    expect(menuPosition({ top: fits - 32, bottom: fits, left: 500 }, VIEW, MENU, UNSCROLLED).top).toBe(fits + 4);
    expect(menuPosition({ top: fits - 31, bottom: fits + 1, left: 500 }, VIEW, MENU, UNSCROLLED).top).toBe(fits - 31 - 4 - 250);
  });

  it("fits neither side: stays on screen, over its trigger if it has to", () => {
    const short = { width: VIEW.width, height: 300 };
    // More room below: as far down as keeps its bottom on screen.
    expect(menuPosition({ top: 120, bottom: 152, left: 500 }, short, MENU, UNSCROLLED).top).toBe(300 - 8 - 250);
    // More room above: against the top edge.
    expect(menuPosition({ top: 170, bottom: 202, left: 500 }, short, MENU, UNSCROLLED).top).toBe(8);
  });

  it("keeps its top on screen when it is taller than the window", () => {
    const tiny = { width: VIEW.width, height: 200 };
    expect(menuPosition({ top: 150, bottom: 182, left: 500 }, tiny, MENU, UNSCROLLED).top).toBe(8);
  });

  it("answers in document coordinates", () => {
    const pos = menuPosition({ top: 518, bottom: 560, left: 520 }, VIEW, MENU, { x: 30, y: 1200 });
    expect(pos).toEqual({ top: 1200 + 518 - 4 - 250, left: 30 + 520 });
  });

  it("clamps to the left and right edges", () => {
    expect(menuPosition({ top: 100, bottom: 132, left: 0 }, VIEW, MENU, UNSCROLLED).left).toBe(8);
    expect(menuPosition({ top: 100, bottom: 132, left: 1200 }, VIEW, MENU, UNSCROLLED).left).toBe(VIEW.width - MENU.width - 8);
  });
});

describe("Menu", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens where its trigger is from inside something positioned, however far the page has scrolled", () => {
    // In the sticky header, document coordinates opened it lower by the page's scroll.
    const root = document.documentElement;
    vi.spyOn(root, "clientWidth", "get").mockReturnValue(402);
    vi.spyOn(root, "clientHeight", "get").mockReturnValue(714);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(900);
    const host = document.createElement("div");
    document.body.append(host);
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(host);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // The header, at the top of the window; its trigger inside it.
      const box = this === host ? { top: 0, bottom: 61, left: 0, right: 402 } : { top: 8, bottom: 52, left: 340, right: 384 };
      return { ...box, width: box.right - box.left, height: box.bottom - box.top, x: box.left, y: box.top, toJSON: () => ({}) };
    });
    const { getByRole } = render(
      <Menu label="Menu" entries={[{ id: "a", label: "A" }]} trigger={(props) => <button {...props}>Open</button>} />,
      { container: host },
    );
    fireEvent.click(getByRole("button", { name: "Open" }));
    expect((host.querySelector(".menu") as HTMLElement).style.top).toBe("56px");
    host.remove();
  });

  it("closes on a tap outside it that lands on its backdrop, as a tap on the document must", () => {
    const root = document.documentElement;
    vi.spyOn(root, "clientWidth", "get").mockReturnValue(402);
    vi.spyOn(root, "clientHeight", "get").mockReturnValue(714);
    const { getByRole, container, queryByRole } = render(
      <Menu label="Menu" entries={[{ id: "a", label: "A" }]} trigger={(props) => <button {...props}>Open</button>} />,
    );
    fireEvent.click(getByRole("button", { name: "Open" }));
    expect(queryByRole("menu")).toBeTruthy();
    fireEvent.click(container.querySelector(".menu-backdrop") as HTMLElement);
    expect(queryByRole("menu")).toBeNull();
  });

  /** A document card's menu, its trigger 10px from the bottom of the window. */
  function openAtBottom() {
    // jsdom lays nothing out, so the window, the trigger's box and the menu's
    // height are stubbed: without the measured height, everything "fits" below.
    const root = document.documentElement;
    vi.spyOn(root, "clientWidth", "get").mockReturnValue(VIEW.width);
    vi.spyOn(root, "clientHeight", "get").mockReturnValue(VIEW.height);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("menu") ? MENU.height : 0;
    });
    const view = render(
      <Menu
        label="Actions for a document"
        entries={[{ id: "open", label: "Open" }, { id: "share", label: "Share…" }]}
        trigger={(props) => (
          <button {...props} type="button">
            Actions
          </button>
        )}
      />,
    );
    const trigger = view.getByRole("button", { name: "Actions" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(520, 518, 42, 42));
    return { ...view, trigger };
  }

  it("measures itself, so a menu opened at the bottom of the window opens upward", () => {
    const { getByRole, trigger } = openAtBottom();
    fireEvent.click(trigger);
    expect(getByRole("menu").style.top).toBe(`${518 - 4 - 250}px`);
  });

  it("is in place before its first item takes focus", () => {
    // Focus scrolls whatever it lands on into view, and a scroll closes the
    // menu. Focused where it was first drawn, at the top of the document, the
    // menu sent a scrolled list back to the top and closed on the way.
    const { trigger } = openAtBottom();
    const focusedAt: string[] = [];
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      if (this.classList.contains("menu-item")) focusedAt.push(this.closest<HTMLElement>(".menu")!.style.top);
      focus.call(this, options);
    });
    fireEvent.click(trigger);
    expect(focusedAt).toEqual([`${518 - 4 - 250}px`]);
  });
});
