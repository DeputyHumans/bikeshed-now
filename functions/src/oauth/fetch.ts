// SPDX-License-Identifier: Apache-2.0
// The one outbound fetch: a client's metadata document, guarded against SSRF (SPEC §23).

import { lookup as dnsLookup, type LookupAddress } from "dns";
import { request } from "https";
import type { IncomingMessage } from "http";
import { isIP } from "net";

/**
 * Why this is not `fetch(url)`.
 *
 * A client metadata document's URL is chosen by whoever is asking to connect,
 * and this server fetches it. That is server-side request forgery by design,
 * so the request is narrowed until only a public HTTPS host can answer:
 *
 *   - https on 443, a hostname rather than an IP literal, no credentials,
 *     no internal-looking names
 *   - the ADDRESS ACTUALLY CONNECTED TO must be public. Resolving first and
 *     fetching second lets the name resolve again, differently, in between —
 *     DNS rebinding — so the check sits in the socket's own `lookup`
 *   - no redirect is followed, the body is capped, and the whole exchange is
 *     bounded in time
 *
 * It is also only ever reached from the consent endpoint, behind a signed-in
 * account, never from an anonymous one.
 */

export const METADATA_TIMEOUT_MS = 5000;
export const METADATA_MAX_BYTES = 16 * 1024;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4Public(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of V4_BLOCKED) {
    const b = ipv4ToInt(base) as number;
    const size = 2 ** (32 - bits);
    if (n >= b && n < b + size) return false;
  }
  return true;
}

/** Eight 16-bit groups, or null. Accepts `::` and a dotted IPv4 tail. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.includes("%")) return null; // a zone id is link-local by definition
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4ToInt(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  if (tail.length === 2) {
    out[6] = tail[0];
    out[7] = tail[1];
  }
  return out;
}

function v6Public(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return false;
  const allZeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::  and  ::1
  if (allZeroTo(7) && (g[7] === 0 || g[7] === 1)) return false;
  // IPv4-mapped ::ffff:a.b.c.d — judged as the IPv4 address it carries
  if (allZeroTo(5) && g[5] === 0xffff) {
    return v4Public(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  // IPv4-compatible ::a.b.c.d (deprecated) — never a real public host
  if (allZeroTo(6)) return false;
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48 translate to an IPv4 address of
  // the attacker's choosing, metadata servers included
  if (g[0] === 0x64 && g[1] === 0xff9b) return false;
  // 100::/64 discard
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false;
  // 2001::/23 protocol assignments (Teredo among them), 2001:db8::/32 documentation
  if (g[0] === 0x2001 && g[1] < 0x200) return false;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false;
  // 2002::/16 6to4 embeds an IPv4 address
  if (g[0] === 0x2002) return false;
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast
  if ((g[0] & 0xfe00) === 0xfc00) return false;
  if ((g[0] & 0xffc0) === 0xfe80) return false;
  if ((g[0] & 0xff00) === 0xff00) return false;
  return true;
}

/** True only for an address on the public internet. Anything unparseable is not. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Public(ip);
  if (family === 6) return v6Public(ip);
  return false;
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".corp"];

/**
 * Is this a URL a client metadata document may live at?
 *
 * The draft requires https and a path; this adds what an SSRF guard needs on
 * top: port 443, no credentials, no fragment, and a hostname rather than an IP
 * literal, so the address can only come through the guarded lookup.
 */
export function checkMetadataUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!/^[\x21-\x7e]+$/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.hash) return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (url.pathname === "/" || url.pathname === "") return null;
  const host = url.hostname;
  if (host.startsWith("[") || isIP(host) !== 0) return null;
  if (!host.includes(".") || host === "localhost") return null;
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return url;
}

type LookupFn = typeof dnsLookup;

/**
 * A `lookup` for the socket that refuses to hand back a non-public address.
 *
 * Every address the name resolves to must be public, not just the first: a
 * resolver returning one public and one private address is the rebinding
 * attack in miniature.
 */
export function guardedLookup(resolve: LookupFn = dnsLookup) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
  ): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = (Array.isArray(addresses) ? addresses : []) as LookupAddress[];
      if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
        const refused = new Error(`refused to connect to ${hostname}: not a public address`) as NodeJS.ErrnoException;
        refused.code = "EREFUSED_PRIVATE";
        return callback(refused);
      }
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * Read a metadata response: 200 only, within the size cap, as JSON.
 *
 * Separate from the transport so it can be tested against a stream without a
 * TLS server.
 */
export function readMetadataResponse(
  res: IncomingMessage,
  maxBytes: number = METADATA_MAX_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (res.statusCode !== 200) {
      res.resume();
      reject(new Error(`metadata answered ${res.statusCode}; redirects are not followed`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        reject(new Error("metadata document is too large"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      if (size > maxBytes) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("metadata document is not JSON"));
      }
    });
    res.on("error", reject);
  });
}

export interface FetchOptions {
  lookup?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Fetch a client metadata document from an already-checked URL. */
export function fetchClientMetadata(url: URL, opts: FetchOptions = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? METADATA_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "application/json", "user-agent": "bikeshed-oauth" },
        lookup: guardedLookup(opts.lookup) as never,
        servername: url.hostname,
        timeout: timeoutMs,
      },
      (res) => {
        readMetadataResponse(res, opts.maxBytes).then(resolve, reject);
      },
    );
    // `timeout` is socket inactivity; this bounds the whole exchange.
    const deadline = setTimeout(() => req.destroy(new Error("metadata fetch timed out")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("metadata fetch timed out")));
    req.on("error", reject);
    req.on("close", () => clearTimeout(deadline));
    req.end();
  });
}
