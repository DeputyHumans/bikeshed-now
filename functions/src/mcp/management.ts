// SPDX-License-Identifier: Apache-2.0
// MCP schemas for the shared permission and folder management operations (SPEC §19).

import type { ToolDefinition } from "./tools";
import { getAccess, setAccess, setVisibility, organizeFolder } from "../lib/management";
import { ROLES } from "../lib/access";

const id = { type: "string", description: "The document or folder id." };
const delta = {
  add: { type: "array", items: { type: "object", required: ["principal", "role"], properties: {
    principal: { type: "string", description: "An email address or team:<id>." }, role: { type: "string", enum: [...ROLES] },
  } } },
  remove: { type: "array", items: { type: "string" }, description: "Direct principals to remove; inherited grants remain until changed at their source." },
};
const value = (args: Record<string, unknown>, key: string) => typeof args[key] === "string" ? (args[key] as string).trim() : "";

export const MANAGEMENT_TOOLS: ToolDefinition[] = [
  {
    name: "get_document_access",
    description: "Owner-only: inspect this document's complete direct and inherited grants and effective membership. Document results include visibility, open editing, expiry and sharing URL; no source bytes.",
    inputSchema: { type: "object", required: ["id"], properties: { id } },
    run: (ctx, args) => getAccess(ctx, "document", value(args, "id")),
  },
  {
    name: "set_document_access",
    description: "Owner-only: grant, revoke or change direct roles on this document. Newly effective readers receive invitations when email is enabled; repeated grants do not resend. Inherited grants must be changed at their source. Returns resulting access.",
    inputSchema: { type: "object", required: ["id"], properties: { id, ...delta } },
    run: (ctx, args) => setAccess(ctx, "document", value(args, "id"), args),
  },
  {
    name: "get_folder_access",
    description: "Owner-only: inspect this folder's complete direct and inherited grants and effective membership.",
    inputSchema: { type: "object", required: ["id"], properties: { id } },
    run: (ctx, args) => getAccess(ctx, "folder", value(args, "id")),
  },
  {
    name: "set_folder_access",
    description: "Owner-only: grant, revoke or change direct roles on this folder. Newly effective readers receive invitations when email is enabled; repeated grants do not resend. Inherited grants must be changed at their source. Returns resulting access.",
    inputSchema: { type: "object", required: ["id"], properties: { id, ...delta } },
    run: (ctx, args) => setAccess(ctx, "folder", value(args, "id"), args),
  },
  {
    name: "set_document_visibility",
    description: "Owner-only: change visibility, open editing and/or expiry, including on an expired document. Omitted fields stay unchanged; expiresAt null clears expiry. Private disables open editing. Returns the usable sharing URL, including an unlisted key. Provide at least one setting.",
    inputSchema: { type: "object", required: ["id"], properties: {
      id, visibility: { type: "string", enum: ["private", "unlisted", "public"] },
      publicEdit: { type: "boolean" }, expiresAt: { type: ["number", "null"], description: "Future epoch milliseconds, or null to clear." },
    } },
    run: (ctx, args) => setVisibility(ctx, value(args, "id"), args),
  },
  {
    name: "rename_folder",
    description: "Rename a folder you can edit. Its id and contents stay the same.",
    inputSchema: { type: "object", required: ["id", "name"], properties: { id, name: { type: "string", description: "The new name, up to 120 characters." } } },
    run: (ctx, args) => organizeFolder(ctx, value(args, "id"), "rename", args),
  },
  {
    name: "move_folder",
    description: "Move a folder you can edit into a parent you can edit. OMIT parent for the root. Recomputes inherited access throughout the subtree; sends no invitations. A folder cannot move into itself or a descendant.",
    inputSchema: { type: "object", required: ["id"], properties: { id, parent: { type: "string", description: "Destination folder id. OMIT to move to the root." } } },
    run: (ctx, args) => organizeFolder(ctx, value(args, "id"), "move", args),
  },
  {
    name: "delete_folder",
    description: "Owner-only: delete a folder, reparenting its immediate contents to its parent (or the root). Documents are retained. Recomputes inherited access; sends no invitations. Returns the destination and counts of reparented folders and documents.",
    inputSchema: { type: "object", required: ["id"], properties: { id } },
    run: (ctx, args) => organizeFolder(ctx, value(args, "id"), "delete"),
  },
];
