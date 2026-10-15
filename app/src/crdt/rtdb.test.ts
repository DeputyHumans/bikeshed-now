// SPDX-License-Identifier: Apache-2.0
// Atomic log retirement retains seed dependencies whenever an update races publication (SPEC §6b, §16).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLog, rtdbLog } from "./rtdb";

const calls = vi.hoisted(() => ({
  transaction: vi.fn(), get: vi.fn(), onValue: vi.fn(), onChildAdded: vi.fn(), push: vi.fn(), update: vi.fn(),
}));
vi.mock("../firebase", () => ({ rtdb: {} }));
vi.mock("firebase/database", () => ({
  ref: (_db: unknown, path: string) => path,
  runTransaction: calls.transaction,
  get: calls.get, onChildAdded: calls.onChildAdded, onValue: calls.onValue, push: calls.push, update: calls.update,
}));

beforeEach(() => { vi.clearAllMocks(); });

describe("clearLog", () => {
  it("retires exactly the applied seed and updates captured before the published snapshot", async () => {
    const consumed = { _seed: "seed", first: "one" };
    const decisions: unknown[] = [];
    calls.transaction.mockImplementationOnce(async (_path, decide) => {
      decisions.push(decide({ first: "one", _seed: "seed" }));
    });
    await clearLog("d1", consumed, "retired");
    expect(calls.transaction).toHaveBeenCalledWith("status/d1/y/retired", expect.any(Function), { applyLocally: false });
    expect(decisions).toEqual([null]);
  });

  it("starts an empty-cache CAS but keeps the complete seed when the server supplies a raced update", async () => {
    const decisions: unknown[] = [];
    calls.transaction.mockImplementationOnce(async (_path, decide) => {
      decisions.push(decide({ _seed: "seed", first: "one", later: "depends on seed" }));
      decisions.push(decide({ _seed: "different seed", first: "one" }));
      decisions.push(decide(null));
    });
    await clearLog("d1", { _seed: "seed", first: "one" }, "initial");
    expect(decisions).toEqual([undefined, undefined, null]);
  });

  it("does not attempt retirement when this editor applied no shared updates", async () => {
    await clearLog("d1", {}, "initial");
    expect(calls.transaction).not.toHaveBeenCalled();
  });
});

it("scopes every transport operation to the captured epoch and forwards listener refusal", async () => {
  let ready!: () => void;
  calls.onValue.mockImplementation((_path, receive) => { ready = receive; return vi.fn(); });
  calls.transaction.mockResolvedValue({ snapshot: { val: () => "seed" } });
  calls.push.mockResolvedValue({ key: "new-entry" });
  const log = rtdbLog("d1", "captured")!;
  ready(); await log.ready();
  const receive = vi.fn(), failure = vi.fn();
  log.subscribe(receive, failure);
  await log.initialize("proposal"); await log.append("delta"); await log.remove(["old"]);
  expect(calls.onValue.mock.calls[0][0]).toBe("status/d1/y/captured");
  expect(calls.onChildAdded).toHaveBeenCalledWith("status/d1/y/captured", expect.any(Function), failure);
  calls.onChildAdded.mock.calls[0][2](new Error("denied"));
  expect(failure).toHaveBeenCalledOnce();
  expect(calls.transaction.mock.calls[0][0]).toBe("status/d1/y/captured/_seed");
  expect(calls.push).toHaveBeenCalledWith("status/d1/y/captured", "delta");
  expect(calls.update).toHaveBeenCalledWith("status/d1/y/captured", { old: null });
  expect(calls.get).not.toHaveBeenCalled();
});
it("refuses legacy flat entries without mistaking nested retired epochs for them", async () => {
  let ready!: () => void;
  calls.onValue.mockImplementation((_path, receive) => { ready = receive; return vi.fn(); });
  calls.get.mockResolvedValueOnce({ val: () => ({ old: "legacy bytes", initial: { _seed: "new" } }) });
  const legacy = rtdbLog("d1")!; ready();
  await expect(legacy.ready()).rejects.toThrow(/legacy/);
  expect(calls.get).toHaveBeenCalledWith("status/d1/y");
  calls.get.mockResolvedValueOnce({ val: () => ({ retired: { old: "bytes" } }) });
  const nested = rtdbLog("d1")!; ready();
  await expect(nested.ready()).resolves.toBeUndefined();
});
