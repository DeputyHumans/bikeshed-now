// SPDX-License-Identifier: Apache-2.0
// The shell every transactional email shares (SPEC §14).

import * as React from "react";
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

/**
 * react-email escapes interpolated values by default, which is most of what
 * this shell is for: every value that reaches a template — document title,
 * display name, folder name — comes from user input.
 *
 * The colours are literal rather than imported from the brand tokens. An email
 * client has no CSS custom property support worth relying on, and a template
 * that renders differently depending on which build produced it is not a
 * template.
 */

const styles = {
  body: {
    margin: 0,
    padding: "24px 0",
    backgroundColor: "#f4f3f8",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    color: "#1a1a26",
  },
  container: {
    maxWidth: "520px",
    margin: "0 auto",
    padding: "32px",
    backgroundColor: "#ffffff",
    borderRadius: "12px",
    border: "1px solid rgba(26,26,38,0.14)",
  },
  wordmark: {
    margin: "0 0 24px",
    fontSize: "18px",
    fontWeight: 700,
    letterSpacing: "-0.01em",
    color: "#1a1a26",
  },
  accent: { color: "#4b3dd1" },
  rule: { borderColor: "rgba(26,26,38,0.14)", margin: "28px 0 16px" },
  footer: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "#55526b" },
  link: { color: "#3c30b0" },
} as const;

export interface LayoutProps {
  preview: string;
  origin: string;
  children: React.ReactNode;
  /** One sentence explaining why this message arrived. */
  footnote: string;
}

export function Layout({ preview, origin, children, footnote }: LayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.wordmark}>
            bikeshed<span style={styles.accent}>.now</span>
          </Text>
          <Section>{children}</Section>
          <Hr style={styles.rule} />
          <Text style={styles.footer}>
            {footnote}{" "}
            <Link href={`${origin}/account`} style={styles.link}>
              Manage email preferences
            </Link>
            .
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export const textStyles = {
  heading: {
    margin: "0 0 12px",
    fontSize: "20px",
    lineHeight: "28px",
    fontWeight: 650,
    letterSpacing: "-0.012em",
  },
  paragraph: { margin: "0 0 16px", fontSize: "15px", lineHeight: "23px" },
  quote: {
    margin: "0 0 16px",
    padding: "12px 14px",
    fontSize: "15px",
    lineHeight: "23px",
    color: "#55526b",
    backgroundColor: "#f4f3f8",
    borderLeft: "3px solid #b5257b",
    borderRadius: "0 6px 6px 0",
    whiteSpace: "pre-wrap" as const,
  },
  button: {
    display: "inline-block",
    padding: "11px 20px",
    borderRadius: "8px",
    backgroundColor: "#4b3dd1",
    color: "#ffffff",
    fontSize: "15px",
    fontWeight: 600,
    textDecoration: "none",
  },
  code: {
    margin: "0 0 16px",
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: "26px",
    letterSpacing: "0.22em",
    fontWeight: 600,
  },
} as const;
