// SPDX-License-Identifier: Apache-2.0
// The embed page's script, around the frame the server made: links, the reading clock and consent (SPEC §2 "GET /embed/…", §4, §15).

import { analyticsConfigured, logEvent, logPageView, setAnalyticsOptOut } from "../analytics";
import { readConsent, writeConsent } from "../consent";
import { trackView } from "../stats";
import { watchActivity } from "../viewer/frameWatch";
import { attachOutboundLinks, openBeside } from "../viewer/outboundLinks";
import { showConsentBar } from "./consentBar";

/**
 * `docShell` renders the frame into the page (`functions/src/lib/embed.ts`),
 * so the document shows before this script arrives, and if it never does.
 * This module only adds what a script must: the viewer's handling of a link
 * that leaves the document, the reading clock, and the consent bar.
 *
 * It imports no router, no page, and nothing that starts Auth, Firestore or the
 * Realtime Database. A framing page must not be able to reach the app through
 * it (SPEC §23), and `graph.test.ts` holds this module's imports to that.
 */

export interface EmbedFrame {
  docId: string;
  versionId: string;
  /** The key that opened it: the server writes one only when a key did. */
  k?: string;
  format: "html" | "markdown";
}

/** What the server wrote on the frame, or null when it is not a frame this page made. */
export function readFrame(frame: HTMLIFrameElement): EmbedFrame | null {
  const { doc, version, k, format } = frame.dataset;
  if (!doc || !version) return null;
  return {
    docId: doc,
    versionId: version,
    ...(k ? { k } : {}),
    format: format === "markdown" ? "markdown" : "html",
  };
}

/**
 * Tell `onChange` whether `el` is inside the viewport the reader sees.
 *
 * In a frame on another site, an observer with no root measures against the
 * top-level viewport, which is the host page's: an embed below the fold is out
 * of view until the reader scrolls to it. Where there is no observer, the
 * embed counts as in view, as the viewer's document always does.
 */
export function watchInView(el: Element, onChange: (inView: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => {};
  }
  const observer = new IntersectionObserver((entries) => {
    const last = entries[entries.length - 1];
    if (last) onChange(last.isIntersecting);
  });
  observer.observe(el);
  return () => observer.disconnect();
}

/**
 * Analytics, only with this embed's own consent.
 *
 * No account is known inside an embed, so the account opt-out cannot reach it
 * and consent is the only gate (SPEC §15). Nothing is fetched before Allow.
 */
function startAnalytics(root: HTMLElement, format: EmbedFrame["format"]): () => void {
  if (!analyticsConfigured()) return () => {};
  const begin = () => {
    void setAnalyticsOptOut(false).then(() => {
      logPageView(window.location.pathname);
      logEvent({ name: "doc_open", params: { format, sandboxed: true, embedded: true } });
    });
  };
  const consent = readConsent();
  if (consent === "granted") {
    begin();
    return () => {};
  }
  if (consent === "denied") return () => {};
  return showConsentBar(root, (answer) => {
    writeConsent(answer);
    if (answer === "granted") begin();
  });
}

/** Start everything the page's script owns. Returns the detach, for tests. */
export function startEmbed(frame: HTMLIFrameElement, root: HTMLElement): () => void {
  const info = readFrame(frame);
  if (!info) return () => {};

  // Out of view until the observer says otherwise: an embed nobody has
  // scrolled to is not being read.
  const tracker = trackView(info.docId, info.versionId, info.k, { surface: "embed", inView: false });
  const stopView = watchInView(frame, (inView) => tracker.setInView(inView));

  let detach: (() => void) | null = null;
  const attach = () => {
    detach?.();
    detach = null;
    const doc = frame.contentDocument;
    // Before the version's entry commits, the frame holds an empty document.
    if (!doc || doc.URL === "about:blank") return;
    const stops = [attachOutboundLinks(doc, openBeside), watchActivity(doc, () => tracker.markActive())];
    detach = () => {
      for (const stop of stops) stop();
    };
  };
  // Every load, because a bundle's own pages navigate the frame.
  frame.addEventListener("load", attach);
  // The frame may have loaded before this module ran.
  if (frame.contentDocument?.readyState === "complete") attach();

  const stopConsent = startAnalytics(root, info.format);

  return () => {
    frame.removeEventListener("load", attach);
    detach?.();
    stopView();
    stopConsent();
    tracker.stop();
  };
}
