// SPDX-License-Identifier: Apache-2.0
// Atomic log retirement retains seed dependencies whenever an update races publication (SPEC §6b, §16).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLog } from "./rtdb";

const calls = vi.hoisted(() => ({
  transaction: vi.fn(),
}));
vi.mock("../firebase", () => ({ rtdb: {} }));
vi.mock("firebase/database", () => ({
  ref: (_db: unknown, path: string) => path,
  runTransaction: calls.transaction,
  onChildAdded: vi.fn(), onValue: vi.fn(), push: vi.fn(), update: vi.fn(),
}));

beforeEach(() => { vi.clearAllMocks(); });

describe("clearLog", () => {
  it("retires exactly the applied seed and updates captured before the published snapshot", async () => {
    const consumed = { _seed: "seed", first: "one" };
    const decisions: unknown[] = [];
    calls.transaction.mockImplementationOnce(async (_path, decide) => {
      decisions.push(decide({ first: "one", _seed: "seed" }));
    });
    await clearLog("d1", consumed);
    expect(calls.transaction).toHaveBeenCalledWith("status/d1/y", expect.any(Function), { applyLocally: false });
    expect(decisions).toEqual([null]);
  });

  it("keeps the complete seed and update history when a new delta races publication", async () => {
    const decisions: unknown[] = [];
    calls.transaction.mockImplementationOnce(async (_path, decide) => {
      decisions.push(decide({ _seed: "seed", first: "one", later: "depends on seed" }));
      decisions.push(decide({ _seed: "different seed", first: "one" }));
      decisions.push(decide(null));
    });
    await clearLog("d1", { _seed: "seed", first: "one" });
    expect(decisions).toEqual([undefined, undefined, undefined]);
  });

  it("does not attempt retirement when this editor applied no shared updates", async () => {
    await clearLog("d1", {});
    expect(calls.transaction).not.toHaveBeenCalled();
  });
});
