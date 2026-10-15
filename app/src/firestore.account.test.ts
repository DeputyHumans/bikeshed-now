// SPDX-License-Identifier: Apache-2.0
// Deployment marking seeds an absent account preference transactionally and never replaces a person's choice (SPEC §20).

import { beforeEach, expect, it, vi } from "vitest";
import { seedDefaultMarking, watchUser } from "./firestore";

const store = vi.hoisted(() => ({ exists: true, data: {} as Record<string, unknown>, set: vi.fn(), fail: null as null | (() => void) }));
vi.mock("./firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", async (load) => ({
  ...await load<typeof import("firebase/firestore")>(),
  doc: (_db: unknown, collection: string, uid: string) => ({ path: `${collection}/${uid}` }),
  serverTimestamp: () => "server-time",
  runTransaction: async (_db: unknown, body: (tx: unknown) => unknown) => body({
    get: async () => ({ exists: () => store.exists, data: () => store.data }),
    set: store.set,
  }),
  onSnapshot: (_ref: unknown, _receive: unknown, fail: () => void) => { store.fail = fail; return () => {}; },
}));
beforeEach(() => { store.exists = true; store.data = {}; store.set.mockClear(); });
const marking = { enabled: true, label: "Default", footer: "Footer" };

it("uses the transaction's current record and preserves both explicit off and a different saved marking", async () => {
  for (const choice of [{ enabled: false, label: "", footer: "" }, { enabled: true, label: "My choice", footer: "Custom" }]) {
    store.data = { defaultMarking: choice };
    await seedDefaultMarking("one", "one@example.com", marking);
    expect(store.set).not.toHaveBeenCalled();
  }
  store.data = {};
  await seedDefaultMarking("one", "one@example.com", marking);
  expect(store.set).toHaveBeenCalledWith({ path: "users/one" }, { uid: "one", email: "one@example.com", defaultMarking: marking, updatedAt: "server-time" }, { merge: true });
  store.set.mockClear();
  store.exists = false;
  await seedDefaultMarking("two", "two@example.com", marking);
  expect(store.set).toHaveBeenCalledTimes(1);
});

it("distinguishes an unreadable preference from an absent record when the caller must fail closed", () => {
  const receive = vi.fn();
  const fail = vi.fn();
  watchUser("one", receive, fail);
  store.fail?.();
  expect(fail).toHaveBeenCalledTimes(1);
  expect(receive).not.toHaveBeenCalled();
  watchUser("one", receive);
  store.fail?.();
  expect(receive).toHaveBeenCalledWith(null);
});
