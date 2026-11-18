// SPDX-License-Identifier: Apache-2.0
// The browser's zip is the CLI's, byte for byte, pinned by the golden vectors (SPEC §2).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { storedZip } from "./zip";

const VECTORS = JSON.parse(readFileSync(join(__dirname, "..", "..", "tools", "fixtures", "zip-vectors.json"), "utf8"));

describe("storedZip", () => {
  it("writes the golden bytes for every vector", () => {
    for (const v of VECTORS.vectors) {
      const zip = storedZip(v.entries.map((e: { name: string; utf8: string }) => ({ name: e.name, data: new TextEncoder().encode(e.utf8) })));
      expect(zip.length, v.name).toBe(v.bytes);
      expect(createHash("sha256").update(zip).digest("hex"), v.name).toBe(v.sha256);
    }
  });
});
