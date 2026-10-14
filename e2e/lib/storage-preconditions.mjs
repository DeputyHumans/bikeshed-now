// SPDX-License-Identifier: Apache-2.0
// Whether a stack's Storage refuses a second create-only write and copy (ifGenerationMatch=0), which the product's CREATE_ONLY rests on: the readiness probe, the live status and the capability `storage-preconditions` (SPEC §4, §12, §21).

/**
 * A new document's bytes go in CREATE_ONLY (functions/src/lib/publish.ts,
 * `{preconditionOpts: {ifGenerationMatch: 0}}`): two creates racing at one id
 * rely on Storage refusing the second write with 412, which moves it to a
 * suffixed id (SPEC §4). A fork copies its bytes the same way (fork.ts,
 * `copy(…, CREATE_ONLY)`, SPEC §21). Cloud Storage implements generation
 * preconditions; the Storage emulator of firebase-tools 15.25.1 has none at
 * all (no `ifGenerationMatch` anywhere in lib/emulator/storage): it accepts the
 * second write and keeps the last bytes. A case whose property rests on the
 * refusal (C17a, the one-click forks, a fix proof for a lost create) cannot
 * hold on such a stack, so it declares `needs: ["storage-preconditions"]` and
 * is SKIPPED there, declaratively, rather than ending INCONCLUSIVE after a
 * probe of its own.
 *
 * THE PROBE, on the stack's Storage emulator over its JSON API, as the
 * emulator's admin (`Authorization: Bearer owner`), under one fresh prefix
 * `e2e-probe/storage-preconditions/<label>-<12 hex>/` (never under docs/):
 *
 *   write  upload `write.txt` "first" with ifGenerationMatch=0 (must be 200),
 *          then "second" with ifGenerationMatch=0, then read it back:
 *          honoured = the second answered 412 AND the object still reads
 *          "first"; accepted (2xx) = not honoured; anything else = unknown.
 *   copy   upload `copy-source.txt` and `copy-destination.txt` (200 each),
 *          then rewrite the source onto the destination with
 *          ifGenerationMatch=0 (the path the Node SDK takes under
 *          STORAGE_EMULATOR_HOST: `/b/<bucket>/o/<src>/rewriteTo/b/<bucket>/o/<dst>`),
 *          then read the destination: honoured = 412 AND it still reads
 *          "destination".
 *
 * `honoured` is true only when BOTH are; false when either was accepted
 * (CREATE_ONLY does not hold); null when the probe could not tell (a set-up
 * write refused, a status other than 2xx or 412, the emulator unreachable).
 * Every object is deleted afterwards (`cleaned`, and `left` names any that
 * could not be). The probe never throws but for bad arguments, and refuses a
 * Storage that is not on loopback: it only ever writes to an emulator.
 *
 * startStack's readiness runs it once (stack.mjs waitReady) and records it as
 * `rec.storagePreconditions`; options.mjs capabilitiesFor adds the capability
 * only when `honoured === true`. A stack started before this probe has no
 * record and so no capability (its emulator does not honour them either).
 * `storagePreconditionsStatus(target)` runs the same probe live on any local
 * stack. A production target (built by a later phase) advertises the
 * capability without probing: Cloud Storage implements ifGenerationMatch, and
 * this probe never writes to a real bucket.
 *
 * Both probe the Storage THE FUNCTIONS USE: on a stack built with
 * `--storage-shim` that is the shim (lib/storage-shim.mjs), which judges
 * ifGenerationMatch in front of the emulator, so such a stack's probe finds
 * honoured: true and earns the capability; on any other stack, the emulator.
 */

import { randomBytes } from "node:crypto";

/** The capability a target has when its Storage refuses a second create-only write and copy. */
export const STORAGE_PRECONDITIONS = "storage-preconditions";
/** Where the probe's objects go, under the stack's bucket (never under docs/). */
export const STORAGE_PROBE_PREFIX = "e2e-probe/storage-preconditions";
/** The Storage emulator's admin credential (rules are not evaluated for it). */
export const STORAGE_ADMIN_BEARER = "Bearer owner";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SHOWN = 64;

