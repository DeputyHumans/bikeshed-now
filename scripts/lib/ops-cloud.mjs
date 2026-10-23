// SPDX-License-Identifier: Apache-2.0
// Short-lived cloud credentials, bounded requests and paginated operational reads (SPEC §12).
import { execFileSync } from "node:child_process";

export class CloudError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function cloudClient({ account, fetcher = fetch, mint } = {}) {
  if (!mint && !account && !(process.env.CI && process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    throw new Error("Pass --account, or use CI Workload Identity Federation; implicit local credentials are refused");
  }
  const token = mint ?? (() => execFileSync("gcloud", ["auth", "print-access-token", ...(account ? [`--account=${account}`] : [])],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  let credential;
  async function request(url, { method = "GET", body, raw, headers = {} } = {}) {
    if (!url.startsWith("https://") || !new URL(url).hostname.endsWith(".googleapis.com")) throw new Error("Refusing credential forwarding outside Google APIs");
    for (let attempt = 0; attempt < 2; attempt++) {
      credential ??= await token();
      const res = await fetcher(url, {
        method, headers: { Authorization: `Bearer ${credential}`, "Content-Type": raw ? "text/plain" : "application/json", ...headers },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      if (res.status === 401 && attempt === 0) { credential = undefined; await res.arrayBuffer(); continue; }
      if (!res.ok) {
        // Server error bodies can contain configuration; never echo them into artifacts.
        await res.arrayBuffer();
        throw new CloudError(res.status, `${method} ${new URL(url).hostname}: HTTP ${res.status}`);
      }
      if (method === "DELETE" || res.status === 204) return {};
      if (headers.Accept === "text/plain") return res.text();
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }
    throw new Error("Credential refresh failed");
  }
  async function list(url, field) {
    const rows = [];
    let page;
    do {
      const target = new URL(url);
      if (page) target.searchParams.set("pageToken", page);
      const data = await request(target.href);
      rows.push(...(data[field] ?? [])); page = data.nextPageToken;
    } while (page);
    return rows;
  }
  return { request, list };
}

/** Compare desired fields only: the API adds output-only names and defaults. */
export function matchesShape(actual, desired) {
  // Protobuf JSON omits false-valued boolean fields in several Monitoring APIs.
  if (desired === false && actual === undefined) return true;
  if (Array.isArray(desired)) return Array.isArray(actual) && actual.length === desired.length && desired.every((v, i) => matchesShape(actual[i], v));
  if (desired && typeof desired === "object") return actual != null && Object.entries(desired).every(([k, v]) => matchesShape(actual[k], v));
  return actual === desired;
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) { const i = index++; results[i] = await fn(items[i], i); }
  }));
  return results;
}
