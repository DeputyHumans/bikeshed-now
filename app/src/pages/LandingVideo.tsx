// SPDX-License-Identifier: Apache-2.0
// The opt-in landing story and its caption-sourced transcript (SPEC §7).

import { useEffect, useRef, useState } from "react";

import { LANDING_MEDIA_BASE_URL } from "../config";

type Transcript =
  | { state: "idle" | "loading" | "error" }
  | { state: "ready"; paragraphs: string[] };

/** Read the caption file itself so the visible transcript cannot drift from it. */
function transcriptFromVtt(vtt: string): string[] {
  const source = vtt.replace(/^\uFEFF/, "").trim();
  if (!/^WEBVTT(?:[ \t].*)?(?:\r?\n|$)/.test(source)) throw new Error("Invalid captions");
  const paragraphs = source.split(/\r?\n\s*\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) return [];
    const timing = lines.findIndex((line) => /^\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->\s+/.test(line));
    const text = lines.slice(timing + 1).join(" ").trim();
    return timing >= 0 && text ? [text] : [];
  });
  if (!paragraphs.length) throw new Error("Empty captions");
  return paragraphs;
}

export function LandingVideo() {
  const [videoError, setVideoError] = useState(false);
  const [captionsError, setCaptionsError] = useState(false);
  const [transcript, setTranscript] = useState<Transcript>({ state: "idle" });
  const request = useRef<AbortController | null>(null);
  const captionsTrack = useRef<HTMLTrackElement | null>(null);

  useEffect(() => () => request.current?.abort(), []);
  // Track events do not bubble and React does not attach its media listeners to
  // <track>. Listen directly so a failed caption request cannot disappear.
  useEffect(() => {
    const track = captionsTrack.current;
    if (!track) return;
    const failed = () => setCaptionsError(true);
    const loaded = () => setCaptionsError(false);
    track.addEventListener("error", failed);
    track.addEventListener("load", loaded);
    return () => {
      track.removeEventListener("error", failed);
      track.removeEventListener("load", loaded);
    };
  }, []);

  if (!LANDING_MEDIA_BASE_URL) return null;
  const captions = `${LANDING_MEDIA_BASE_URL}/bikeshed-explainer.vtt`;

  async function loadTranscript() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setTranscript({ state: "loading" });
    try {
      const response = await fetch(captions, { signal: controller.signal });
      if (!response.ok) throw new Error("Captions unavailable");
      const paragraphs = transcriptFromVtt(await response.text());
      if (!controller.signal.aborted) setTranscript({ state: "ready", paragraphs });
    } catch {
      if (!controller.signal.aborted) setTranscript({ state: "error" });
    }
  }

  return (
    <section className="landing-section landing-story" aria-labelledby="landing-story-title">
      <div className="landing-story-heading">
        <h2 id="landing-story-title">See how Bikeshed works</h2>
        <p className="landing-duration">1 min 20 sec · Narrated, with captions</p>
      </div>
      <video
        className="landing-video"
        aria-labelledby="landing-story-title"
        controls
        playsInline
        preload="none"
        crossOrigin="anonymous"
        poster={`${LANDING_MEDIA_BASE_URL}/poster.webp`}
        src={`${LANDING_MEDIA_BASE_URL}/bikeshed-explainer.mp4`}
        width="1920"
        height="1080"
        onError={(event) => {
          if (event.target === event.currentTarget) setVideoError(true);
        }}
        onPlaying={() => setVideoError(false)}
      >
        <track
          ref={captionsTrack}
          kind="captions"
          src={captions}
          srcLang="en"
          label="English"
          default
        />
        Your browser cannot play this video. Read the transcript below or the{" "}
        <a href="/docs">Bikeshed guide</a>.
      </video>
      {videoError && (
        <p className="landing-media-notice" role="status">
          The video couldn’t load. Read the transcript below or the <a href="/docs">Bikeshed guide</a>.
        </p>
      )}
      {captionsError && !videoError && (
        <p className="landing-media-notice" role="status">
          Captions couldn’t load. You can read the transcript below or the <a href="/docs">Bikeshed guide</a>.
        </p>
      )}
      <details
        className="landing-transcript"
        onToggle={(event) => {
          if (event.currentTarget.open && transcript.state === "idle") void loadTranscript();
        }}
      >
        <summary>Read the transcript</summary>
        <div className="landing-transcript-body">
          {transcript.state === "loading" && <p role="status">Loading transcript…</p>}
          {transcript.state === "ready" && transcript.paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
          {transcript.state === "error" && (
            <>
              <p role="status">The transcript couldn’t load. You can still read the <a href="/docs">Bikeshed guide</a>.</p>
              <button className="btn" type="button" onClick={() => void loadTranscript()}>Try again</button>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
