// SPDX-License-Identifier: Apache-2.0
// "Enter this code to delete it forever" (SPEC §4, §14).

import { Text } from "@react-email/components";
import { Layout, textStyles } from "./Layout";

/**
 * The second factor for deleting forever (ADR 0025). It names what the code
 * deletes, so a code nobody asked for says exactly what someone signed in as
 * this account is trying to destroy, and that ignoring it keeps it.
 */
export interface PurgeCodeProps {
  origin: string;
  code: string;
  minutes: number;
  /** What goes, as a sentence's object: "“Plan” and its 7 versions". */
  what: string;
}

export function PurgeCode({ origin, code, minutes, what }: PurgeCodeProps) {
  return (
    <Layout
      origin={origin}
      preview={`Your code to delete from your Trash is ${code}`}
      footnote="You received this because someone signed in to this account asked to delete something from its Trash."
    >
      <Text style={textStyles.heading}>Delete from your Trash forever</Text>
      <Text style={textStyles.paragraph}>
        Enter this code to delete {what} for good. It expires in {minutes} minutes
        and can be used once.
      </Text>
      <Text style={textStyles.code}>{code}</Text>
      <Text style={{ ...textStyles.paragraph, fontSize: "13px", color: "#55526b" }}>
        If you did not ask for this, ignore this message: nothing is deleted without
        the code, and you may want to sign out of computers you no longer use.
      </Text>
    </Layout>
  );
}

export function purgeCodeText(p: PurgeCodeProps): string {
  return [
    `Your code to delete ${p.what} from your Trash for good is ${p.code}.`,
    ``,
    `It expires in ${p.minutes} minutes and can be used once.`,
    `If you did not ask for this, ignore this message: nothing is deleted without the code.`,
    ``,
    `${p.origin}`,
  ].join("\n");
}
