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
}

export function CommentNotice(p: CommentNoticeProps) {
  return (
    <Layout
      origin={p.origin}
      preview={`${p.authorEmail} commented on ${p.docTitle}`}
      footnote="You received this because you own this document or replied in this thread."
    >
      <Text style={textStyles.heading}>
        {p.authorEmail} commented on “{p.docTitle}”
      </Text>
      {p.viaChannel ? (
        <Text style={{ ...textStyles.paragraph, fontSize: "13px", color: "#55526b" }}>
          Posted via {p.viaChannel.toUpperCase()} — this comment came from
          automation, not a person typing.
        </Text>
      ) : null}
      {p.quote ? <Text style={textStyles.quote}>{p.quote}</Text> : null}
      <Text style={textStyles.paragraph}>{p.body}</Text>
      <Button href={p.url} style={textStyles.button}>
        Reply in context
      </Button>
    </Layout>
  );
}

export function commentNoticeText(p: CommentNoticeProps): string {
  return [
    `${p.authorEmail} commented on "${p.docTitle}"${p.viaChannel ? ` (via ${p.viaChannel.toUpperCase()})` : ""}.`,
    ``,
    p.quote ? `On: "${p.quote}"` : "",
    ``,
    p.body,
    ``,
    `Reply in context: ${p.url}`,
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}
