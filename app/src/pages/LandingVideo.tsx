// SPDX-License-Identifier: Apache-2.0
// The opt-in landing story with native playback and captions (SPEC §7).

import { useEffect, useRef, useState } from "react";

import { LANDING_MEDIA_BASE_URL } from "../config";

export function LandingVideo() {
  const [videoError, setVideoError] = useState(false);
  const [captionsError, setCaptionsError] = useState(false);
  // An iPhone refuses a video whose <track> was attached before its src, and
  // React attaches an element's children before it sets the element's attributes.
  // So the first commit sets src with no track, and the track follows straight after.
  const [srcIsSet, setSrcIsSet] = useState(false);
  const captionsTrack = useRef<HTMLTrackElement | null>(null);

  useEffect(() => {
    setSrcIsSet(true);
  }, []);

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
  }, [srcIsSet]);

  if (!LANDING_MEDIA_BASE_URL) return null;
  const captions = `${LANDING_MEDIA_BASE_URL}/bikeshed-explainer.vtt`;

  return (
    <section className="landing-section landing-story" aria-labelledby="landing-story-title">
      <h2 id="landing-story-title">See how Bikeshed works</h2>
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
        {srcIsSet && (
          <track
            ref={captionsTrack}
            kind="captions"
            src={captions}
            srcLang="en"
            label="English"
            default
          />
        )}
        Your browser cannot play this video. Read the{" "}
        <a href="/docs">Bikeshed guide</a>.
      </video>
      {videoError && (
        <p className="landing-media-notice" role="status">
          The video couldn’t load. Read the <a href="/docs">Bikeshed guide</a>.
        </p>
      )}
      {captionsError && !videoError && (
        <p className="landing-media-notice" role="status">
          Captions couldn’t load. You can read the <a href="/docs">Bikeshed guide</a>.
        </p>
      )}
    </section>
  );
}
