// SPDX-License-Identifier: Apache-2.0
// The Activity panel's feed: one page from GET /activity, and each row in words (SPEC §17, ADR 0023).

import { get } from "./api";
import { formatDay } from "./expiry";

/** One row as GET /activity answers it: a change-log event or a reading session. */
export interface ActivityItem {
  id: string;
  type: string;
  /** ISO time; a day alone for a fork, whose time is not its author's to know. */
  at: string | null;
  by?: string | null;
  channel?: string;
  via?: string;
  automated?: boolean;
  version?: string;
  threadId?: string;
  quote?: string;
  body?: string;
  replacement?: string;
  origin?: "upload" | "edit" | "fork";
  ms?: number;
  reads?: number;
  from?: unknown;
  to?: unknown;
  added?: string[];
  removed?: string[];
  reason?: string;
  trusted?: boolean;
  publicEdit?: boolean;
}

export interface ActivityPage {
  items: ActivityItem[];
  next: string | null;
}

export function fetchActivity(docId: string, before?: string | null): Promise<ActivityPage> {
  return get<ActivityPage>("/activity", { docId, ...(before ? { before } : {}) }, {
    forbidden: "Only the owner and its editors can see this document's activity.",
  });
}

const quoted = (s: unknown, max = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
};

const LEVEL: Record<string, string> = { private: "private", unlisted: "readable by link", public: "public" };

/** The folder a move went to or came from, as get_changes reports it. */
const place = (p: unknown) => (p && typeof p === "object" && "path" in p ? String((p as { path: unknown }).path) : "Everything");

/**
 * What happened, after the name of whoever did it.
 *
 * The subject is the row's own `by`, shown before this (subjectOf); the version
 * is the row's link, shown after it, so neither is repeated here.
 */
export function describeActivity(item: ActivityItem): string {
  switch (item.type) {
    case "read":
      return item.automated && item.reads && item.reads > 1 ? `read it ${item.reads} times` : "read it";
    case "version.published":
      return item.origin === "edit"
        ? "published a version from the editor"
        : item.origin === "fork"
          ? "made this document, as a fork"
          : "uploaded a version";
    case "version.withdrawn":
      return "withdrew a version";
    case "thread.opened":
      return `commented on ${quoted(item.quote)}`;
    case "comment.added":
      return `replied: ${quoted(item.body, 80)}`;
    case "thread.resolved":
      return `resolved the thread on ${quoted(item.quote)}`;
    case "thread.reopened":
      return `reopened the thread on ${quoted(item.quote)}`;
    case "suggestion.opened":
      return `suggested replacing ${quoted(item.quote)} with ${quoted(item.replacement)}`;
    case "suggestion.revised":
      return `revised a suggestion to ${quoted(item.replacement)}`;
    case "suggestion.accepted":
      return `accepted the suggestion on ${quoted(item.quote)}`;
    case "suggestion.rejected":
      return `declined the suggestion on ${quoted(item.quote)}`;
    case "suggestion.withdrawn":
      return `withdrew the suggestion on ${quoted(item.quote)}`;
    case "doc.renamed":
      return `renamed it to ${quoted(item.to)}`;
    case "doc.moved":
      return `moved it from ${place(item.from)} to ${place(item.to)}`;
    case "doc.visibility":
      return `made it ${LEVEL[String(item.to)] ?? String(item.to)}${item.publicEdit ? ", open for anyone to edit" : ""}`;
    case "doc.expiry":
      return typeof item.to === "number"
        ? `set it to stop being readable on ${formatDay(item.to)}`
        : "removed its end date";
    case "doc.trust":
      return item.trusted ? "let its scripts run for everyone" : "stopped its scripts running for everyone";
    case "access.changed": {
      if (item.reason === "address-moved") return `moved to ${item.added?.[0] ?? "a new address"}`;
      const parts: string[] = [];
      if (item.added?.length) parts.push(`gave ${item.added.join(", ")} access`);
      if (item.removed?.length) parts.push(`removed ${item.removed.join(", ")}`);
      return parts.join(" and ") || "changed who has access";
    }
    case "fork.created":
      return "forked a version";
    default:
      return item.type;
  }
}

/** Who the row is about, as its subject. */
export function subjectOf(item: ActivityItem): string {
  if (item.type === "fork.created") return "Someone";
  // Only an operator script withdraws a version, and one withdrawn before its
  // actor was stored carries no channel to say so.
  if (item.channel === "operator" || item.type === "version.withdrawn") return "An operator";
  if (item.type === "access.changed" && item.reason === "address-moved") return item.removed?.[0] ?? "An account";
  return item.by ?? (item.type === "read" ? "Somebody without an account" : "Somebody");
}