function checkArgs({ storageUrl, bucket, label, fetchImpl, timeoutMs }) {
  let u;
  try {
    u = new URL(String(storageUrl));
  } catch {
    throw new TypeError(`probeStoragePreconditions: storageUrl is the Storage emulator's http://127.0.0.1:<port>, got ${JSON.stringify(storageUrl)}`);
  }
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname) || (u.pathname !== "/" && u.pathname !== "")) {
    throw new TypeError(`probeStoragePreconditions: storageUrl must be a loopback emulator origin (it writes objects; never a real bucket), got ${JSON.stringify(storageUrl)}`);
  }
  if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9._-]{1,220}$/.test(bucket)) throw new TypeError(`probeStoragePreconditions: bucket is a bucket name, got ${JSON.stringify(bucket)}`);
  if (label !== null && (typeof label !== "string" || !LABEL_RE.test(label))) throw new TypeError(`probeStoragePreconditions: label is null or /${LABEL_RE.source}/ (a run id), got ${JSON.stringify(label)}`);
  if (typeof fetchImpl !== "function") throw new TypeError("probeStoragePreconditions: fetchImpl is a fetch");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError(`probeStoragePreconditions: timeoutMs is 1 to 60000, got ${JSON.stringify(timeoutMs)}`);
  return u.origin;
}

/**
 * Probe a Storage emulator's create-only writes and copies (see the header).
 * @param {{storageUrl:string, bucket:string, label?:string|null, fetchImpl?:typeof fetch, timeoutMs?:number}} o
 * @returns {Promise<{honoured:boolean|null, write:object, copy:object, prefix:string, cleaned:boolean, left:string[], reason:string|null, ms:number}>}
 */
