// SPDX-License-Identifier: Apache-2.0
// A newer version is news only to a reader who is not looking at it (SPEC §6b, §16).

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DocMeta } from "../types";

import { useLiveSync } from "./useLiveSync";

// Only `currentVersion` and `draft` are read; the rest is whatever Firestore
// would carry.
function meta(currentVersion: string): DocMeta {
  return { docId: "doc-a", currentVersion } as DocMeta;
}

function mount(initial: { meta: DocMeta; shownVersion: string }) {
  return renderHook(
    ({ meta, shownVersion }) =>
      useLiveSync({
        meta,
        shownVersion,
        emailLower: "reader@example.com",
        isEditing: false,
        showsDraft: false,
        onPeerSavedDraft: () => {},
      }),
    { initialProps: initial },
  );
}

describe("useLiveSync: a newer version", () => {
  it("is never the version the document opened at", () => {
    const { result } = mount({ meta: meta("v3"), shownVersion: "v3" });

    expect(result.current.newVersion).toBeNull();
  });

  it("is announced to a reader pinned to an older one", () => {
    const { result, rerender } = mount({ meta: meta("v3"), shownVersion: "v3" });

    rerender({ meta: meta("v4"), shownVersion: "v3" });

    expect(result.current.newVersion).toBe("v4");
  });

  it("is not announced when the viewer is already showing it", () => {
    // The reader's own commit, or a peer's publish to a reader with no version
    // pinned: the frame follows `currentVersion` in the same render the
    // snapshot lands, so "Open v4 / Stay here" would offer a choice that has
    // already been made.
    const { result, rerender } = mount({ meta: meta("v3"), shownVersion: "v3" });

    rerender({ meta: meta("v4"), shownVersion: "v4" });

    expect(result.current.newVersion).toBeNull();
  });

  it("clears by itself once the reader opens it", () => {
    const { result, rerender } = mount({ meta: meta("v3"), shownVersion: "v3" });
    rerender({ meta: meta("v4"), shownVersion: "v3" });
    expect(result.current.newVersion).toBe("v4");

    // "Open v4" navigates to the unpinned URL, and the viewer follows.
    rerender({ meta: meta("v4"), shownVersion: "v4" });

    expect(result.current.newVersion).toBeNull();
  });

  it("stays dismissed", () => {
    const { result, rerender } = mount({ meta: meta("v3"), shownVersion: "v3" });
    rerender({ meta: meta("v4"), shownVersion: "v3" });

    act(() => result.current.dismissNewVersion());
    rerender({ meta: meta("v4"), shownVersion: "v3" });

    expect(result.current.newVersion).toBeNull();
  });
});

describe("useLiveSync: a peer saves the draft", () => {
  const saved = (at: number): DocMeta =>
    ({ docId: "doc-a", currentVersion: "v3", draft: { updatedAt: { toMillis: () => at }, updatedByEmail: "peer@example.com" } }) as unknown as DocMeta;

  function reader(showsDraft: boolean, hold = false) {
    const reloads: number[] = [];
    const view = renderHook(
      ({ meta, hold }) =>
        useLiveSync({
          meta,
          shownVersion: "v3",
          emailLower: "reader@example.com",
          isEditing: false,
          showsDraft,
          hold,
          onPeerSavedDraft: () => reloads.push(1),
        }),
      { initialProps: { meta: saved(1), hold } },
    );
    return { view, reloads };
  }

  it("leaves a reader of the published version alone", () => {
    // Their frame shows a version, which a draft save does not change. It was
    // reloaded on every autosave, about once a second while somebody typed,
    // and each reload threw away an open suggestion form or selection.
    const { view, reloads } = reader(false);
    view.rerender({ meta: saved(2), hold: false });
    view.rerender({ meta: saved(3), hold: false });
    expect(reloads).toEqual([]);
  });

  it("brings a reader of the draft up to date, but not with the save it just loaded", () => {
    const { view, reloads } = reader(true);
    expect(reloads).toEqual([]);
    view.rerender({ meta: saved(2), hold: false });
    expect(reloads).toEqual([1]);
  });

  it("waits while the reader is writing a suggestion or a comment, then catches up once", () => {
    const { view, reloads } = reader(true, true);
    view.rerender({ meta: saved(2), hold: true });
    view.rerender({ meta: saved(3), hold: true });
    expect(reloads).toEqual([]);
    view.rerender({ meta: saved(3), hold: false });
    expect(reloads).toEqual([1]);
  });
});
