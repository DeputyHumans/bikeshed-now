// SPDX-License-Identifier: Apache-2.0
// Capture a published version's thumbnails once, in an editor's browser, and store them (SPEC §2, §6d).

import { useEffect, useRef } from "react";

import { createCapturer, type Capturer } from "./capture";
import type { Slide } from "./deck";
import { buildPagePreviewDoc, buildPreviewDoc, slideStateTokens } from "./preview";
import { claimUpload as claim, uploadThumbs, type CaptureNeeds } from "../thumbs";

/**
 * Builds previews from the reader's frame and reads it; writes nothing to it.
 * Like `useDeck`, it therefore has no cleanup the editor could race and sits
 * outside the decoration ordering `DocViewer` documents. Everything it renders
 * goes into a frame of its own.
 */

/**
 * Long enough after the frame loads for a trusted deck's own script to have
 * drawn its slides and for `useDeck` to have latched whether this is a deck at
 * all, which decides between a slide cover and a page cover.
 */
const SETTLE_MS = 2_500;

export interface ThumbCaptureOptions {
  docId: string;
  /** The published head the frame shows, which the images will stand for. */
  version: string;
  frameDoc: Document | null;
  epoch: number;
  slides: Slide[];
  /** A deck the navigator pages through; otherwise the cover is the first screen. */
  isDeck: boolean;
  /** `/content/{docId}/{version}/`. */
  baseHref: string;
  /** From `captureNeeds`; null when nothing is owed. */
  needs: CaptureNeeds | null;
  /** Injected in tests; the real ones otherwise. */
  makeCapturer?: () => Capturer;
  upload?: typeof uploadThumbs;
  settleMs?: number;
}

export function useThumbCapture(opts: ThumbCaptureOptions): void {
  // Read at run time, never effect dependencies: the frame document and the
  // slide list are objects, and `needs` is rebuilt on every render of a record
  // that `recordView` rewrites every minute. A dependency on any of them would
  // restart a capture in the middle of a deck.
  const live = useRef(opts);
  live.current = opts;

  const owed = Boolean(opts.needs?.cover || opts.needs?.slides);
  const { docId, version, epoch, isDeck, baseHref } = opts;
  const slideCount = opts.slides.length;
  const settleMs = opts.settleMs ?? SETTLE_MS;

  useEffect(() => {
    if (!owed || epoch === 0 || !version) return;
    let cancelled = false;

    const run = async () => {
      const now = live.current;
      const doc = now.frameDoc;
      if (!doc) return;
      const capturer = (now.makeCapturer ?? createCapturer)();
      const upload = now.upload ?? uploadThumbs;
      try {
        if (isDeck) {
          const slides = now.slides;
          const state = slideStateTokens(slides);
          // Slide one first, and the cover with it: a long deck's rail must
          // not hold the workspace card's picture hostage.
          const first = await capturer.capture(buildPreviewDoc(slides[0], baseHref, state));
          if (cancelled || !first) return;
          if (live.current.needs?.cover && !first.uniform && claim(`${docId}/${version}/cover`)) {
            await upload(docId, version, "cover", [first.blob]);
          }
          if (cancelled || !live.current.needs?.slides) return;
          const shots = [first];
          for (const slide of slides.slice(1)) {
            const shot = await capturer.capture(buildPreviewDoc(slide, baseHref, state));
            if (cancelled || !shot) return;
            shots.push(shot);
          }
          // A blank slide is a slide. A deck of nothing but blanks is a capture
          // of nothing, and storing it would hide the live previews.
          if (shots.every((shot) => shot.uniform)) return;
          if (!claim(`${docId}/${version}/slides`)) return;
          await upload(docId, version, "slides", shots.map((shot) => shot.blob));
        } else {
          const page = await capturer.capture(buildPagePreviewDoc(doc, baseHref), { page: true });
          if (cancelled || !page || page.uniform) return;
          if (!claim(`${docId}/${version}/cover`)) return;
          await upload(docId, version, "cover", [page.blob]);
        }
      } catch {
        // A thumbnail is a convenience. Nothing an editor is doing waits on it.
      } finally {
        capturer.dispose();
      }
    };

    const timer = setTimeout(() => void run(), settleMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [owed, docId, version, epoch, isDeck, slideCount, baseHref, settleMs]);
}
