// SPDX-License-Identifier: Apache-2.0
// The presence bar: whole names on one line, the rest folded into "+N" (SPEC §16).

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PresenceBar } from "./PresenceBar";
import { chipsThatFit } from "./presenceFit";
import type { Peer } from "../presence";

const peer = (uid: string, name: string, mode: Peer["mode"] = "view"): Peer => ({
  uid,
  email: `${uid}@example.com`,
  name,
  mode,
  lastChanged: 0,
  color: "#7c3aed",
});

const PEERS = [
  peer("a", "Victoria Aleinikova"),
  peer("b", "Bartholomew Okonkwo-Lindqvist"),
  peer("c", "Chen Wei"),
  peer("d", "Dolores Haze", "edit"),
];

describe("chipsThatFit", () => {
  test("everyone fits: every chip is shown and the +N button needs no room", () => {
    expect(chipsThatFit([100, 100], 4, 204, 44)).toBe(2);
  });

  test("one pixel short: the +N button takes its room and the chips that still fit beside it are shown", () => {
    // 44 for +N, then 100 + 4 fits (148), and a second 104 would make 252.
    expect(chipsThatFit([100, 100], 4, 203, 44)).toBe(1);
  });

  test("the +N button's room comes out of the chips': two fit in 250 on their own, but only one beside +N", () => {
    // Whole: 3 × 100 + 2 × 4 = 308. With +N: 44 + 104 = 148, and 148 + 104 = 252.
    expect(chipsThatFit([100, 100, 100], 4, 250, 44)).toBe(1);
  });

  test("the gaps count: three chips fit exactly, and one pixel less folds the last", () => {
    expect(chipsThatFit([50, 50, 50], 10, 170, 44)).toBe(3);
    expect(chipsThatFit([50, 50, 50], 10, 169, 44)).toBe(2);
  });

  test("a single name too long for the room folds into +N rather than being cut", () => {
    expect(chipsThatFit([300], 4, 200, 44)).toBe(0);
  });

  test("a bar that has not been laid out shows everyone rather than folding everyone", () => {
    expect(chipsThatFit([100, 100, 100], 4, 0, 44)).toBe(3);
  });
});

describe("PresenceBar", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Lays the bar out as a browser would: chips 120 wide, +N 44, in a bar `room` wide. */
  function layOut(room: number) {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("presence-chip")) return 120;
      if (this.classList.contains("presence-more")) return 44;
      return 0;
    });
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("presence-bar") ? room : 0;
    });
  }

  test("nobody here: no bar", () => {
    const { container } = render(<PresenceBar peers={[]} following={null} onToggleFollow={() => {}} />);
    expect(container.querySelector(".presence-bar")).toBeNull();
  });

  test("unmeasured (jsdom): every chip shows its whole name, none is folded, and +N is idle", () => {
    const { container } = render(<PresenceBar peers={PEERS} following={null} onToggleFollow={() => {}} />);
    const chips = Array.from(container.querySelectorAll(".presence-chip"));
    expect(chips.map((chip) => chip.querySelector(".presence-name")?.textContent)).toEqual(PEERS.map((p) => p.name));
    expect(chips.filter((chip) => chip.hasAttribute("data-folded"))).toHaveLength(0);
    expect(container.querySelector(".presence-more")?.hasAttribute("data-idle")).toBe(true);
  });

  test("too many for the room: the ones that fit are shown, the rest stay in the page folded, and +N counts and lists them", () => {
    // 4 chips of 120 need 480; in 300, +N (44) leaves room for two: 44 + 124 + 124 = 292.
    layOut(300);
    const { container } = render(<PresenceBar peers={PEERS} following={null} onToggleFollow={() => {}} />);
    const chips = Array.from(container.querySelectorAll(".presence-chip"));
    expect(chips).toHaveLength(4);
    expect(chips.map((chip) => chip.hasAttribute("data-folded"))).toEqual([false, false, true, true]);
    const more = container.querySelector(".presence-more") as HTMLButtonElement;
    expect(more.hasAttribute("data-idle")).toBe(false);
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("aria-label")).toBe("2 more people here");
    expect(more.title).toBe("Chen Wei, Dolores Haze");
  });

  test("the +N list names every folded person, says who is editing, and following one is the same as clicking their chip", () => {
    layOut(300);
    const onToggleFollow = vi.fn();
    render(<PresenceBar peers={PEERS} following={null} onToggleFollow={onToggleFollow} />);
    fireEvent.click(screen.getByRole("button", { name: "2 more people here" }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Follow Chen Wei", "Follow Dolores Haze (editing)"]);
    expect(items[1].querySelector(".presence-dot")?.getAttribute("data-mode")).toBe("edit");
    fireEvent.click(items[1]);
    expect(onToggleFollow).toHaveBeenCalledWith("d");
  });

  test("following someone who is folded: +N says so, and the list offers to stop", () => {
    layOut(300);
    render(<PresenceBar peers={PEERS} following="c" onToggleFollow={() => {}} />);
    const more = screen.getByRole("button", { name: "2 more people here, following Chen Wei" });
    expect(more.hasAttribute("data-following")).toBe(true);
    fireEvent.click(more);
    expect(screen.getAllByRole("menuitem")[0].textContent).toBe("Stop following Chen Wei");
  });

  test("one person folded is a person, not people", () => {
    // Two chips need 240 (jsdom has no stylesheet, so no gap); 200 holds +N and one.
    layOut(200);
    const { container } = render(<PresenceBar peers={PEERS.slice(0, 2)} following={null} onToggleFollow={() => {}} />);
    expect(container.querySelector(".presence-more")?.getAttribute("aria-label")).toBe("1 more person here");
  });
});
