// SPDX-License-Identifier: Apache-2.0
// A local stand-in for Resend's POST /emails that delivers into Mailpit, with failure injection (SPEC §14).

/**
 * The product sends mail only through the `resend` SDK (functions/src/email/
 * send.ts), and that SDK reads RESEND_BASE_URL once, at import. A stack points
 * it here; this answers the way Resend does and hands the message to Mailpit's
 * send API, where tests read it. Nothing leaves the machine.
 *
 *   POST /emails             Bearer required (401 / 403 shaped like Resend's);
 *                            forwarded to <mailpit>/api/v1/send; replies {id}
 *   POST /__e2e/fail-recipient  {to, status, count?, body?} — the next `count`
 *                            sends that name `to` (To, Cc or Bcc, exact address,
 *                            any case) answer `status` instead of delivering;
 *                            every other recipient is unaffected, so one spec
 *                            can inject failures on a SHARED stack
 *   GET  /__e2e/fail-recipient?to=   {to, pending}
 *   DELETE /__e2e/fail-recipient?to= drop that address's queued failures
 *   POST /__e2e/fail-next    {status, body?, count?} — the next send(s) of
 *                            ANYONE answer with that: never on a shared stack
 *   GET  /__e2e/requests[?to=]  what was received since start or the last
 *                            reset (only those naming `to`, when given)
 *   POST /__e2e/reset        clears that list and every queued failure: never
 *                            on a shared stack
 *   GET  /__e2e/health       {ok, mailpit, guard: whether the egress guard is
 *                            armed in this process, features}
 *   anything else            Resend-shaped 404
 *
 * Every /__e2e/ route answers loopback peers only (403 otherwise), and the
 * shim refuses to bind anything but a loopback address. A per-recipient
 * failure is checked before a fail-next one. Every request is one line in the
 * JSONL log, with its recipients (lowercased) whenever the body parses — a
 * refused one included, so a spec can see that the product TRIED to send.
 * The API key is never logged.
 *
 * Run as a process:  node shim.mjs --port N --mailpit URL --log FILE [--stack-dir D]
 *                    (expected key in E2E_SHIM_KEY, or --key K)
 */

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

function resendError(statusCode, name, message) {
  return { statusCode, name, message };
}

/** "Name <a@b>" | "a@b" → {Email, Name} for Mailpit. */
export function parseAddress(value) {
  const s = String(value ?? "").trim();
  const m = /^(.*)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s);
  if (m) return { Email: m[2], Name: m[1].trim().replace(/^"|"$/g, "") };
  return { Email: s, Name: "" };
}

const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Resend's /emails body → Mailpit's /api/v1/send body. */
export function toMailpit(body, shimId) {
  const headers = {};
  for (const [k, v] of Object.entries(body.headers ?? {})) headers[k] = String(v);
  headers["X-E2E-Shim-Id"] = shimId;
  const out = {
    From: parseAddress(body.from),
    To: list(body.to).map(parseAddress),
    Cc: list(body.cc).map(parseAddress),
    Bcc: list(body.bcc).map((a) => parseAddress(a).Email),
    ReplyTo: list(body.reply_to ?? body.replyTo).map(parseAddress),
    Subject: body.subject ?? "",
    Text: body.text ?? "",
    HTML: body.html ?? "",
    Headers: headers,
    Tags: list(body.tags).map((t) => (typeof t === "string" ? t : `${t.name}:${t.value}`)),
  };
  if (body.attachments) {
    out.Attachments = list(body.attachments).map((a) => ({ Filename: a.filename, Content: a.content, ContentType: a.content_type ?? a.contentType }));
  }
  return out;
}

/** Lowercased recipient addresses of a Resend body: to, cc, bcc. */
export function recipientsOf(body) {
  return [...list(body?.to), ...list(body?.cc), ...list(body?.bcc)].map((a) => parseAddress(a).Email.trim().toLowerCase()).filter(Boolean);
}

