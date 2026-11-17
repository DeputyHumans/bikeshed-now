// SPDX-License-Identifier: Apache-2.0
// The endpoint and MCP tool source files the shape tests read, found by what they declare (SPEC §2, §8).

/**
 * The shape tests pin how a handler is written — noStore before the first
 * status, the script lock before a stream — by reading its source. They read
 * src/index.ts by name, which holds while every endpoint lives there and checks
 * nothing once one moves: a test that asserts something is ABSENT passes on a
 * file that no longer holds the code. So a test names the declaration it is
 * about, and this finds the one file that holds it, or fails.
 */

const assert = require("node:assert/strict");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const SRC = join(__dirname, "..", "src");

function tsUnder(rel) {
  const dir = join(SRC, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => join(dir, f));
}

/** index.ts and every module under endpoints/: where each deployed function is declared. */
function endpointFiles() {
  return [join(SRC, "index.ts"), ...tsUnder("endpoints")];
}

/** The MCP tool table: tools.ts and every module under mcp/tools/. */
function toolFiles() {
  return [join(SRC, "mcp", "tools.ts"), ...tsUnder(join("mcp", "tools"))];
}

/** The text of the one file among `files` that contains `declaration`. */
function sourceDeclaring(declaration, files = endpointFiles()) {
  const hits = files.filter((f) => readFileSync(f, "utf8").includes(declaration));
  assert.equal(hits.length, 1, `exactly one source declares ${declaration} (found ${hits.length})`);
  return readFileSync(hits[0], "utf8");
}

module.exports = { endpointFiles, toolFiles, sourceDeclaring };
