// SPDX-License-Identifier: Apache-2.0
// The thirty-six MCP tools, gathered in the order tools/list gives them (SPEC §19).

/**
 * Chosen to close a loop, not to expose a surface.
 *
 * `get_comments` is what earns this whole feature. Because every annotation
 * stores the passage it is anchored to — exact, prefix and suffix — a comment
 * comes back WITH the text it is about, so an agent knows what to change without
 * fetching the document and diffing it. Publish a draft, humans highlight the
 * sentences they object to, the agent reads anchored feedback and revises. That
 * is the product, and it is the reason to have an agent surface at all.
 *
 * Efficiency is a correctness concern here, because agent context is the scarce
 * resource:
 *   - `list_documents` returns metadata only.
 *   - `get_document` returns an HTML document as a Markdown READING made for
 *     agents, which says that it is one and where the original is, and a
 *     Markdown document as its source — never the stylesheets, scripts and
 *     base64 an agent cannot use. The HTML source is one argument away, for
 *     revising (ADR 0030).
 *   - `get_comments` returns each thread's quote, section and comments, and
 *     whether a person is waiting on an answer, nothing else.
 *   - Everything is capped, and says when it was.
 *
 * The three folder tools are the workspace half of the same argument. An agent
 * that can publish but cannot see where things go either drops everything at
 * the root or asks a person to file it — and the person is not there, which is
 * why an agent is doing this. `list_folders` returns whole paths rather than a
 * tree to walk, so placing a document is one call and not a traversal.
 *
 * Filing is also sharing, and nobody is emailed when it happens, so the agent
 * that filed a document is the only one who can tell the person who can now
 * read it. `get_folder`, and the `access` a write returns, are how it knows.
 *
 * Management tools share the HTTP implementation and enforce the same owner
 * and editor checks. Folder deletion reparents contents; documents remain.
 */

import { MANAGEMENT_TOOLS } from "./management";
import { isDocEditor } from "../lib/acl";
import { DOCUMENT_TOOLS } from "./tools/documents";
import { SUGGESTION_TOOLS } from "./tools/suggestions";
import { FOLDER_TOOLS } from "./tools/folders";
import { FEEDBACK_TOOLS } from "./tools/feedback";
import type { ToolDefinition } from "./tools/shared";

export { pageEnd, folderPath, withReaderAddress, lineageForAgent } from "./tools/shared";
export type { ToolContext, ToolDefinition } from "./tools/shared";

export const TOOLS: ToolDefinition[] = [
  ...MANAGEMENT_TOOLS,
  ...DOCUMENT_TOOLS,
  ...SUGGESTION_TOOLS,
  ...FOLDER_TOOLS,
  ...FEEDBACK_TOOLS,
];

/** Tools an editor-only caller may still call, for the error message. */
export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Exported for the wiring test: the surface is thirty-six tools, not "some tools". */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

void isDocEditor;
