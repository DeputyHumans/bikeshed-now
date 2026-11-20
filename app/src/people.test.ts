// SPDX-License-Identifier: Apache-2.0
// A person is drawn as "First L": from their profile, else from what is in hand, else from their address (ADR 0040).

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetNames, knowName, nameFromEmail, personName, setProfileReader, shortName, usePeople, usePersonName } from "./people";

beforeEach(() => {
  forgetNames();
  setProfileReader(async () => null);
});

describe("shortName", () => {
  it.each([
    ["Pavel Spesivtsev", "Pavel S"],
    ["  Pavel   Spesivtsev  ", "Pavel S"],
    // The first word and the LAST word's initial, not a middle name's.
    ["Mary Jane Watson", "Mary W"],
    ["Ana", "Ana"],
    ["josé álvarez", "josé Á"],
    ["Mary-Jane O'Neil", "Mary-Jane O"],
    ["", ""],
    ["   ", ""],
  ])("%j → %j", (full, short) => {
    expect(shortName(full)).toBe(short);
  });

  it("leaves a short name as it is, so drawing it again changes nothing", () => {
    for (const name of ["Pavel S", "Ana", "Mary W", "josé Á"]) expect(shortName(shortName(name))).toBe(shortName(name));
    expect(shortName("Pavel S")).toBe("Pavel S");
  });

  it("keeps a chip a chip when the first word is very long", () => {
    expect(shortName(`${"a".repeat(50)} B`)).toBe(`${"a".repeat(32)} B`);
  });

  it("takes a whole character for the initial, not half of one", () => {
    expect(shortName("Zoë 𝒜lpha")).toBe("Zoë 𝒜");
  });
});

describe("nameFromEmail", () => {
  it.each([
    ["pavel@deputyhumans.com", "Pavel"],
    ["dana.kim@example.com", "Dana K"],
    ["dana_kim@example.com", "Dana K"],
    ["mary-jane.watson@example.com", "Mary W"],
    ["ana+reviews@example.com", "Ana"],
    ["e2e-owner-17@example.com", "E2e O"],
    // Nothing but digits: the local part as it is, rather than nothing.
    ["12345@example.com", "12345"],
  ])("%j → %j", (email, name) => {
    expect(nameFromEmail(email)).toBe(name);
  });
});

describe("personName", () => {
  it("is the address's when nothing else is known", () => {
    expect(personName({ uid: "u1", email: "dana.kim@example.com" })).toBe("Dana K");
  });

  it("prefers a name in hand to the address's, shortened, and ignores one that is an address", () => {
    expect(personName({ email: "dk@example.com", known: "Dana Kim" })).toBe("Dana K");
    // An older client sent its address as its presence name.
    expect(personName({ email: "dana.kim@example.com", known: "dana.kim@example.com" })).toBe("Dana K");
  });

  it("prefers the profile to anything in hand", () => {
    knowName("u1", "dk@example.com", "Dee Kay");
    expect(personName({ uid: "u1", email: "dk@example.com", known: "Dana Kim" })).toBe("Dee K");
  });

  it("names an address-only record as its profile named that address this session", () => {
    knowName("u1", "dk@example.com", "Dana Kim");
    expect(personName({ email: "dk@example.com" })).toBe("Dana K");
  });
});

describe("usePeople", () => {
  it("reads each uid once, however many ask, and redraws when the name arrives", async () => {
    const read = vi.fn(async (uid: string) => ({ name: uid === "u1" ? "Ana Lima" : "Bo Chen", chosen: false }));
    setProfileReader(read);
    const { result } = renderHook(() => {
      usePeople([
        { uid: "u1", email: "ana@example.com" },
        { uid: "u1", email: "ana@example.com" },
        { uid: "u2", email: "bo@example.com" },
      ]);
      return [usePersonName({ uid: "u1", email: "ana@example.com" }), personName({ uid: "u2", email: "bo@example.com" })];
    });
    // Before the read lands: the address's names.
    expect(result.current).toEqual(["Ana", "Bo"]);
    await waitFor(() => expect(result.current).toEqual(["Ana L", "Bo C"]));
    expect(read.mock.calls.map(([uid]) => uid).sort()).toEqual(["u1", "u2"]);
  });

  it("lets a record that holds only an address use the name its profile answered", async () => {
    setProfileReader(async () => ({ name: "Dana Kim", chosen: false }));
    const { result } = renderHook(() => {
      usePeople([{ uid: "u1", email: "dk@example.com" }]);
      // A draft or a summary: the address alone, no uid.
      return personName({ email: "dk@example.com" });
    });
    expect(result.current).toBe("Dk");
    await waitFor(() => expect(result.current).toBe("Dana K"));
  });

  it("answers a read that fails, or one that throws before it starts, with the address's name", async () => {
    setProfileReader(async () => {
      throw new Error("permission-denied");
    });
    const failed = renderHook(() => usePersonName({ uid: "u1", email: "ana.lima@example.com" }));
    await act(async () => {});
    expect(failed.result.current).toBe("Ana L");
    setProfileReader(() => {
      throw new Error("no database");
    });
    const threw = renderHook(() => usePersonName({ uid: "u2", email: "bo.chen@example.com" }));
    await act(async () => {});
    expect(threw.result.current).toBe("Bo C");
  });

  it("asks again after the account changes, because the last one's answers are not this one's", async () => {
    const read = vi.fn(async () => null);
    setProfileReader(read);
    const first = renderHook(() => usePersonName({ uid: "u1", email: "ana@example.com" }));
    await act(async () => {});
    first.unmount();
    forgetNames();
    renderHook(() => usePersonName({ uid: "u1", email: "ana@example.com" }));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
  });
});
