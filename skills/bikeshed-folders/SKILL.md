---
name: bikeshed-folders
description: Use when organising a Bikeshed workspace — listing the folder tree, creating folders, and filing documents into them. Read this before moving a document, because a folder decides who can read what is inside it.
---

# Folders on Bikeshed

A folder is where a document lives **and** an access grant. Both halves matter,
and the second one is the one that surprises people.

The commands here come from `npm i -g bikeshed-now`, and each names the tool
that does the same job. Use whichever you have.

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

A `…` inside a path is a folder you cannot see. Access flows **downward**, so
being given a folder gives you everything beneath it — but being given a child
directly tells you nothing about its parent. The ellipsis is the honest answer:
there is a level here, and it is not yours.

`canWrite` is not the same as being able to see it. A folder shared with you to
read is one you cannot file into, and the call will refuse.

## Make a folder

```bash
bikeshed mkdir "Storage migration"
bikeshed mkdir "Reviews" --parent aB3xK9…
```

Over MCP: `create_folder`, with `parent` omitted for the workspace root.

A new folder inherits its parent's members. Creating one inside a shared folder
creates something the same people can read.

## Move a document — read this part

```bash
bikeshed mv storage-migration aB3xK9…   # into a folder
bikeshed mv storage-migration root      # back out to the workspace root
```

Over MCP: `move_document`. Omit `folder` to move it to the root; the CLI makes
you spell `root` instead, because a positional argument left off by accident
should not quietly unfile something.

**Moving a document changes who can read it.** A document's readers are its own
grants plus the folder's, so filing a document into a team's folder shares it
with that team, and moving it out again takes that access away. This is not a
filing decision with an access side effect — it *is* an access decision.

So:

- Moving a document **into** a folder shares it with everyone that folder is
  shared with. If you are not certain that is wanted, ask first.
- Moving a document **out** of a folder revokes the access it inherited. People
  who could read it yesterday may not be able to today.
- Placing a document at publish time (`publish --folder`, or `publish_document`
  with a `folder`) has exactly the same effect, and is cheaper than moving it
  afterwards.

You need edit rights on the document, not merely the ability to read it.

## What you cannot do, and why

- **Delete a folder.** It reparents everything beneath it, and nothing here is
  recoverable by an agent that got it wrong. Ask.
- **Share a folder, or a document.** Deciding who can see something is not a
  decision to automate.
- **Delete a document.** Documents are permanent by design. A single version can
  be withdrawn by whoever runs the deployment, through a guarded tool.
- **Rename a folder.** What something is called is the workspace's language, not
  a tidying job. A document you can edit is different: `rename_document` changes
  its title, and its address stays.

If a listing is `truncated`, the workspace has more folders than one call
returns. Say so rather than treating what you got as the whole tree.
