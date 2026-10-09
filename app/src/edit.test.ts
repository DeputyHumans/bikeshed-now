// SPDX-License-Identifier: Apache-2.0
// Each refused publish names its own next step (SPEC §6a).

import { afterEach, describe, expect, test, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, post };
});

import { ConflictError } from "./api";
import {
  publishSaved,
  PendingSuggestionsError,
  StaleVersionError,
  UnresolvedCommentsError,
  commitVersion,
} from "./edit";

afterEach(() => post.mockReset());

describe("commitVersion", () => {
  test("pending suggestions are their own refusal, though they are open threads too", async () => {
    post.mockRejectedValueOnce(
      new ConflictError("refused", { unresolvedCount: 3, pendingSuggestions: 2 }),
    );
    const err = await commitVersion("d1", "v1").catch((e) => e);
    expect(err).toBeInstanceOf(PendingSuggestionsError);
    expect(err.message).toBe(
      "2 suggested edits are waiting. Only the owner or an approver can accept or reject them.",
    );
  });

  test("open comments alone are still the comment refusal", async () => {
    post.mockRejectedValueOnce(
      new ConflictError("refused", { unresolvedCount: 3, pendingSuggestions: 0 }),
    );
    await expect(commitVersion("d1", "v1")).rejects.toBeInstanceOf(UnresolvedCommentsError);
  });

  test("a server that does not send the count is read as no suggestions", async () => {
    post.mockRejectedValueOnce(new ConflictError("refused", { unresolvedCount: 1 }));
    await expect(commitVersion("d1", "v1")).rejects.toBeInstanceOf(UnresolvedCommentsError);
  });

  test("a newer version is still the stale refusal", async () => {
    post.mockRejectedValueOnce(new ConflictError("refused", { currentVersion: "v2" }));
    await expect(commitVersion("d1", "v1")).rejects.toBeInstanceOf(StaleVersionError);
  });
});

describe("publishSaved: the draft is saved, then published, never the one before", () => {
  const result = { versionId: "v2", contentHash: "h", fileCount: 1, bytes: 1, deduped: false };

  test("publishes nothing when the save before it fails", async () => {
    const commit = vi.fn(async () => result);
    expect(await publishSaved(async () => false, commit)).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  test("publishes once the save goes through, whatever an earlier save did", async () => {
    // Refusing on the LAST save's failure without trying again left no way
    // out but typing something to make the editor save.
    const commit = vi.fn(async () => result);
    expect(await publishSaved(async () => true, commit)).toBe(result);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
