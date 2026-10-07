// SPDX-License-Identifier: Apache-2.0
// "Someone commented on your document" (SPEC §14).

import { Button, Text } from "@react-email/components";
import { Layout, textStyles } from "./Layout";

/**
 * The feedback loop the product exists for, and the only message here that could
 * become spam — so it is bounded by CONSTRUCTION rather than by infrastructure:
 * one Firestore trigger, recipients = owner + prior thread participants minus
 * the author, and a per-(recipient, document) cooldown on the user record. No
 * queue, no scheduler, no cron.
 *
 * The comment body is rendered as PLAIN TEXT inside a quote block, never as
 * markup. It is the one place in these templates where raw HTML would be
 * tempting and where it would be an injection vector.
 */
export interface CommentNoticeProps {
  origin: string;
  authorEmail: string;
  docTitle: string;
  /** The passage the comment is anchored to. This is what makes it actionable. */
  quote: string;
  body: string;
  url: string;
  /** Set when the comment arrived through an automation channel (SPEC §17). */
  viaChannel?: "cli" | "mcp" | "api";
  /**
   * Set when this comment opens a suggested edit (SPEC §22). The quote is the
   * text it would change and `replacement` what it would become; empty means
   * the suggestion is to delete it. A branch of this message, not a fourth one:
   * it is still "someone said something about a passage in your document".
   */
  suggestion?: { replacement: string };
}

/** The change a suggestion proposes, in words, for both renderings. */
function changeLine(s: { replacement: string }): string {
  return s.replacement === "" ? "Suggested: delete this." : `Suggested replacement: ${s.replacement}`;
}

export function CommentNotice(p: CommentNoticeProps) {
  return (
    <Layout
      origin={p.origin}
      preview={`${p.authorEmail} ${p.suggestion ? "suggested an edit to" : "commented on"} ${p.docTitle}`}
      footnote={
        p.suggestion
          ? "You received this because you can accept or reject edits to this document."
          : "You received this because you own this document or replied in this thread."
      }
    >
      <Text style={textStyles.heading}>
        {p.authorEmail} {p.suggestion ? "suggested an edit to" : "commented on"} “{p.docTitle}”
      </Text>
      {p.viaChannel ? (
        <Text style={{ ...textStyles.paragraph, fontSize: "13px", color: "#55526b" }}>
          Posted via {p.viaChannel.toUpperCase()} — this comment came from
          automation, not a person typing.
        </Text>
      ) : null}
      {p.quote ? <Text style={textStyles.quote}>{p.quote}</Text> : null}
      {p.suggestion ? <Text style={textStyles.paragraph}>{changeLine(p.suggestion)}</Text> : null}
      {p.body ? <Text style={textStyles.paragraph}>{p.body}</Text> : null}
      <Button href={p.url} style={textStyles.button}>
        {p.suggestion ? "Review it in context" : "Reply in context"}
      </Button>
    </Layout>
  );
}

export function commentNoticeText(p: CommentNoticeProps): string {
  return [
    `${p.authorEmail} ${p.suggestion ? "suggested an edit to" : "commented on"} "${p.docTitle}"${p.viaChannel ? ` (via ${p.viaChannel.toUpperCase()})` : ""}.`,
    ``,
    p.quote ? `On: "${p.quote}"` : "",
    p.suggestion ? changeLine(p.suggestion) : "",
    ``,
    p.body,
    ``,
    `${p.suggestion ? "Review it in context" : "Reply in context"}: ${p.url}`,
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}
