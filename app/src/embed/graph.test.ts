// SPDX-License-Identifier: Apache-2.0
// The embed page imports nothing that reaches the app: no router, no sign-in, no Firestore (SPEC §2 "GET /embed/…", §23).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Any site may frame the embed page. Every app-shell path refuses to be
 * framed because the app can reach sign-up and the consent page by client-side
 * navigation (SPEC §23), so the embed page is safe to frame only while it
 * carries none of the app. This walks every import from its entry, static and
 * dynamic, through the source, and holds the set to that.
 */

const SRC = resolve(__dirname, "..");
const ENTRY = join(SRC, "embed", "main.ts");

/** Bare packages the embed may load: Firebase's core and Analytics, and nothing that signs in or reads data. */
const ALLOWED_PACKAGES = new Set(["firebase/app", "firebase/analytics"]);

/** Modules that would make the embed page a way into the app, or start what it must not. */
const FORBIDDEN = [/^App\.tsx$/, /^main\.tsx$/, /^firebase\.ts$/, /^auth\.tsx$/, /^firestore\.ts$/, /^pages\//, /^components\//];

/** Every specifier a value import, re-export or dynamic import names. Type-only imports are erased and skipped. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /^\s*import\s+(?!type\b)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    /^\s*export\s+(?!type\b)[^"';]*?\s+from\s+["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

function resolveLocal(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${spec} from ${relative(SRC, from)}`);
}

function graph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (spec.endsWith(".css")) continue;
      if (spec.startsWith(".")) pending.push(resolveLocal(file, spec));
      else packages.add(spec);
    }
  }
  return { files: [...files].map((f) => relative(SRC, f)).sort(), packages: [...packages].sort() };
}

describe("the embed page's imports", () => {
  const { files, packages } = graph(ENTRY);

  it("reach none of the app", () => {
    const offending = files.filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)));
    expect(offending).toEqual([]);
  });

  it("load only Firebase's core and Analytics", () => {
    expect(packages.filter((name) => !ALLOWED_PACKAGES.has(name))).toEqual([]);
  });

  it("see the modules it is built from, so the walk itself is not empty", () => {
    // A walk that resolved nothing would pass both checks above.
    expect(files).toEqual(expect.arrayContaining(["embed/main.ts", "embed/embed.ts", "analytics.ts", "stats.ts", "viewer/outboundLinks.ts"]));
    expect(packages).toEqual(expect.arrayContaining(["firebase/analytics", "firebase/app"]));
  });
});
