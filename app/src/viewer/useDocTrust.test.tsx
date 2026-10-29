// SPDX-License-Identifier: Apache-2.0
// A personally trusted document loads once, unsandboxed (SPEC §6c).

import { READING_SANDBOX } from "./frameMode";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameMode } from "./frameMode";

// The personal-trust listener is stubbed, never reached through the
// environment: Vitest loads app/.env.local, and ambient config must not decide
// a test. Every subscription is kept, so a test can answer it late, or never.
const trust = vi.hoisted(() => ({
  watchPersonalTrust: vi.fn(),
  setPersonalTrust: vi.fn(),
}));
vi.mock("../trust", () => trust);

import { useDocFrame } from "./useDocFrame";
import { PERSONAL_TRUST_WAIT_MS, useDocTrust } from "./useDocTrust";

interface Listener {
  uid: string;
  onData: (trusted: boolean) => void;
}
let listeners: Listener[] = [];

/** Answer a subscription made for `uid`, as Firestore would: the newest one by default. */
function answer(uid: string, trusted: boolean, which: "newest" | "oldest" = "newest") {
  const mine = listeners.filter((l) => l.uid === uid);
  const listener = which === "newest" ? mine[mine.length - 1] : mine[0];
  if (!listener) throw new Error(`nobody asked whether ${uid} trusts this`);
  act(() => listener.onData(trusted));
}

