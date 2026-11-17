// SPDX-License-Identifier: Apache-2.0
// Self-test helper: the product's endpoint and MCP tool sources, file by file or as one text (SPEC §12).

/**
 * The guard and trigger self-tests parse the product's source to learn which
 * functions exist, which can send email and which write comments. Read by one
 * file name, a parse goes quiet the day the code it is looking for moves: it
 * finds fewer functions, and every gap it would have reported for them closes.
 * So both are every file of their kind, and each self-test also pins what it
 * must find. A parse that reads declarations wants the files apart: run
 * together, the last declaration of one file would take in the next file's
 * imports, and an import naming MAILING reads as a function bound to it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../lib/paths.mjs";

const SRC = join(REPO_ROOT, "functions", "src");

function tsUnder(rel) {
  const dir = join(SRC, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => join(rel, f));
}

/** functions/src-relative paths: index.ts and every module under endpoints/. */
export const ENDPOINT_FILES = Object.freeze(["index.ts", ...tsUnder("endpoints")]);

/** functions/src-relative paths: the MCP tool table and the management tools. */
export const TOOL_FILES = Object.freeze([join("mcp", "tools.ts"), ...tsUnder(join("mcp", "tools")), join("mcp", "management.ts")]);

const read = (files) => files.map((f) => readFileSync(join(SRC, f), "utf8"));

/** Each endpoint source's text, one entry per file. */
export const endpointTexts = () => read(ENDPOINT_FILES);

/** Each MCP tool source's text, one entry per file. */
export const toolTexts = () => read(TOOL_FILES);

/** Every endpoint source, as one text, for a pattern that matches within a line. */
export const endpointSource = () => endpointTexts().join("\n");

/** Every MCP tool source, as one text, for a pattern that matches within a line. */
export const toolSource = () => toolTexts().join("\n");
