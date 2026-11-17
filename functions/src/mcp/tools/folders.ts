// SPDX-License-Identifier: Apache-2.0
// The folder tools: where a document is filed, and moving or renaming it (SPEC §13, §19).

import {
  canEdit,
  canEditFolder,
  canManageSharing,
  canReadFolder,
  isTrashed,
  type FolderAclData,
} from "../../lib/acl";
import { listReach } from "../../lib/reach";
import { filedIn, firstPeople, folderAudience } from "../../lib/audience";
import { eventActor } from "../../lib/events";
import { createFolderRecord, persistDocMembership, resolveFolderTarget } from "../../lib/folders";
import { renameDocument } from "../../lib/rename";
import { safeSegment } from "../../lib/http";
import {
  FOLDER_LIMIT,
  str,
  asArray,
  folderPath,
  whereAndWho,
  loadDoc,
  refuseIfFrozen,
  withReaderAddress,
} from "./shared";
import type { ToolDefinition } from "./shared";

export const FOLDER_TOOLS: ToolDefinition[] = [
  {
    name: "list_folders",
    description:
      "List every folder you can see, each with its full path and how many people can read it. " +
      "Filing a document in a folder shares it with all of them: get_folder says who they are. " +
      "Use an id as the `folder` argument to publish_document or move_document.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      const snap = await ctx.db
        .collection("folders")
        .where("members", "array-contains", ctx.caller.emailLower)
        .orderBy("createdAt", "desc")
        .limit(FOLDER_LIMIT + 1)
        .get();
      // A trashed folder is listed by list_trash, never as a place to put anything.
      const page = snap.docs.slice(0, FOLDER_LIMIT).filter((d) => !isTrashed(d.data()));
      const nameOf = new Map(page.map((d) => [d.id, String(d.data().name ?? d.id)]));

      const folders = page.map((d) => {
        const v = d.data();
        const name = String(v.name ?? d.id);
        return {
          id: d.id,
          name,
          parent: typeof v.parentId === "string" ? v.parentId : null,
          path: folderPath(asArray(v.ancestors), name, nameOf),
          // Read access and write access differ here: a folder shared with you
          // as a viewer is one you can see and cannot file into.
          canWrite: canEditFolder(
            v as FolderAclData,
            ctx.caller.uid,
            ctx.caller.emailLower,
          ),
          // A count, not the people: two hundred folders of names would flood
          // the context. get_folder names them for the one you are about to use.
          readers: new Set(asArray(v.members)).size,
          shared: new Set(asArray(v.members)).size > 1,
        };
      });
      // Sorted by path so the listing reads as a tree, and compared by code
      // unit rather than by locale so two callers get the same order.
      folders.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { folders, truncated: snap.docs.length > FOLDER_LIMIT };
    },
  },

  {
    name: "get_folder",
    description:
      "Who can read one folder, and so who can read anything filed in it: everyone by email (the first 25, then a count), " +
      "who can edit, the teams it is shared with, named only for teams you are in, and `throughFolders` when a link or a public level opens it to people beyond them. " +
      "Nobody is emailed when a document is filed, so tell the person who will be able to read it before you file it here. " +
      "With `k`, a folder shared with you by link instead lists one level of what it holds, to read: its subfolders and documents.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The folder id, from list_folders or a /folder/<id> link." },
        k: {
          type: "string",
          description: "Only for a folder you are not a member of: the key from its link, the value after ?k=. Omit it for a public folder.",
        },
      },
    },
    async run(ctx, args) {
      const id = str(args, "id");
      const snap = safeSegment(id) ? await ctx.db.collection("folders").doc(id).get() : null;
      // A folder the caller may not read answers as one that does not exist —
      // unless its link or public level opens it, which lists what it holds and
      // nothing about who else can read it (SPEC §17 "A folder's reach").
      if (!snap?.exists || !canReadFolder(snap.data() as FolderAclData, ctx.caller.uid, ctx.caller.emailLower)) {
        const listing = snap?.exists ? await listReach(ctx.db, id, str(args, "k") || null) : null;
        if (listing && "open" in listing) {
          const k = str(args, "k");
          return {
            ...listing.open,
            viaLink: true,
            readOnly: "Read the documents with get_document, passing the same k. A folder's link lets you read and nothing else.",
            documents: listing.open.documents.map((d) => withReaderAddress({ ...d }, d.docId, undefined, k || undefined)),
          };
        }
        if (listing && "ended" in listing) throw new Error(`the link to folder "${listing.ended.name}" has stopped working`);
        throw new Error(`no folder with id "${id}"`);
      }
      const v = snap.data() ?? {};
      const [paths, audience] = await Promise.all([
        filedIn(ctx.db, ctx.caller, [id]),
        folderAudience(ctx.db, ctx.caller, snap),
      ]);
      const editors = firstPeople(v.editorMembers);
      return {
        id,
        name: String(v.name ?? id),
        path: paths.get(id)?.path ?? String(v.name ?? id),
        owner: String(v.ownerEmail ?? ""),
        ...audience,
        editors: editors.people,
        moreEditors: editors.more,
        canWrite: canEditFolder(v as FolderAclData, ctx.caller.uid, ctx.caller.emailLower),
      };
    },
  },

  {
    name: "create_folder",
    description:
      "Create a folder, optionally inside one you can already write to. Returns its id.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Up to 120 characters." },
        parent: {
          type: "string",
          description: "Folder id to create it inside. Omit for the workspace root.",
        },
      },
    },
    async run(ctx, args) {
      const name = str(args, "name");
      if (!name || name.length > 120) {
        throw new Error("folder name is required (up to 120 characters)");
      }
      const parent = await resolveFolderTarget(ctx.db, args.parent, ctx.caller);
      if (!parent.ok) throw new Error(parent.error);
      return createFolderRecord(ctx.db, ctx.caller, name, parent);
    },
  },

  {
    name: "move_document",
    description:
      "Move a document you own into a folder. OMIT `folder` to move it out to the workspace root. " +
      "Moving it changes who can read it, so only its owner may, and the result says who can now (`access`).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The document id." },
        folder: {
          type: "string",
          description:
            "Destination folder id, from list_folders. OMIT this argument to move the document to the workspace root.",
        },
      },
    },
    async run(ctx, args) {
      const { ref, data } = await loadDoc(ctx, str(args, "id"));
      // Moving a document changes who can read it: the destination folder's
      // members become its members, and its link and public level reach it.
      // So it is the owner's, as sharing is: an editor who could file the
      // owner's document into their own folder could then share or publish
      // that folder (SPEC §13, §19).
      if (!canManageSharing(data, ctx.caller.emailLower)) {
        throw new Error("only its owner can move that document: moving it changes who can read it");
      }
      refuseIfFrozen(data);

      const target = await resolveFolderTarget(ctx.db, args.folder, ctx.caller);
      if (!target.ok) throw new Error(target.error);

      // persistDocMembership, not a bare field write: a document's effective
      // membership is its own grants unioned with its folder's, so moving it
      // between folders changes who can read it. The presence mirror and the
      // public projection are recomputed in the same call, which is the whole
      // reason that helper exists.
      const fromFolder = typeof data.folderId === "string" ? data.folderId : null;
      await persistDocMembership(
        ctx.db,
        ref,
        () => ({ folderId: target.id }),
        () =>
          fromFolder === target.id
            ? []
            : [{ type: "doc.moved", audience: "editors", actor: eventActor(ctx.actor), data: { from: fromFolder, to: target.id } }],
      );
      // `folder` stays the id, as before: an installed CLI prints it.
      return withReaderAddress(
        { id: ref.id, folder: target.id, ...(await whereAndWho(ctx, ref.id)) },
        ref.id,
      );
    },
  },

  {
    name: "rename_document",
    description:
      "Change a document's title: the name the workspace lists it under. Its address, /d/<id>, never changes, " +
      "so links already sent keep working. An HTML document's own <title> is part of its content and stays " +
      "as written; link previews still show that one.",
    inputSchema: {
      type: "object",
      required: ["id", "title"],
      properties: {
        id: { type: "string", description: "The document id." },
        title: { type: "string", description: "The new title, up to 200 characters." },
      },
    },
    async run(ctx, args) {
      // Whoever may edit may rename, as in the workspace list, which takes no
      // link key either (POST /organize).
      const { ref, data, proof } = await loadDoc(ctx, str(args, "id"));
      if (!canEdit(data, ctx.caller, proof)) throw new Error("you cannot rename that document");
      refuseIfFrozen(data);
      const renamed = await renameDocument(ctx.db, ref, args.title, ctx.actor);
      if ("error" in renamed) throw new Error(renamed.error);
      return withReaderAddress({ id: ref.id, title: renamed.title }, ref.id);
    },
  },
];
