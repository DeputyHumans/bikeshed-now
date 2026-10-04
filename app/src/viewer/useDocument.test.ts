// SPDX-License-Identifier: Apache-2.0
// An unlisted document tells a reader without its key nothing (SPEC §17).

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicDoc } from "../types";

// Every read the hook makes is stubbed here, never through the environment:
// Vitest loads app/.env.local, and ambient config must not decide a test.
const firestore = vi.hoisted(() => ({
  watchDoc: vi.fn(),
  getPublicDoc: vi.fn(),
  getVersion: vi.fn(),
  listVersions: vi.fn(),
}));
const visibility = vi.hoisted(() => ({ unlockDoc: vi.fn() }));

vi.mock("../firestore", () => firestore);
vi.mock("../visibility", () => visibility);

import { useDocument, type ReaderAccess } from "./useDocument";

const KEY = "tok_0123456789abcdefghijk";

const MEMO: PublicDoc = {
  docId: "memo",
  title: "Build estimate",
  slug: "memo",
  currentVersion: "v1",
  entry: "index.html",
  format: "html",
  visibility: "unlisted",
  publicEdit: false,
  trusted: false,
  expiresAt: null,
};

/** Whoever is asking, the full record is refused: nobody here is a member. */
function refuseTheRecord() {
  firestore.watchDoc.mockImplementation(
    (_id: string, _onData: unknown, onError?: (e: Error) => void) => {
      queueMicrotask(() => onError?.(new Error("permission-denied")));
      return () => {};
    },
  );
}

function open(access: ReaderAccess) {
  return renderHook((props: ReaderAccess) => useDocument("memo", undefined, props), {
    initialProps: access,
  });
}

describe("useDocument for a reader who is not a member", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refuseTheRecord();
    firestore.getVersion.mockResolvedValue(null);
    firestore.listVersions.mockResolvedValue([]);
    // The rules refuse an unlisted row and an absent id alike.
    firestore.getPublicDoc.mockResolvedValue(null);
    visibility.unlockDoc.mockResolvedValue(null);
  });

  it("shows an anonymous reader without the key nothing, and never asks to unlock", async () => {
    const { result } = open({ k: "", uid: null, settled: true });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.title).toBe("");
    expect(result.current.currentVersion).toBe("");
    expect(visibility.unlockDoc).not.toHaveBeenCalled();
  });

  it("unlocks with the key from the link", async () => {
    visibility.unlockDoc.mockResolvedValue(MEMO);
    const { result } = open({ k: KEY, uid: null, settled: true });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(false);
    expect(result.current.title).toBe("Build estimate");
    expect(result.current.currentVersion).toBe("v1");
    expect(visibility.unlockDoc).toHaveBeenCalledWith("memo", KEY);
  });

  it("shows nothing for a wrong key, exactly as for no key", async () => {
    const { result } = open({ k: "tok_wrong_wrong_wrong_wr", uid: null, settled: true });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.title).toBe("");
  });

  it("lets a signed-in reader holding a grant in without the key", async () => {
    // A reply notification links to the document without its key.
    visibility.unlockDoc.mockImplementation(async (_id: string, k: string | null) =>
      k === null ? MEMO : null,
    );
    const { result } = open({ k: "", uid: "u-granted", settled: true });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.title).toBe("Build estimate");
    expect(visibility.unlockDoc).toHaveBeenCalledWith("memo", null);
  });

  it("reads nothing without a key until auth has decided who is asking", async () => {
    open({ k: "", uid: null, settled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(firestore.watchDoc).not.toHaveBeenCalled();
    expect(firestore.getPublicDoc).not.toHaveBeenCalled();
    expect(visibility.unlockDoc).not.toHaveBeenCalled();
  });

  it("opens a key holder's document before auth has decided, which on a phone may be never", async () => {
    /**
     * On every mobile browser and Safari, Firebase Auth loads Google's sign-in
     * script before it reports anyone. While that script stalled, a key holder
     * sat on "Opening the document" indefinitely; desktop Chrome, which skips
     * the step, opened the same link at once. The key is checked by /unlock
     * alone, so nothing it opens should wait for auth.
     */
    visibility.unlockDoc.mockResolvedValue(MEMO);
    const { result } = open({ k: KEY, uid: null, settled: false });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.title).toBe("Build estimate");
    expect(result.current.notFound).toBe(false);
    expect(visibility.unlockDoc).toHaveBeenCalledWith("memo", KEY);
    // Firestore still waits: who is reading decides what it may read.
    expect(firestore.watchDoc).not.toHaveBeenCalled();
  });

  it("asks once for a key holder auth then finds anonymous", async () => {
    visibility.unlockDoc.mockResolvedValue(MEMO);
    const { result, rerender } = open({ k: KEY, uid: null, settled: false });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ k: KEY, uid: null, settled: true });
    await waitFor(() => expect(firestore.watchDoc).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    expect(visibility.unlockDoc).toHaveBeenCalledTimes(1);
    expect(result.current.title).toBe("Build estimate");
  });

  it("does not say a refused key is not here while the member read is unanswered", async () => {
    // Firestore that never answers: a member with a stale key in their link
    // must not be told "not here" by the unlock alone.
    firestore.watchDoc.mockImplementation(() => () => {});
    const { result } = open({ k: "tok_stale_stale_stale_st", uid: null, settled: true });

    await waitFor(() => expect(visibility.unlockDoc).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.notFound).toBe(false);
    expect(result.current.loading).toBe(true);
  });

  it("signing in on the page unlocks again as that account, without a spinner", async () => {
    /**
     * The one sequence a real visitor performs: open the link anonymously,
     * select a passage, sign in to comment. The second unlock is what records
     * the grant the comment is written under, and a `loading` flash would
     * unmount the frame and lose the selection they signed in for.
     */
    visibility.unlockDoc.mockResolvedValue(MEMO);
    const { result, rerender } = open({ k: KEY, uid: null, settled: true });
    await waitFor(() => expect(result.current.resolvedFor).toBe(""));
    expect(result.current.loading).toBe(false);

    const loadingSeen: boolean[] = [];
    rerender({ k: KEY, uid: "u-new", settled: true });
    loadingSeen.push(result.current.loading);
    await waitFor(() => {
      loadingSeen.push(result.current.loading);
      expect(result.current.resolvedFor).toBe("u-new");
    });

    expect(loadingSeen.every((l) => l === false)).toBe(true);
    expect(visibility.unlockDoc).toHaveBeenCalledTimes(2);
    expect(result.current.title).toBe("Build estimate");
  });
});