beforeEach(() => {
  listeners = [];
  trust.watchPersonalTrust.mockReset();
  trust.watchPersonalTrust.mockImplementation(
    (_docId: string, uid: string, onData: (trusted: boolean) => void) => {
      listeners.push({ uid, onData });
      return () => {};
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

interface TrustProps {
  uid: string | null;
  docTrusted: boolean | undefined;
  doc?: Document | null;
}

function trustHook(initial: TrustProps) {
  return renderHook(
    (p: TrustProps) =>
      useDocTrust({
        docId: "d1",
        uid: p.uid,
        doc: p.doc ?? null,
        epoch: 0,
        docTrusted: p.docTrusted,
        emailLower: "",
      }),
    { initialProps: initial },
  );
}

describe("useDocTrust settles", () => {
  it("at once for a reader with no account", () => {
    // Never waits on auth: a link opens before sign-in has decided (SPEC §17).
    const { result } = trustHook({ uid: null, docTrusted: false });

    expect(result.current.settled).toBe(true);
    expect(result.current.trusted).toBe(false);
    expect(trust.watchPersonalTrust).not.toHaveBeenCalled();
  });

  it("at once when the document is trusted for everyone", () => {
    const { result } = trustHook({ uid: "u1", docTrusted: true });

    expect(result.current.settled).toBe(true);
    expect(result.current.trusted).toBe(true);
  });

  it("only when this reader's answer is in, on an untrusted document", () => {
    const { result } = trustHook({ uid: "u1", docTrusted: false });
    expect(result.current.settled).toBe(false);
    expect(result.current.trusted).toBe(false);

    answer("u1", true);

    expect(result.current.settled).toBe(true);
    expect(result.current.personallyTrusted).toBe(true);
    expect(result.current.trusted).toBe(true);
  });

  it("on a refusal too, which stays sandboxed", () => {
    // `watchPersonalTrust` reports a failed read as `false`, so this is also
    // the error case, and the unverified account the rules turn away.
    const { result } = trustHook({ uid: "u1", docTrusted: false });

    answer("u1", false);

    expect(result.current.settled).toBe(true);
    expect(result.current.trusted).toBe(false);
  });

  it("on an answer for the account asking, never a previous one", () => {
    const { result, rerender } = trustHook({ uid: "u1", docTrusted: false });
    answer("u1", true);

    rerender({ uid: "u2", docTrusted: false });
    expect(result.current.personallyTrusted).toBe(false);
    expect(result.current.trusted).toBe(false);
    expect(result.current.settled).toBe(false);

    // The first account's listener speaking late changes nothing for the second.
    answer("u1", true, "oldest");
    expect(result.current.trusted).toBe(false);
    expect(result.current.settled).toBe(false);

    answer("u2", false);
    expect(result.current.settled).toBe(true);
    expect(result.current.trusted).toBe(false);
  });

  it("and forgets a grant when the reader signs out", () => {
    const { result, rerender } = trustHook({ uid: "u1", docTrusted: false });
    answer("u1", true);

    rerender({ uid: null, docTrusted: false });

    expect(result.current.personallyTrusted).toBe(false);
    expect(result.current.trusted).toBe(false);
    expect(result.current.settled).toBe(true);
  });

  it("after PERSONAL_TRUST_WAIT_MS with no answer, sandboxed", () => {
    vi.useFakeTimers();
    const { result } = trustHook({ uid: "u1", docTrusted: false });

    act(() => vi.advanceTimersByTime(PERSONAL_TRUST_WAIT_MS - 1));
    expect(result.current.settled).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.settled).toBe(true);
    expect(result.current.trusted).toBe(false);

    // A late answer still counts: the frame remounts for it, as it always did.
    answer("u1", true);
    expect(result.current.trusted).toBe(true);
  });
});

describe("useDocTrust offers trust", () => {
  it("only once it knows what this reader already decided", () => {
    const doc = document.implementation.createHTMLDocument("");
    doc.body.appendChild(doc.createElement("script"));
    const { result } = trustHook({ uid: "u1", docTrusted: false, doc });
    expect(result.current.shouldOffer).toBe(false);

    answer("u1", false);

    expect(result.current.shouldOffer).toBe(true);
  });
});

interface ViewerProps {
  resolved: boolean;
  docTrusted: boolean | undefined;
  uid: string | null;
}

/**
 * The two hooks wired as `DocViewer` wires them, so the test exercises the
 * sequence a real visitor performs rather than each state in isolation.
 */
function Viewer({ resolved, docTrusted, uid }: ViewerProps) {
  const trusted = useDocTrust({
    docId: "d1",
    uid,
    doc: null,
    epoch: 0,
    docTrusted,
    emailLower: "",
  });
  const mode: FrameMode = {
    kind: "reading",
    versionId: "v1",
    draft: false,
    sandboxed: !trusted.trusted,
  };
  const frame = useDocFrame({
    mode,
    docId: "d1",
    entry: "index.html",
    trustToken: trusted.trustToken,
    hold: mode.kind === "reading" && !trusted.settled,
  });
  // DocViewer shows a spinner, not the frame, until the document resolves.
  if (!resolved || !frame.frameProps) return null;
  const { key, ...props } = frame.frameProps;
  return <iframe key={key} {...props} ref={frame.ref} title="document" />;
}

describe("a personally trusted document", () => {
  it("loads once, unsandboxed, when the grant arrives after the document", () => {
    const seen = new Set<HTMLIFrameElement>();
    const { container, rerender } = render(
      <Viewer resolved={false} docTrusted={undefined} uid="u1" />,
    );
    const frame = () => {
      const el = container.querySelector("iframe");
      if (el) seen.add(el);
      return el;
    };

    rerender(<Viewer resolved docTrusted={false} uid="u1" />);
    expect(frame()).toBeNull();

    answer("u1", true);

    expect(frame()?.hasAttribute("sandbox")).toBe(false);
    expect(seen.size).toBe(1);
  });

  it("still loads once, sandboxed, for a reader with no grant", () => {
    const { container, rerender } = render(
      <Viewer resolved={false} docTrusted={undefined} uid="u1" />,
    );
    rerender(<Viewer resolved docTrusted={false} uid="u1" />);

    answer("u1", false);

    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute("sandbox")).toBe(READING_SANDBOX);
  });

  it("keeps the frame a reader signs in from, until a grant says otherwise", () => {
    const { container, rerender } = render(<Viewer resolved docTrusted={false} uid={null} />);
    const first = container.querySelector("iframe");
    if (!first) throw new Error("an anonymous reader's frame should not wait");
    expect(first.getAttribute("sandbox")).toBe(READING_SANDBOX);
    fireEvent.load(first);

    rerender(<Viewer resolved docTrusted={false} uid="u1" />);
    expect(container.querySelector("iframe")).toBe(first);

    // A grant still remounts the frame, which is how blocked scripts get to run.
    answer("u1", true);
    const after = container.querySelector("iframe");
    expect(after).not.toBe(first);
    expect(after?.hasAttribute("sandbox")).toBe(false);
  });
});
