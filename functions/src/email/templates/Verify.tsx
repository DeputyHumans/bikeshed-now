// SPDX-License-Identifier: Apache-2.0
// "Confirm this is your address" (SPEC §14).

import { Text } from "@react-email/components";
import { Layout, textStyles } from "./Layout";

/**
 * This message is the reason GitHub sign-in is safe here.
 *
 * The ACL is keyed by email, so anything shared with an address lights up the
 * moment someone signs in with it. GitHub does not generally assert
 * `email_verified`, so without this flow an attacker who signs in with someone
 * else's unverified address would be handed their documents. Sign-up BLOCKS on
 * this code, and completing it writes Firebase's own `emailVerified` field —
 * one gate, one source of truth, no second notion of verification.
 */
export interface VerifyProps {
  origin: string;
  code: string;
  minutes: number;
}

export function Verify({ origin, code, minutes }: VerifyProps) {
  return (
    <Layout
      origin={origin}
      preview={`Your Bikeshed verification code is ${code}`}
      footnote="You received this because someone entered this address when signing up."
    >
      <Text style={textStyles.heading}>Confirm your email address</Text>
      <Text style={textStyles.paragraph}>
        Enter this code to finish signing in. It expires in {minutes} minutes and
        can be used once.
      </Text>
      <Text style={textStyles.code}>{code}</Text>
      <Text style={{ ...textStyles.paragraph, fontSize: "13px", color: "#55526b" }}>
        If you did not try to sign in, ignore this message — nothing has been
        granted to this address.
      </Text>
    </Layout>
  );
}

export function verifyText(p: VerifyProps): string {
  return [
    `Your Bikeshed verification code is ${p.code}.`,
    ``,
    `It expires in ${p.minutes} minutes and can be used once.`,
    `If you did not try to sign in, ignore this message.`,
    ``,
    `${p.origin}`,
  ].join("\n");
}
