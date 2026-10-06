// SPDX-License-Identifier: Apache-2.0
// Stored thumbnails: when an editor's browser captures them, and where a reader finds them (SPEC §2, §4).

import type { DocThumb } from "./types";

/**
 * A thumbnail is captured from the previews `viewer/preview.ts` builds, in an
 * EDITOR's browser, because nothing server-side renders a document; it is then
 * stored so every member sees it without anybody rendering it again. This
 * module decides when a capture is owed and where a stored image is read from.
 * The capture itself is `viewer/capture.ts`.
 *
 * The limits mirror `functions/src/lib/thumbs.ts`, and `thumbs.test.ts` pins
 * them to it: an image the server would refuse is not worth rendering.
 */

/** A deck larger than this keeps live previews; the server refuses more. */
export const THUMB_MAX_SLIDES = 100;

/** Per image, as the server caps it. */
export const THUMB_MAX_IMAGE_BYTES = 160 * 1024;

/**
 * Every stored image is laid out at ONE size, whoever captured it. The rail's
 * live previews use the reader's own viewport; a stored image is shown to every
 * member on every device, so an editor on a phone must not decide that every
 * reader's cards are portrait.
 */
export const THUMB_STAGE = { width: 1280, height: 720 } as const;

/** Stored at half the stage: 640×360, sharp at the size any card shows it. */
export const THUMB_PIXEL_RATIO = 0.5;

/** JPEG quality; well under the byte cap at this size. */
export const THUMB_QUALITY = 0.75;

/** The URL of one stored image. Only ever built from what the record names. */
export function thumbUrl(
  docId: string,
  versionId: string,
  key: string,
  slot: "cover" | number,
): string {
  const name = slot === "cover" ? "cover" : `s${slot}`;
  return `/thumb/${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}/${key}/${name}.jpg`;
}

/** The workspace card's cover, from whatever version the record names. */
export function coverUrl(docId: string, thumb: DocThumb | undefined): string | null {
  return thumb?.cover ? thumbUrl(docId, thumb.versionId, thumb.cover, "cover") : null;
}

/**
 * Everything the viewer knows that decides whether this browser owes a
 * capture. Primitives only: the record behind them is rewritten every minute
 * somebody reads (`stats`), and a decision keyed on the object would restart.
 */
export interface CaptureInput {
  /** Reading, not editing. */
  reading: boolean;
  /** The frame shows the shared draft, not a published version. */
  draft: boolean;
  /** The version the frame shows, and the document's head. */
  shownVersion: string;
  headVersion: string;
  /** Owner, a direct editor or an effective editor. Open editing is not enough. */
  isDocEditor: boolean;
  expired: boolean;
  /** Whether this reader's frame runs the document's scripts... */
  sandboxed: boolean;
  /** ...and whether every reader's does. */
  globallyTrusted: boolean;
  /** What the record already holds. */
  thumbVersion: string | null;
  hasCover: boolean;
  hasSlides: boolean;
  /** A deck the navigator would page through, and its size. */
  isDeck: boolean;
  slideCount: number;
}

export interface CaptureNeeds {
  cover: boolean;
  slides: boolean;
}

/**
 * Which images this browser should capture now, or null for none.
 *
 * Every gate is a reason the image would be wrong to show everybody else:
 *
 *   - Only the published head, read rather than edited, with no draft: what
 *     the frame shows must be exactly the bytes the thumbnail will stand for.
 *   - Only an editor: the people who can already change what the document
 *     says. Open editing admits any signed-in account, which is too wide for an
 *     image every member is shown.
 *   - Never an expired document, which is frozen for everyone.
 *   - Only when this frame runs scripts exactly when everyone's does. A reader
 *     who trusted a document for THEMSELVES runs its scripts with their own
 *     access, and those scripts could paint something of theirs into the page
 *     — which a stored capture would then show to every member.
 */
export function captureNeeds(input: CaptureInput): CaptureNeeds | null {
  if (!input.reading || input.draft) return null;
  if (!input.headVersion || input.shownVersion !== input.headVersion) return null;
  if (!input.isDocEditor || input.expired) return null;
  if (input.sandboxed === input.globallyTrusted) return null;

  const current = input.thumbVersion === input.headVersion;
  const cover = !(current && input.hasCover);
  const slides =
    input.isDeck && input.slideCount <= THUMB_MAX_SLIDES && !(current && input.hasSlides);
  return cover || slides ? { cover, slides } : null;
}

/**
 * The stored rail for the deck on screen, as one URL per slide, or null when
 * the live previews must be used instead: in edit mode and on a draft, whose
 * slides are not the stored ones; on any version but the one stored; and when
 * the deck on screen does not have the number of slides that was captured.
 */
export function storedSlideImages(
  docId: string,
  thumb: DocThumb | undefined,
  view: { reading: boolean; draft: boolean; shownVersion: string; slideCount: number },
): string[] | null {
  if (!view.reading || view.draft || !thumb?.slides) return null;
  if (thumb.versionId !== view.shownVersion) return null;
  const { key, count } = thumb.slides;
  if (count !== view.slideCount) return null;
  return Array.from({ length: count }, (_, i) => thumbUrl(docId, thumb.versionId, key, i));
}

/**
 * Upload captured images. Silent by design: a thumbnail is a convenience, and
 * an editor reading a document is never told one failed to store. The server
 * decides whether it lands; `false` only means this attempt is over.
 */
export async function uploadThumbs(
  docId: string,
  versionId: string,
  kind: "cover" | "slides",
  images: readonly Blob[],
): Promise<boolean> {
  const query = new URLSearchParams({
    doc: docId,
    v: versionId,
    kind,
    sizes: images.map((image) => image.size).join(","),
  });
  try {
    const res = await fetch(`/thumb?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob(images as Blob[]),
      credentials: "same-origin",
    });
    return res.ok;
  } catch {
    return false;
  }
}