export async function probeStoragePreconditions({ storageUrl, bucket, label = null, fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const origin = checkArgs({ storageUrl, bucket, label, fetchImpl, timeoutMs });
  const t0 = Date.now();
  const prefix = `${STORAGE_PROBE_PREFIX}/${label ? `${label}-` : ""}${randomBytes(6).toString("hex")}`;
  const names = { write: `${prefix}/write.txt`, source: `${prefix}/copy-source.txt`, destination: `${prefix}/copy-destination.txt` };
  const enc = encodeURIComponent;
  const b = enc(bucket);

  const call = async (method, url, { body = undefined, contentType = null } = {}) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers = { authorization: STORAGE_ADMIN_BEARER };
      if (contentType) headers["content-type"] = contentType;
      const r = await fetchImpl(url, { method, headers, body, signal: ac.signal, redirect: "manual" });
      const text = await r.text();
      return { status: r.status, text };
    } catch (err) {
      return { status: 0, text: String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  };
  const upload = (name, text, createOnly) =>
    call("POST", `${origin}/upload/storage/v1/b/${b}/o?uploadType=media&name=${enc(name)}${createOnly ? "&ifGenerationMatch=0" : ""}`, { body: text, contentType: "text/plain" });
  const rewrite = (from, to) =>
    call("POST", `${origin}/b/${b}/o/${enc(from)}/rewriteTo/b/${b}/o/${enc(to)}?ifGenerationMatch=0`, { body: "{}", contentType: "application/json" });
  const read = async (name) => {
    const r = await call("GET", `${origin}/b/${b}/o/${enc(name)}?alt=media`);
    return r.status === 200 ? r.text.slice(0, SHOWN) : null;
  };
  const ok = (s) => s >= 200 && s < 300;
  const judge = (part, setUp, decisive, after, want) => {
    if (!setUp.every(ok)) return { honoured: null, why: `${part}: a set-up write answered ${setUp.join(", ")}` };
    if (decisive === 412 && after === want) return { honoured: true, why: null };
    if (decisive === 412) return { honoured: null, why: `${part}: refused with 412, yet the object reads ${JSON.stringify(after)}, not ${JSON.stringify(want)}` };
    if (ok(decisive)) return { honoured: false, why: `${part}: a second create-only ${part === "write" ? "write" : "copy"} onto an existing object was accepted (${decisive}), and the object now reads ${JSON.stringify(after)}` };
    return { honoured: null, why: `${part}: the create-only ${part === "write" ? "write" : "copy"} answered ${decisive || "nothing (unreachable)"}` };
  };

  const write = {};
  const copy = {};
  let left = [];
  try {
    write.first = (await upload(names.write, "first", true)).status;
    write.second = ok(write.first) ? (await upload(names.write, "second", true)).status : null;
    write.after = ok(write.first) ? await read(names.write) : null;
    const w = judge("write", [write.first], write.second, write.after, "first");
    Object.assign(write, { refused: write.second === 412, kept: write.after === "first", honoured: w.honoured, reason: w.why });

    copy.source = (await upload(names.source, "source", true)).status;
    copy.destination = (await upload(names.destination, "destination", true)).status;
    const setUp = [copy.source, copy.destination];
    copy.rewrite = setUp.every(ok) ? (await rewrite(names.source, names.destination)).status : null;
    copy.after = setUp.every(ok) ? await read(names.destination) : null;
    const c = judge("copy", setUp, copy.rewrite, copy.after, "destination");
    Object.assign(copy, { refused: copy.rewrite === 412, kept: copy.after === "destination", honoured: c.honoured, reason: c.why });
  } finally {
    // Cleaned whatever happened above; a 404 is an object that was never made.
    const gone = [];
    for (const name of Object.values(names)) {
      const r = await call("DELETE", `${origin}/b/${b}/o/${enc(name)}`);
      if (!(ok(r.status) || r.status === 404)) gone.push(name);
    }
    left = gone;
  }
  const parts = [write.honoured, copy.honoured];
  const honoured = parts.includes(false) ? false : parts.every((h) => h === true) ? true : null;
  const reason = honoured === true ? null : [write.reason, copy.reason].filter(Boolean).join("; ") || "the probe could not tell";
  return { honoured, write, copy, prefix, cleaned: left.length === 0, left, reason, ms: Date.now() - t0 };
}

/** One line for a log: what the probe found. */
export function storagePreconditionsLine(r) {
  if (!r || typeof r !== "object") return "Storage create-only writes: not probed";
  if (r.honoured === true) return "Storage refuses a second create-only write and copy (412) and keeps the first: capability storage-preconditions";
  if (r.honoured === false) return `Storage does NOT honour create-only writes (no capability storage-preconditions): ${r.reason}`;
  return `Storage create-only writes could not be probed (no capability storage-preconditions): ${r.reason ?? r.error ?? "unknown"}`;
}

/**
 * The probe, live, on a target: the Storage a local stack's functions use
 * (its Storage shim on a --storage-shim stack, else its emulator, the
 * storageUrl; the port must be one of the stack's own), resolving
 * `{checked: true, via: "shim"|"emulator", storageUrl, ...probe}`. Any other
 * target resolves `{checked: false, honoured: null, reason}`: a production
 * bucket is never probed (Cloud Storage implements generation preconditions,
 * and its target advertises the capability).
 *
 *   const s = await storagePreconditionsStatus(ctx.target);
 *   if (!s.honoured) ctx.inconclusive(`Storage: ${s.reason}`);
 *
 * (or declare `needs: ["storage-preconditions"]`, which a stack has when its
 * readiness proved the same thing.)
 */
export async function storagePreconditionsStatus(target, { fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  if (!target || typeof target !== "object") throw new TypeError("storagePreconditionsStatus: target is a loadTarget() target");
  if (target.kind !== "local" || typeof target.storageUrl !== "string") {
    return { checked: false, honoured: null, reason: `only a local stack's Storage emulator is probed (a ${target.kind} target's bucket never is; Cloud Storage implements ifGenerationMatch, and such a target advertises ${STORAGE_PRECONDITIONS})` };
  }
  // The functions' Storage: the shim on a --storage-shim stack (lib/storage-shim.mjs), else the emulator.
  const shimPort = target.stack?.ports?.storageShim;
  const via = target.options?.storageShim === true && Number.isInteger(shimPort) ? "shim" : "emulator";
  const storageUrl = via === "shim" ? `http://127.0.0.1:${shimPort}` : target.storageUrl;
  const port = Number(new URL(storageUrl).port);
  const ports = Object.values(target.stack?.ports ?? {});
  if (!ports.includes(port)) throw new Error(`storagePreconditionsStatus: ${storageUrl} is not one of run ${target.runId}'s ports`);
  const r = await probeStoragePreconditions({ storageUrl, bucket: target.bucket, label: target.runId, fetchImpl, timeoutMs });
  return { checked: true, via, storageUrl, ...r };
}