describe("useDocument for a member following a link with a key", () => {
  const MEMBER_RECORD = {
    docId: "memo",
    title: "Build estimate (member record)",
    currentVersion: "v2",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    firestore.getVersion.mockResolvedValue(null);
    firestore.listVersions.mockResolvedValue([]);
    firestore.getPublicDoc.mockResolvedValue(null);
  });

  it("keeps the member record when a refused unlock answers after it", async () => {
    firestore.watchDoc.mockImplementation((_id: string, onData: (m: unknown) => void) => {
      queueMicrotask(() => onData(MEMBER_RECORD));
      return () => {};
    });
    let refuse: (v: null) => void = () => {};
    visibility.unlockDoc.mockImplementation(
      () => new Promise<null>((resolve) => (refuse = resolve)),
    );
    const { result } = open({ k: "tok_stale_stale_stale_st", uid: "u-member", settled: true });

    await waitFor(() => expect(result.current.meta).not.toBeNull());
    refuse(null);
    await new Promise((r) => setTimeout(r, 20));

    expect(result.current.notFound).toBe(false);
    expect(result.current.title).toBe("Build estimate (member record)");
    expect(result.current.currentVersion).toBe("v2");
  });

  it("does not take the reader's projection over the member record that beat it", async () => {
    firestore.watchDoc.mockImplementation((_id: string, onData: (m: unknown) => void) => {
      queueMicrotask(() => onData(MEMBER_RECORD));
      return () => {};
    });
    let answer: (v: PublicDoc) => void = () => {};
    visibility.unlockDoc.mockImplementation(
      () => new Promise<PublicDoc>((resolve) => (answer = resolve)),
    );
    const { result } = open({ k: KEY, uid: "u-member", settled: true });

    await waitFor(() => expect(result.current.meta).not.toBeNull());
    answer(MEMO);
    await new Promise((r) => setTimeout(r, 20));

    expect(result.current.publicDoc).toBeNull();
    expect(result.current.meta?.title).toBe("Build estimate (member record)");
  });
});
