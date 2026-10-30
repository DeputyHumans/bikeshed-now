// SPDX-License-Identifier: Apache-2.0
// MCP schemas for the shared permission and folder management operations (SPEC §19).

import type { ToolDefinition } from "./tools";
import { getAccess, setAccess, setFolderVisibility, setVisibility, organizeFolder } from "../lib/management";
import { trashFolder } from "../lib/trash";
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
    description: "Owner-only: inspect this document's complete direct and inherited grants and effective membership. Document results include visibility, open editing, expiry and sharing URL, and `inheritedReach`: every folder above whose link or public level lets people beyond its members read it. No source bytes.",
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
    description: "Owner-only: inspect this folder's complete direct and inherited grants and effective membership, its own visibility, expiry and sharing URL, and `inheritedReach` from the folders above it.",
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
    name: "set_folder_visibility",
    description: "Owner-only: change a folder's visibility and/or expiry. A folder's link or public level opens EVERYTHING beneath it to read, without an account: its subfolders, documents filed there later, and documents other people own or that are private on their own. Tell the person that before you widen it. Expiry ends only the link or public level: members keep their access and nothing is frozen. Omitted fields stay unchanged; expiresAt null clears it; making it private and then unlisted again revokes every old link. Returns the sharing URL, including an unlisted key. Provide at least one setting.",
    inputSchema: { type: "object", required: ["id"], properties: {
      id, visibility: { type: "string", enum: ["private", "unlisted", "public"] },
      expiresAt: { type: ["number", "null"], description: "Future epoch milliseconds, or null to clear." },
    } },
    run: (ctx, args) => setFolderVisibility(ctx, value(args, "id"), args),
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
    description: "Owner-only: move a folder to the Trash with everything in it, other people's documents included. Nothing is deleted: it and its contents become their owners' alone and read-only until restored, and each owner can restore their own with restore_from_trash. Returns the batch and how many folders and documents went.",
    inputSchema: { type: "object", required: ["id"], properties: { id } },
    run: (ctx, args) => trashFolder(ctx, value(args, "id")),
  },
];
