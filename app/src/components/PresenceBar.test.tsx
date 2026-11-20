// SPDX-License-Identifier: Apache-2.0
// The presence bar: short names on one line, the rest folded into "+N" (SPEC §16, ADR 0040).

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

  test("unmeasured (jsdom): every chip shows its short name, none is folded, and +N is idle", () => {
    const { container } = render(<PresenceBar peers={PEERS} following={null} onToggleFollow={() => {}} />);
    const chips = Array.from(container.querySelectorAll(".presence-chip"));
    // The first name and the last name's initial, whatever the presence record carried.
    expect(chips.map((chip) => chip.querySelector(".presence-name")?.textContent)).toEqual(["Victoria A", "Bartholomew O", "Chen W", "Dolores H"]);
    // The address is the tooltip's second line: what tells two of a name apart.
    expect((chips[0] as HTMLElement).title.split("\n")).toEqual(["Follow Victoria A's scrolling", "a@example.com"]);
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
    expect(more.title).toBe("Chen W, Dolores H");
  });

  test("the +N list names every folded person, says who is editing, and following one is the same as clicking their chip", () => {
    layOut(300);
    const onToggleFollow = vi.fn();
    render(<PresenceBar peers={PEERS} following={null} onToggleFollow={onToggleFollow} />);
    fireEvent.click(screen.getByRole("button", { name: "2 more people here" }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Follow Chen W", "Follow Dolores H (editing)"]);
    expect(items[1].querySelector(".presence-dot")?.getAttribute("data-mode")).toBe("edit");
    fireEvent.click(items[1]);
    expect(onToggleFollow).toHaveBeenCalledWith("d");
  });

  test("following someone who is folded: +N says so, and the list offers to stop", () => {
    layOut(300);
    render(<PresenceBar peers={PEERS} following="c" onToggleFollow={() => {}} />);
    const more = screen.getByRole("button", { name: "2 more people here, following Chen W" });
    expect(more.hasAttribute("data-following")).toBe(true);
    fireEvent.click(more);
    expect(screen.getAllByRole("menuitem")[0].textContent).toBe("Stop following Chen W");
  });

  test("one person folded is a person, not people", () => {
    // Two chips need 240 (jsdom has no stylesheet, so no gap); 200 holds +N and one.
    layOut(200);
    const { container } = render(<PresenceBar peers={PEERS.slice(0, 2)} following={null} onToggleFollow={() => {}} />);
    expect(container.querySelector(".presence-more")?.getAttribute("aria-label")).toBe("1 more person here");
  });

  test("someone following this reader: an eye read aloud as Following you, a wash of their colour, a title that says so, and nobody else is marked", () => {
    const peers = [peer("a", "Ana Lima"), { ...peer("b", "Bo Chen"), followsYou: true as const }];
    render(<PresenceBar peers={peers} following={null} onToggleFollow={() => {}} />);
    const bo = screen.getByRole("button", { name: "Bo C Following you" });
    expect(bo.hasAttribute("data-follows-you")).toBe(true);
    expect(bo.title).toBe("Bo C is following you. Follow Bo C's scrolling\nb@example.com");
    const ana = screen.getByRole("button", { name: "Ana L" });
    expect(ana.hasAttribute("data-follows-you")).toBe(false);
    expect(ana.querySelector('[aria-label="Following you"]')).toBeNull();
    expect(ana.title).toBe("Follow Ana L's scrolling\na@example.com");
  });

  test("followers come first, so a fold hides them last, and everyone else keeps their order", () => {
    const peers = [peer("a", "Ana"), peer("b", "Bo"), { ...peer("c", "Cy"), followsYou: true as const }, peer("d", "Di"), { ...peer("e", "Ed"), followsYou: true as const }];
    layOut(300);
    const { container } = render(<PresenceBar peers={peers} following={null} onToggleFollow={() => {}} />);
    const chips = Array.from(container.querySelectorAll(".presence-chip"));
    expect(chips.map((chip) => chip.querySelector(".presence-name")?.textContent)).toEqual(["Cy", "Ed", "Ana", "Bo", "Di"]);
    expect(chips.map((chip) => chip.hasAttribute("data-folded"))).toEqual([false, false, true, true, true]);
  });

  test("the follower's own chip tells them the person they follow can see it", () => {
    render(<PresenceBar peers={[peer("a", "Ana Lima")]} following="a" onToggleFollow={() => {}} />);
    expect(screen.getByRole("button", { name: "Ana L" }).title).toBe("Following Ana L, who can see that you are. Scroll to stop.\na@example.com");
  });

  test("a follower folded anyway is named so in the +N list, beside editing", () => {
    // Three followers of 120 in 300: +N and two fit, the third folds.
    const peers = [
      { ...peer("a", "Ana"), followsYou: true as const },
      { ...peer("b", "Bo"), followsYou: true as const },
      { ...peer("c", "Cy", "edit"), followsYou: true as const },
      peer("d", "Di"),
    ];
    layOut(300);
    render(<PresenceBar peers={peers} following={null} onToggleFollow={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "2 more people here" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Follow Cy (editing, following you)", "Follow Di"]);
  });

  test("a chip that gains the eye is measured again, so the bar folds rather than overflowing", () => {
    // The eye widens a chip by 18; nothing else about Bo changes, not even his place.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("presence-chip")) return this.hasAttribute("data-follows-you") ? 138 : 120;
      if (this.classList.contains("presence-more")) return 44;
      return 0;
    });
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("presence-bar") ? 250 : 0;
    });
    const { container, rerender } = render(<PresenceBar peers={[peer("b", "Bo"), peer("a", "Ana")]} following={null} onToggleFollow={() => {}} />);
    const folded = () => Array.from(container.querySelectorAll(".presence-chip")).map((chip) => chip.hasAttribute("data-folded"));
    expect(folded()).toEqual([false, false]);
    rerender(<PresenceBar peers={[{ ...peer("b", "Bo"), followsYou: true }, peer("a", "Ana")]} following={null} onToggleFollow={() => {}} />);
    expect(folded()).toEqual([false, true]);
  });
});
