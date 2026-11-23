// SPDX-License-Identifier: Apache-2.0
// Who else is on which slide, by the answer following uses, and unchanged by a cursor moving (SPEC §6d, §16).

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Peer } from "../presence";
import { scanSlides } from "./deck";
import { useRailPeople } from "./railPeople";

const doc = new DOMParser().parseFromString(
  `<body><main>${[1, 2, 3].map((n) => `<section class="slide" id="s${n}"><h2>Slide ${n}</h2></section>`).join("")}</main></body>`,
  "text/html",
);
const scan = scanSlides(doc);
const slides = scan.kind === "slides" ? scan.slides : [];

const peer = (uid: string, extra: Partial<Peer>): Peer => ({
  uid, email: `${uid}@example.com`, name: uid === "u1" ? "Dana Kim" : "Sam Park", mode: "view", lastChanged: 1, color: "#7c3aed", ...extra,
});

describe("useRailPeople", () => {
  it("puts each person on their slide, by their slide or else their place, and nobody on no slide", () => {
    const { result } = renderHook(() =>
      useRailPeople([peer("u1", { slide: 2 }), peer("u2", { place: { a: "s2", at: 0 } }), peer("u3", { viewport: 0 })], slides, doc),
    );
    expect([...result.current.entries()].map(([slide, people]) => [slide, people.map((p) => p.name)])).toEqual([
      [2, ["Dana K"]],
      [1, ["Sam P"]],
    ]);
  });

  it("is the same map after an update that moves nobody, and a new one when somebody moves", () => {
    const { result, rerender } = renderHook(({ peers }) => useRailPeople(peers, slides, doc), {
      initialProps: { peers: [peer("u1", { slide: 0 })] },
    });
    const first = result.current;
    const focus = { elementId: "s1", exact: "Slide", prefix: "", suffix: " 1", start: 0, end: 5 };
    rerender({ peers: [peer("u1", { slide: 0, focus, viewport: 0.3, lastChanged: 2 })] });
    expect(result.current).toBe(first);
    rerender({ peers: [peer("u1", { slide: 1, focus })] });
    expect(result.current).not.toBe(first);
    expect([...result.current.keys()]).toEqual([1]);
    rerender({ peers: [peer("u1", { slide: 1, mode: "edit" })] });
    expect(result.current.get(1)?.[0].mode).toBe("edit");
  });
});
