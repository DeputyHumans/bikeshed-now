// SPDX-License-Identifier: Apache-2.0
// Your profile follows your sign-in name until you choose one, and a chosen one is never replaced (ADR 0040).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileRecord } from "./types";

const store = vi.hoisted(() => ({
  profile: null as ProfileRecord | null,
  saved: [] as { name?: string; chosen: boolean }[],
}));

vi.mock("./firestore", () => ({
  readProfile: async () => store.profile,
  saveProfile: async (_uid: string, profile: { name?: string; chosen: boolean }) => {
    store.saved.push(profile);
  },
}));

import { chooseName, syncSignInName } from "./profiles";
import { forgetNames, personName } from "./people";

const me = { uid: "u-me", email: "pavel@example.com" };

beforeEach(() => {
  forgetNames();
  store.profile = null;
  store.saved = [];
});

describe("on every load", () => {
  it("saves the short form of the sign-in name when there is no profile yet", async () => {
    await syncSignInName(me.uid, me.email, "Pavel Spesivtsev");
    expect(store.saved).toEqual([{ name: "Pavel S", chosen: false }]);
    expect(personName(me)).toBe("Pavel S");
  });

  it("follows a sign-in name that changed, while nobody chose one", async () => {
    store.profile = { name: "Pavel S", chosen: false };
    await syncSignInName(me.uid, me.email, "Paul Smith");
    expect(store.saved).toEqual([{ name: "Paul S", chosen: false }]);
  });

  it("writes nothing when the stored name already matches", async () => {
    store.profile = { name: "Pavel S", chosen: false };
    await syncSignInName(me.uid, me.email, "Pavel Spesivtsev");
    expect(store.saved).toEqual([]);
  });

  it("never replaces a name chosen on Account, and draws that one", async () => {
    store.profile = { name: "Pasha", chosen: true };
    await syncSignInName(me.uid, me.email, "Pavel Spesivtsev");
    expect(store.saved).toEqual([]);
    expect(personName(me)).toBe("Pasha");
  });

  it("writes nothing for a sign-in that gives no name, and draws the address's", async () => {
    await syncSignInName(me.uid, me.email, null);
    expect(store.saved).toEqual([]);
    expect(personName(me)).toBe("Pavel");
  });
});

describe("the name chosen on Account", () => {
  it("is kept short and marked chosen", async () => {
    expect(await chooseName(me.uid, me.email, "  Pavel   Spesivtsev ", "Pavel Spesivtsev")).toBe("Pavel S");
    expect(store.saved).toEqual([{ name: "Pavel S", chosen: true }]);
  });

  it("emptied, goes back to the sign-in name, no longer chosen", async () => {
    expect(await chooseName(me.uid, me.email, "", "Pavel Spesivtsev")).toBe("Pavel S");
    expect(store.saved).toEqual([{ name: "Pavel S", chosen: false }]);
  });

  it("emptied with no sign-in name, keeps no name, and the address's is drawn", async () => {
    expect(await chooseName(me.uid, me.email, "   ", null)).toBeNull();
    expect(store.saved).toEqual([{ name: undefined, chosen: false }]);
    expect(personName(me)).toBe("Pavel");
  });
});
