// SPDX-License-Identifier: Apache-2.0
// "Someone shared a document with you" (SPEC §14).

import { Button, Text } from "@react-email/components";
import { Layout, textStyles } from "./Layout";

/**
 * Without this message, sharing is silent: the grantee has no idea anything
 * happened until they next open the workspace, which for a first-time recipient
 * is never — they do not have an account yet.
 *
 * It doubles as the team-membership notification. Being added to a team silently
 * grants access to every document that team holds, which is the same silence
 * this message exists to break, so it is a BRANCH of this template rather than a
 * fourth message type.
 */
export interface InviteProps {
  origin: string;
  inviterEmail: string;
  /** The document or folder title, or the team name. */
  subjectTitle: string;
  kind: "document" | "folder" | "team";
  role: "viewer" | "editor";
  url: string;
}

export function Invite({ origin, inviterEmail, subjectTitle, kind, role, url }: InviteProps) {
  const verb = role === "editor" ? "edit" : "read";
  const what =
    kind === "team"
      ? `the ${subjectTitle} team`
      : `the ${kind} "${subjectTitle}"`;
  return (
    <Layout
      origin={origin}
      preview={`${inviterEmail} shared ${subjectTitle} with you`}
      footnote="You received this because someone granted you access."
    >
      <Text style={textStyles.heading}>{inviterEmail} shared something with you</Text>
      <Text style={textStyles.paragraph}>
        You can now {verb} {what}.
        {kind === "team"
          ? " That includes everything shared with the team, now and later."
          : ""}
      </Text>
      <Button href={url} style={textStyles.button}>
        Open it
      </Button>
      <Text style={{ ...textStyles.paragraph, marginTop: "16px", fontSize: "13px", color: "#55526b" }}>
        Sign in with the address this message was sent to. Anything shared with
        you before you had an account is waiting the moment you do.
      </Text>
    </Layout>
  );
}

/** The plain-text alternative. Built alongside so the two cannot drift. */
export function inviteText(p: InviteProps): string {
  const what = p.kind === "team" ? `the ${p.subjectTitle} team` : `"${p.subjectTitle}"`;
  return [
    `${p.inviterEmail} shared ${what} with you on Bikeshed.`,
    ``,
    `You can ${p.role === "editor" ? "edit" : "read"} it here:`,
    p.url,
    ``,
    `Sign in with the address this message was sent to.`,
    `Manage email preferences: ${p.origin}/account`,
  ].join("\n");
}
