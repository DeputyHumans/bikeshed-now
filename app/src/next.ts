// SPDX-License-Identifier: Apache-2.0
// Where to send a reader once they have signed in (SPEC §3, §21).

/**
 * `/signup?next=…` returns a reader to what they were doing — the document they
 * pressed Fork on — instead of the workspace.
 *
 * Only a path on THIS origin is honoured. Anything else becomes `/`: an absolute
 * URL, a protocol-relative `//host`, and the backslash forms browsers quietly
 * read as one. A sign-in page that redirects wherever its query string says is
 * an open redirect, and a link to it would be a phishing kit.
 */
export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.includes("\\")) return "/";
  // Control characters, including a tab or newline a URL parser strips first.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  try {
    const base = "https://origin.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
