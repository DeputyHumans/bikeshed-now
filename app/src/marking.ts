// SPDX-License-Identifier: Apache-2.0
// Client for per-document export marking (SPEC §20).

import { post } from "./api";
import type { Marking } from "./types";

export const MARKING_OFF: Marking = { enabled: false, label: "", footer: "" };

/**
 * Marking is resolved at PUBLISH time, not export time.
 *
 * Resolving when somebody exports would apply the EXPORTER's default instead, so
 * a reader with "Confidential" as their account default would stamp it on a
 * document its owner deliberately published openly. The decision belongs to the
 * person who published.
 */
export function setMarking(docId: string, marking: Marking): Promise<{ marking: Marking }> {
  return post<{ marking: Marking }>(
    "/marking",
    { docId, marking },
    { forbidden: "Only the document owner can change export marking." },
  );
}

/** Substitute the supported placeholders. Called at export time for {year}/{date}. */
export function resolveFooter(
  footer: string,
  context: { title: string; version: string; user: string },
): string {
  const now = new Date();
  return footer
    .split("{year}").join(String(now.getFullYear()))
    .split("{date}").join(now.toLocaleDateString(undefined, { dateStyle: "medium" }))
    .split("{title}").join(context.title)
    .split("{version}").join(context.version)
    .split("{user}").join(context.user);
}
