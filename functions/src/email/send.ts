// SPDX-License-Identifier: Apache-2.0
// The one place email leaves this system (SPEC §14).

import type { ReactElement } from "react";
import { RESEND_API_KEY, mailFrom, publicOrigin } from "../config";

/**
 * Email is OPTIONAL, and that is a requirement rather than a nicety.
 *
 * With no Resend key configured every send is a logged no-op and the product
 * behaves exactly as it does with one. That is what lets the quickstart run
 * without a Resend account, and it is the path CI exercises — the configured
 * path is the one that gets manual attention, so the unconfigured path is the
 * one that has to be tested.
 *
 * Every send is also wrapped so it can never fail the request it rode in on.
 * Sharing a document must not fail because an invitation bounced.
 */

export interface SendResult {
  sent: boolean;
  reason?: "no_api_key" | "failed";
}

/** The sender address. See config.mailFrom() for why it is not the serving host. */
function fromAddress(): string {
  return mailFrom();
}

/**
 * The configured key, or "" for "email is off".
 *
 * TRIMMED, and that is load-bearing rather than tidy. `defineSecret` makes the
 * secret mandatory at DEPLOY time — a deploy fails outright if no version
 * exists — while Secret Manager refuses to store an empty payload. So the only
 * way a real deployment can express "email is disabled" is a whitespace
 * payload, and without this trim the documented optional path is unreachable
 * anywhere but the emulator.
 *
 * It also absorbs the commonest real mistake: `echo $KEY | firebase
 * functions:secrets:set` stores a trailing newline, which would otherwise be
 * sent to Resend verbatim and rejected on every message.
 */
function apiKey(): string {
  try {
    return (RESEND_API_KEY.value() || "").trim();
  } catch {
    // .value() throws when the secret is not bound to the running function,
    // which is the same situation as "not configured".
    return "";
  }
}

export interface Message {
  to: string;
  subject: string;
  /** A react-email component tree. Rendered only when a key is configured. */
  body: ReactElement;
  /**
   * The plain-text alternative.
   *
   * Always supplied by the caller rather than derived, because the one place
   * raw markup would be tempting — a comment body inside a notification — must
   * be plain text with a link back, never HTML (SPEC §14).
   */
  text: string;
}

export async function sendEmail(message: Message): Promise<SendResult> {
  const key = apiKey();
  if (!key) {
    console.info(
      `[email] skipped "${message.subject}" to ${message.to}: no API key configured`,
    );
    return { sent: false, reason: "no_api_key" };
  }

  try {
    // React and the email renderer are imported HERE, inside the only code path
    // that needs them. A static import would load React into `session`,
    // `contentProxy` and every other hot function, paying a cold-start cost on
    // requests that will never send anything.
    const [{ Resend }, { render }] = await Promise.all([
      import("resend"),
      import("@react-email/render"),
    ]);
    const html = await render(message.body);
    const resend = new Resend(key);
    const { error } = await resend.emails.send({
      from: fromAddress(),
      to: message.to,
      subject: message.subject,
      html,
      text: message.text,
    });
    if (error) {
      console.warn(`[email] send failed: ${error.message}`);
      return { sent: false, reason: "failed" };
    }
    return { sent: true };
  } catch (e) {
    console.warn(`[email] send threw: ${(e as Error).message}`);
    return { sent: false, reason: "failed" };
  }
}

/** Absolute link to a document, for use in an email body. */
export function documentUrl(docId: string, versionId?: string): string {
  const base = publicOrigin();
  return versionId ? `${base}/d/${docId}/${versionId}` : `${base}/d/${docId}`;
}