/** Whether a peer address is this machine (the only peers the control routes answer). */
export function isLoopbackAddress(addr) {
  const a = String(addr ?? "").toLowerCase();
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

/** The features a client can rely on (lib/mail/shimctl.mjs checks for them). */
export const SHIM_FEATURES = Object.freeze(["fail-next", "fail-recipient", "requests-by-recipient", "loopback-control", "hold-recipient"]);

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        rejectBody(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

/**
 * Start the shim.
 * @param {{host?:string, port?:number, mailpitUrl:string, logFile?:string, apiKey?:string}} o
 *   `apiKey` set: a Bearer that differs is refused with 403.
 * @returns {Promise<{url:string, port:number, requests:object[], close:()=>Promise<void>}>}
 */
export async function startShim({ host = "127.0.0.1", port = 0, mailpitUrl, logFile, apiKey } = {}) {
  if (!mailpitUrl) throw new Error("startShim: mailpitUrl is required");
  if (!isLoopbackAddress(host) && host !== "localhost") throw new Error(`startShim: refusing to bind ${host}; the shim listens on loopback only`);
  const mailpit = mailpitUrl.replace(/\/+$/, "");
  const requests = [];
  const failures = [];
  /** address (lowercased) → queued {status, body} failures for sends naming it */
  const byRecipient = new Map();
  const holds = new Map();
  const releaseHolds = (to) => {
    const hold = holds.get(to);
    if (!hold) return 0;
    holds.delete(to);
    const released = hold.waiters.size;
    for (const release of hold.waiters) release();
    return released;
  };
  const record = (entry) => {
    const line = { at: new Date().toISOString(), ...entry };
    requests.push(line);
    if (logFile) {
      try {
        appendFileSync(logFile, JSON.stringify(line) + "\n");
      } catch {}
    }
  };
  const send = (res, status, obj) => {
    const text = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  const failureBody = (status, body) => body ?? resendError(status, "application_error", "injected by the e2e shim");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://shim");
    const path = url.pathname;
    try {
      if (path.startsWith("/__e2e/") && !isLoopbackAddress(req.socket.remoteAddress)) {
        record({ route: path, method: req.method, status: 403, peer: req.socket.remoteAddress ?? null });
        return send(res, 403, { error: "the e2e control routes answer loopback peers only" });
      }
      if (req.method === "GET" && path === "/__e2e/health") return send(res, 200, { ok: true, mailpit, guard: !!globalThis[Symbol.for("bikeshed-e2e.egress-guard")], features: SHIM_FEATURES });
      if (req.method === "GET" && path === "/__e2e/requests") {
        const to = url.searchParams.get("to");
        const want = to ? to.trim().toLowerCase() : null;
        return send(res, 200, { requests: want ? requests.filter((r) => (r.recipients ?? []).includes(want)) : requests });
      }
      if (req.method === "POST" && path === "/__e2e/reset") {
        requests.length = 0;
        failures.length = 0;
        byRecipient.clear();
        for (const to of holds.keys()) releaseHolds(to);
        return send(res, 200, { ok: true });
      }
      if (path === "/__e2e/hold-recipient") {
        const spec = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
        const to = String(spec.to ?? url.searchParams.get("to") ?? "").trim().toLowerCase();
        if (!/^[^@\s<>]+@[^@\s<>]+$/.test(to)) return send(res, 400, { error: "`to` must be one exact email address" });
        if (req.method === "POST") {
          const stage = spec.stage ?? "headers";
          if (!["headers", "body"].includes(stage)) return send(res, 400, { error: "stage must be headers or body" });
          if (holds.has(to)) return send(res, 409, { error: "recipient is already held" });
          holds.set(to, { stage, received: 0, closed: 0, waiters: new Set() });
          return send(res, 200, { to, stage, armed: true });
        }
        if (req.method === "GET") {
          const hold = holds.get(to);
          return send(res, 200, { to, armed: !!hold, stage: hold?.stage ?? null, received: hold?.received ?? 0, closed: hold?.closed ?? 0, pending: hold?.waiters.size ?? 0 });
        }
        if (req.method === "DELETE") return send(res, 200, { to, released: releaseHolds(to) });
        return send(res, 405, { error: "GET, POST or DELETE" });
      }
      if (path === "/__e2e/fail-recipient") {
        if (req.method === "POST") {
          const spec = JSON.parse((await readBody(req)) || "{}");
          const to = String(spec.to ?? "").trim().toLowerCase();
          if (!/^[^@\s<>]+@[^@\s<>]+$/.test(to)) return send(res, 400, { error: "`to` must be one exact email address" });
          const status = Number(spec.status ?? 500);
          if (!(status >= 400 && status <= 599)) return send(res, 400, { error: "status must be 4xx or 5xx" });
          const count = Math.max(1, Math.min(1000, Number(spec.count ?? 1) || 1));
          const queue = byRecipient.get(to) ?? [];
          for (let i = 0; i < count; i++) queue.push({ status, body: failureBody(status, spec.body) });
          byRecipient.set(to, queue);
          return send(res, 200, { to, pending: queue.length });
        }
        const to = String(url.searchParams.get("to") ?? "").trim().toLowerCase();
        if (!to) return send(res, 400, { error: "?to=<address> is required" });
        if (req.method === "GET") return send(res, 200, { to, pending: byRecipient.get(to)?.length ?? 0 });
        if (req.method === "DELETE") {
          const dropped = byRecipient.get(to)?.length ?? 0;
          byRecipient.delete(to);
          return send(res, 200, { to, dropped });
        }
        return send(res, 405, { error: "GET, POST or DELETE" });
      }
      if (req.method === "POST" && path === "/__e2e/fail-next") {
        const spec = JSON.parse((await readBody(req)) || "{}");
        const status = Number(spec.status ?? 500);
        if (!(status >= 400 && status <= 599)) return send(res, 400, { error: "status must be 4xx or 5xx" });
        const body = failureBody(status, spec.body);
        for (let i = 0; i < Math.max(1, Number(spec.count ?? 1)); i++) failures.push({ status, body });
        return send(res, 200, { queued: failures.length });
      }
      if (req.method === "POST" && path === "/emails") {
        const auth = req.headers.authorization ?? "";
        const raw = await readBody(req);
        const ua = req.headers["user-agent"] ?? "";
        // Recipients are recorded even for a refused request: that the product
        // TRIED to send is the observable an email-off check needs.
        let peek = null;
        try {
          peek = JSON.parse(raw);
        } catch {}
        const seen = peek ? { recipients: recipientsOf(peek), subject: typeof peek.subject === "string" ? peek.subject : null } : {};
        if (!/^Bearer \S+$/.test(auth)) {
          record({ route: path, status: 401, auth: "missing", ua, ...seen });
          return send(res, 401, resendError(401, "missing_api_key", "Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY"));
        }
        if (apiKey && auth !== `Bearer ${apiKey}`) {
          record({ route: path, status: 403, auth: "invalid", ua, ...seen });
          return send(res, 403, resendError(403, "invalid_api_key", "API key is invalid"));
        }
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          record({ route: path, status: 422, auth: "ok", ua, error: "invalid JSON" });
          return send(res, 422, resendError(422, "validation_error", "Invalid JSON body"));
        }
        const recipients = recipientsOf(body);
        const summary = { from: body.from, to: list(body.to), recipients, subject: body.subject, ua };
        if (!body.from || list(body.to).length === 0 || typeof body.subject !== "string") {
          record({ route: path, status: 422, auth: "ok", ...summary, error: "missing field" });
          return send(res, 422, resendError(422, "validation_error", "Missing `from`, `to` or `subject` field."));
        }
        const heldFor = recipients.find((recipient) => holds.has(recipient));
        if (heldFor) {
          const hold = holds.get(heldFor);
          hold.received++;
          if (hold.stage === "body") {
            res.writeHead(200, { "content-type": "application/json" });
            res.write('{"id":');
          }
          record({ route: path, status: hold.stage === "body" ? 200 : null, auth: "ok", ...summary, held: true, heldFor, stage: hold.stage });
          await new Promise((resolve) => {
            const release = () => {
              if (hold.stage === "body") res.end('"released-without-delivery"}');
              else send(res, 503, resendError(503, "application_error", "held request released by the e2e shim"));
            };
            hold.waiters.add(release);
            res.once("close", () => { hold.waiters.delete(release); hold.closed++; resolve(); });
          });
          return;
        }
        const target = recipients.find((r) => (byRecipient.get(r)?.length ?? 0) > 0);
        if (target) {
          const queue = byRecipient.get(target);
          const f = queue.shift();
          if (queue.length === 0) byRecipient.delete(target);
          record({ route: path, status: f.status, auth: "ok", ...summary, injected: true, injectedFor: target });
          return send(res, f.status, f.body);
        }
        if (failures.length > 0) {
          const f = failures.shift();
          record({ route: path, status: f.status, auth: "ok", ...summary, injected: true });
          return send(res, f.status, f.body);
        }
        const id = randomUUID();
        let mailpitId = null;
        try {
          const r = await fetch(`${mailpit}/api/v1/send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(toMailpit(body, id)),
          });
          const text = await r.text();
          if (!r.ok) throw new Error(`Mailpit answered ${r.status}: ${text.slice(0, 300)}`);
          mailpitId = JSON.parse(text).ID ?? null;
        } catch (err) {
          record({ route: path, status: 500, auth: "ok", ...summary, error: err.message });
          return send(res, 500, resendError(500, "application_error", `e2e shim could not deliver to Mailpit: ${err.message}`));
        }
        record({ route: path, status: 200, auth: "ok", ...summary, id, mailpitId });
        return send(res, 200, { id });
      }
      record({ route: path, method: req.method, status: 404 });
      return send(res, 404, resendError(404, "not_found", "The requested endpoint does not exist."));
    } catch (err) {
      record({ route: path, status: 500, error: err.message });
      return send(res, 500, resendError(500, "application_error", err.message));
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host, port }, resolveListen);
  });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    requests,
    close: () => {
      for (const to of holds.keys()) releaseHolds(to);
      return new Promise((r) => server.close(() => r()));
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string" },
      mailpit: { type: "string" },
      log: { type: "string" },
      key: { type: "string" },
      "stack-dir": { type: "string" },
    },
  });
  if (!values.port || !values.mailpit) {
    console.error("usage: shim.mjs --port N --mailpit URL --log FILE [--key K] [--stack-dir D]");
    process.exit(2);
  }
  const shim = await startShim({
    host: values.host,
    port: Number(values.port),
    mailpitUrl: values.mailpit,
    logFile: values.log,
    // The key arrives by env rather than argv, where every `ps` could read it.
    apiKey: values.key ?? process.env.E2E_SHIM_KEY,
  });
  console.log(`e2e resend shim listening on ${shim.url} → ${values.mailpit} (stack ${values["stack-dir"] ?? "-"})`);
  const stop = () => shim.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
