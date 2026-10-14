// SPDX-License-Identifier: Apache-2.0
// Driving the stack's Resend shim from a spec: per-recipient failure injection and what it received for your recipients (SPEC §14).

/**
 *   const shim = shimControl(target);
 *   await shim.failRecipient(invitee, { status: 500, count: 1 });  // only sends naming invitee fail
 *   … the product sends …
 *   const got = await shim.requests({ to: invitee });              // [{status, injected, recipients, subject, …}]
 *   await shim.pending(invitee);                                   // failures still queued for it
 *   await shim.clear(invitee);                                     // drop them (do it in finally)
 *
 * Everything is keyed by ONE exact recipient address, so a spec can inject
 * failures and read results on a stack other specs are using at the same
 * time: use an address only your spec mints (accounts.mjs, or
 * `<role>-<run6>-<rand4>@example.com`). The shim's global /__e2e/fail-next and
 * /__e2e/reset affect every spec on the stack and are not offered here.
 *
 * Requests go through http.mjs (the stack's ports only, traced, redacted).
 * Requires the `mail-fail-recipient` capability (a stack this harness version
 * built).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHttp } from "../http.mjs";
import { requireCapability } from "../target.mjs";

const lower = (s) => String(s ?? "").trim().toLowerCase();

/**
 * @param {object} target
 * @param {object} [o]  {http} to reuse a client, or {evidence} for a new one
 */
export function shimControl(target, o = {}) {
  requireCapability(target, "mail-fail-recipient");
  const http = o.http ?? createHttp(target, { actor: "shim-control", evidence: o.evidence });
  const base = target.mail.shimUrl;
  const one = (to) => {
    const t = lower(to);
    if (!/^[^@\s<>]+@[^@\s<>]+$/.test(t)) throw new Error(`shimControl: ${JSON.stringify(to)} is not one exact address`);
    return t;
  };
  return {
    /** Make the next `count` sends naming `to` answer `status` (and `body`) instead of delivering. */
    async failRecipient(to, { status = 500, count = 1, body } = {}) {
      const r = await http.postJson(`${base}/__e2e/fail-recipient`, { to: one(to), status, count, ...(body !== undefined ? { body } : {}) }, { expect: 200 });
      return r.json;
    },
    /** How many injected failures are still queued for `to`. */
    async pending(to) {
      return (await http.get(`${base}/__e2e/fail-recipient`, { query: { to: one(to) }, expect: 200 })).json.pending;
    },
    /** Drop every failure queued for `to`. */
    async clear(to) {
      return (await http.delete(`${base}/__e2e/fail-recipient`, { query: { to: one(to) }, expect: 200 })).json;
    },
    /** What the shim received naming `to` (refused and injected requests included), oldest first. */
    async requests({ to } = {}) {
      return (await http.get(`${base}/__e2e/requests`, { query: { to: one(to) }, expect: 200 })).json.requests;
    },
    async health() {
      return (await http.get(`${base}/__e2e/health`, { expect: 200 })).json;
    },
  };
}

/**
 * The stack's dummy Resend key (what the shim expects), for a canary that
 * exercises the shim directly. Read from the stack tree, never from target.json.
 */
export function shimKey(target) {
  if (target.kind !== "local") throw new Error("shimKey: local stacks only");
  for (const [file, re] of [
    [join(target.stack.treeDir, ".e2e", "shim-key"), /^(re_e2e_[0-9a-f]+)\s*$/],
    [join(target.stack.treeDir, "functions", ".secret.local"), /^RESEND_API_KEY=(re_e2e_[0-9a-f]+)$/m],
  ]) {
    try {
      const m = re.exec(readFileSync(file, "utf8"));
      if (m) return m[1];
    } catch {}
  }
  throw new Error(`stack ${target.runId} has no dummy Resend key`);
}
