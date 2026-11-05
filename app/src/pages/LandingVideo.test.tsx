// SPDX-License-Identifier: Apache-2.0
// Playback privacy, accessible captions, and media failure sequences (SPEC §7).

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LandingVideo } from "./LandingVideo";

const media = vi.hoisted(() => ({ base: "" }));
vi.mock("../config", () => ({
  get LANDING_MEDIA_BASE_URL() { return media.base; },
}));

beforeEach(() => {
  media.base = "https://media.example.test/story-v1";
});

describe("the native story player", () => {
  it("requests playback only from the visitor, with sound and inline native controls", () => {
    const { container } = render(<LandingVideo />);
    const video = container.querySelector("video")!;
    expect({
      controls: video.controls,
      preload: video.preload,
      autoplay: video.autoplay,
      muted: video.muted || video.defaultMuted,
      inline: video.playsInline,
    }).toEqual({ controls: true, preload: "none", autoplay: false, muted: false, inline: true });
  });

  it("loads one configured media revision with a poster and default cross-origin English captions", () => {
    const { container } = render(<LandingVideo />);
    const video = container.querySelector("video")!;
    const track = container.querySelector("track")!;
    expect({
      video: video.getAttribute("src"),
      poster: video.getAttribute("poster"),
      crossorigin: video.crossOrigin,
      captions: track.getAttribute("src"),
      kind: track.kind,
      language: track.srclang,
      label: track.label,
      default: track.default,
    }).toEqual({
      video: `${media.base}/bikeshed-explainer.mp4`,
      poster: `${media.base}/poster.webp`,
      crossorigin: "anonymous",
      captions: `${media.base}/bikeshed-explainer.vtt`,
      kind: "captions",
      language: "en",
      label: "English",
      default: true,
    });
  });

  it("sets the video's src before its captions track exists, because iOS refuses the video otherwise", () => {
    const setAttribute = Element.prototype.setAttribute;
    const trackPresentWhenSrcWasSet: boolean[] = [];
    const spy = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (this: Element, name, value) {
      if (this.tagName === "VIDEO" && name === "src") trackPresentWhenSrcWasSet.push(this.querySelector("track") !== null);
      setAttribute.call(this, name, value);
    });
    const { container } = render(<LandingVideo />);
    spy.mockRestore();
    expect({
      trackPresentWhenSrcWasSet,
      trackAfterEffects: container.querySelector("video > track") !== null,
    }).toEqual({ trackPresentWhenSrcWasSet: [false], trackAfterEffects: true });
  });

  it("omits the optional media when the deployment has not configured it", () => {
    media.base = "";
    const { container } = render(<LandingVideo />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps caption failures separate from video failures and recovers when playback succeeds", () => {
    const { container } = render(<LandingVideo />);
    const video = container.querySelector("video")!;
    const track = container.querySelector("track")!;
    fireEvent.error(track);
    expect(screen.getByRole("status").textContent).toMatch(/^Captions couldn’t load/);
    fireEvent.load(track);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.error(video);
    expect(screen.getByRole("status").textContent).toMatch(/^The video couldn’t load/);
    fireEvent.playing(video);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
