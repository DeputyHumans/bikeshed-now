// SPDX-License-Identifier: Apache-2.0
// The workspace captures the covers its cards are missing, in an editor's browser (SPEC §2, §6d).

import { useEffect, useRef } from "react";

import { getVersion } from "../firestore";
import { claimUpload, coverOwed, uploadThumbs } from "../thumbs";
import { createCapturer, type Capturer } from "../viewer/capture";
import { contentBase } from "../viewer/frameMode";
import { buildPagePreviewDoc } from "../viewer/preview";
import type { DocMeta } from "../types";

/**
 * A cover is otherwise captured only when an editor opens a document, so a
 * document nobody has opened since covers existed shows a placeholder for
 * good. This fills those in from the workspace itself.
 *
 * One document at a time, after the page settles: its published entry is
 * fetched once, parsed without running anything, and its first screen built
 * into the same page preview the viewer captures — and captured the same way.
 * For a deck that first screen is its first slide, since without its script a
 * deck shows its slides top to bottom.
 *
 * A document that every reader runs the scripts of (trusted) and that has
 * scripts is left for an editor to open: a capture that runs none could show
 * everybody a page none of them sees. An untrusted document is sandboxed for
 * every reader, so its first screen without scripts is exactly theirs.
 */

export interface BackfillOptions {
  /** The published version's entry file, from its version record. */
  getEntry: (docId: string, versionId: string) => Promise<string | null>;
  /** The entry's bytes, through the content proxy with this reader's session. */
  fetchHtml: (url: string) => Promise<string | null>;
  makeCapturer: () => Capturer;
  upload: typeof uploadThumbs;
  /** Before the first capture: the workspace's own first paint comes first. */
  startAfterMs: number;
  /** How often to look again once nothing is owed. */
  idleMs: number;
}

/** At most this many covers per workspace visit: a big folder fills in over a few. */
export const MAX_PER_VISIT = 24;

const DEFAULTS: BackfillOptions = {
  getEntry: async (docId, versionId) => (await getVersion(docId, versionId))?.entry ?? null,
  fetchHtml: async (url) => {
    const res = await fetch(url, { credentials: "same-origin" });
    return res.ok ? await res.text() : null;
  },
  makeCapturer: () => createCapturer(),
  upload: uploadThumbs,
  startAfterMs: 1_500,
  idleMs: 2_000,
};

/**
 * Every document this page has tried to fill in, by `{docId}/{version}`,
 * succeeded or not: a document whose capture fails is not retried in a loop.
 */
const attempted = new Set<string>();

/** For tests: forget every attempt. */
export function resetBackfillAttempts(): void {
  attempted.clear();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useCoverBackfill(
  docs: DocMeta[],
  emailLower: string,
  overrides: Partial<BackfillOptions> = {},
): void {
  // Read at run time: the cards are re-rendered every time any of their
  // records changes, and one worker per visit outlives all of that.
  const live = useRef({ docs, emailLower, options: { ...DEFAULTS, ...overrides } });
  live.current = { docs, emailLower, options: { ...DEFAULTS, ...overrides } };

  useEffect(() => {
    let stopped = false;
    let capturer: Capturer | null = null;

    const next = (): DocMeta | undefined =>
      live.current.docs.find(
        (doc) =>
          coverOwed(doc, live.current.emailLower) &&
          !attempted.has(`${doc.docId}/${doc.currentVersion}`),
      );

    const fill = async (doc: DocMeta, o: BackfillOptions) => {
      const version = doc.currentVersion;
      const entry = await o.getEntry(doc.docId, version);
      if (!entry || stopped) return;
      const base = contentBase(doc.docId, version);
      const html = await o.fetchHtml(`${base}${entry}`);
      if (!html || stopped) return;
      if (doc.trusted !== false && /<script\b/i.test(html)) return;
      const source = new DOMParser().parseFromString(html, "text/html");
      capturer ??= o.makeCapturer();
      const shot = await capturer.capture(buildPagePreviewDoc(source, base), { page: true });
      if (stopped || !shot || shot.uniform) return;
      if (!claimUpload(`${doc.docId}/${version}/cover`)) return;
      await o.upload(doc.docId, version, "cover", [shot.blob]);
    };

    const run = async () => {
      await sleep(live.current.options.startAfterMs);
      let done = 0;
      while (!stopped && done < MAX_PER_VISIT) {
        const doc = next();
        if (!doc) {
          await sleep(live.current.options.idleMs);
          continue;
        }
        attempted.add(`${doc.docId}/${doc.currentVersion}`);
        done += 1;
        try {
          await fill(doc, live.current.options);
        } catch {
          // A cover is a convenience; the next document is not held up by it.
        }
      }
    };

    void run();
    return () => {
      stopped = true;
      capturer?.dispose();
    };
  }, []);
}
