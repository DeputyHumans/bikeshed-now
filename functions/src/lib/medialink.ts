// SPDX-License-Identifier: Apache-2.0
// Video and audio reach a reader by a short-lived Storage link, once the proxy has decided they may (SPEC §2, §24, ADR 0037).

/**
 * Why a link, and not the proxy's own stream
 * ------------------------------------------
 * A browser plays video by asking for byte ranges, and Safari will not play a
 * video served without them. Hosting also cuts any function response at 60 s,
 * which a film on a slow connection outlasts. Storage answers ranges, for as
 * long as the reader takes. So for a file the browser plays, the proxy does
 * everything it always does — who is asking, the ACL, the expiry, the link
 * key — and then, instead of streaming, answers `302` to a V4 signed read link
 * for that one object.
 *
 * The link lives ten minutes, names the type the file is served as (so what
 * the object's own metadata says never matters) and asks to be shown inline.
 * It is never logged. The redirect is `private, no-store`, because a cached
 * redirect would outlive its link. What a link costs is stated in ADR 0037: a
 * reader whose access is withdrawn can still finish fetching a link they
 * already hold, for at most those ten minutes.
 *
 * Signing goes through IAM signBlob as the runtime's own identity, which
 * already holds the token-creator role on itself for session cookies
 * (`scripts/setup.mjs`), so nothing new is granted. The emulator has no
 * signer, so there the proxy streams as it always has.
 */

import * as admin from "firebase-admin";
import { bucketName } from "../config";

/** How long a media link lives. */
export const MEDIA_LINK_SECONDS = 10 * 60;

export interface MediaLinkRequest {
  objectKey: string;
  contentType: string;
  /** `inline`, or `attachment; filename="…"` for a download. */
  disposition: string;
  /** Milliseconds since the epoch. */
  expires: number;
}

/** A signed link for one object, or null to stream it instead. */
export type MediaSigner = (request: MediaLinkRequest) => Promise<string | null>;

function inEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIREBASE_STORAGE_EMULATOR_HOST);
}

const signWithStorage: MediaSigner = async ({ objectKey, contentType, disposition, expires }) => {
  if (inEmulator()) return null;
  const [url] = await admin.storage().bucket(bucketName()).file(objectKey).getSignedUrl({
    version: "v4",
    action: "read",
    expires,
    responseType: contentType,
    responseDisposition: disposition,
  });
  return url;
};

let signer: MediaSigner = signWithStorage;

/** For tests: stand in for Storage's signer, and put it back. */
export function setMediaSigner(next: MediaSigner | null): void {
  signer = next ?? signWithStorage;
}

/** A link to `objectKey`, or null when this runtime streams instead. */
export function mediaLink(request: Omit<MediaLinkRequest, "expires">, now: number = Date.now()): Promise<string | null> {
  return signer({ ...request, expires: now + MEDIA_LINK_SECONDS * 1000 });
}
