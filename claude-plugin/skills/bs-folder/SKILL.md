---
name: bs-folder
description: Use when deciding where a new Bikeshed document goes, and when organising a workspace — listing the folder tree, creating folders, and filing documents into them. Read this before publishing into a folder or moving a document, because a folder decides who can read what is inside it.
---

# Folders on Bikeshed

A folder is where a document lives **and** an access grant. Both halves matter, and the second one is the one that surprises people.

The commands here come from `npm i -g bikeshed-now`, and each names the tool that does the same job. Use whichever you have.

## Read the tree first

```bash
bikeshed folders
```

```
Design                                   aB3xK9…
  Reviews                                cD4yL2…
  Archive                                eF5zM7…  (read-only)
Engineering                              gH6aN1…
```

Over MCP: `list_folders`. Every row carries:

| | |
|---|---|
| `id` | what you pass to every other call |
| `path` | the full path, so placing a document is one call, not a walk |
| `canWrite` | whether you may put anything in it |
| `parent` | the parent's id, or null at the root |
| `readers` | how many people can read it, and so anything filed in it |
| `shared` | whether anyone but you can |

A `…` inside a path is a folder you cannot see. Access flows **downward**, so being given a folder gives you everything beneath it — but being given a child directly tells you nothing about its parent. The ellipsis is the honest answer: there is a level here, and it is not yours.

`canWrite` is not the same as being able to see it. A folder shared with you to read is one you cannot file into, and the call will refuse.

## Who can read a folder

`get_folder` names them: everyone by email (the first 25, then a count), who can edit, and the teams it is shared with. A team you are not in shows as "a team you are not in", as it does in the app, and is never sized. When a link or a public level opens the folder further, `throughFolders` says which folder does it, and `alsoReadableBy` says to whom: anything filed there is readable by them too, without an account.

Given a folder's link, `/folder/<id>?k=<key>`, pass `k` to `get_folder` to list what it holds, and pass the same `k` to `get_document` for each document. That is reading only: you cannot comment, suggest or edit through a folder's link.

## Choosing a folder for a new document

Nobody is emailed when a document lands in a folder, so the person hears who can now read it from you, or not at all. File a new document at the root, or in a folder only they can read, or in one they named for it; anywhere else, ask first, naming who will be able to read it. The `bs-publish` skill, "Where it is filed", has the whole rule.

A folder does not need to be yours to fit, and being yours does not make it private: one you made inside a shared folder is shared too.

## Make a folder

```bash
bikeshed mkdir "Storage migration"
bikeshed mkdir "Reviews" --parent aB3xK9…
```

Over MCP: `create_folder`, with `parent` omitted for the workspace root.

A new folder inherits its parent's members. Creating one inside a shared folder creates something the same people can read.

## Move a document — read this part

```bash
bikeshed mv storage-migration aB3xK9…   # into a folder
bikeshed mv storage-migration root      # back out to the workspace root
```

Over MCP: `move_document`. Omit `folder` to move it to the root; the CLI makes you spell `root` instead, because a positional argument left off by accident should not quietly unfile something.

**Moving a document changes who can read it.** A document's readers are its own grants plus the folder's, so filing a document into a team's folder shares it with that team, and moving it out again takes that access away. This is not a filing decision with an access side effect — it *is* an access decision.

So:

- Moving a document **into** a folder shares it with everyone that folder is shared with. If you are not certain that is wanted, ask first. The result's `access` says who can read it now; tell the person.
- Moving a document **out** of a folder revokes the access it inherited. People who could read it yesterday may not be able to today.
- Placing a document at publish time (`publish --folder`, or `publish_document` with a `folder`) has exactly the same effect, and is cheaper than moving it afterwards.

You need edit rights on the document, not merely the ability to read it.

## Rename or move a folder

```bash
bikeshed rename-folder folder-id "Reviews"
bikeshed move-folder folder-id parent-id
bikeshed move-folder folder-id root
```

Over MCP: `rename_folder` takes `id` and `name`; `move_folder` takes `id` and an optional `parent` (omit for root). Renaming requires edit rights. Moving a folder, or a document, requires being its owner, because moving changes who can read it, and edit rights on the destination. Cycles are refused. Moves recompute inherited access throughout the subtree and send no invitations.

## The Trash

```bash
bikeshed trash doc-id
bikeshed trash folder folder-id
bikeshed restore doc-id
bikeshed restore folder folder-id
bikeshed trash
```

Over MCP: `trash_document` takes `id`; `delete_folder` takes `id` and trashes the folder with everything in it; `restore_from_trash` takes `id` and `kind` (`document` or `folder`); `list_trash` takes nothing.

Deleting moves to the owner's Trash, and only the owner can do it. A folder takes everything beneath it, other people's documents included. Nothing is deleted yet: in the Trash an item is its owner's alone and read-only, its links and grants stop working, and it cannot be shared, renamed or moved, nor can anything be filed into a trashed folder. Restore brings it back with every grant, into the folder it was in while that folder is still there, otherwise to the root; a folder brings back what went with it. Someone else's document that went with your folder is in their Trash, not yours: say so, and they can restore it. Whatever is not restored is deleted forever 30 days after it went; `list_trash` gives each item's `deletesAt`.

Trash only what the person asked you to, and report what went: the counts a folder returns, whose documents were in it if you know, and that it is deleted forever in 30 days unless restored. Use these operations when authorized; do not ask again for authorization already given. No tool deletes anything forever: a person who wants something gone sooner does it in the browser's Trash, with a code emailed to them.

For sharing and role changes use `get_folder_access`, `set_folder_access`, `set_folder_visibility`, `get_document_access` and `set_document_access`, described in the `bs-share` skill.

If a listing is `truncated`, the workspace has more folders than one call returns. Say so rather than treating what you got as the whole tree.

Version history is document-wide for access and filing: current permissions and expiry govern every version. Older content and feedback are a read-only archive. For version discovery and guarded writes use the publishing or feedback skill; changing access or moving a document does not make an older version editable.
