// SPDX-License-Identifier: Apache-2.0
// Folder-tree construction, which lived inline in three components (SPEC §13).

import { describe, expect, it } from "vitest";
import {
  breadcrumbFor,
  buildTree,
  docsInFolder,
  filterDocs,
  flattenTree,
  pathToFolder,
  sortDocs,
  validMoveTargets,
} from "./tree";
import type { DocMeta, FolderMeta } from "../types";

function folder(
  folderId: string,
  parentId: string | null,
  ancestors: string[],
  name = folderId,
): FolderMeta {
  return {
    folderId,
    name,
    slug: folderId,
    parentId,
    ownerUid: null,
    ownerEmail: "owner@example.com",
    viewers: [],
    editors: [],
    members: ["owner@example.com"],
    editorMembers: ["owner@example.com"],
    ancestors,
    depth: ancestors.length,
    createdAt: null as never,
    updatedAt: null as never,
  };
}

function millis(ms: number) {
  return { toMillis: () => ms } as never;
}

function document_(
  docId: string,
  folderId: string | null,
  extra: Partial<DocMeta> = {},
): DocMeta {
  return {
    docId,
    title: docId,
    slug: docId,
    ownerUid: null,
    ownerEmail: "owner@example.com",
    currentVersion: "v1",
    viewers: [],
    editors: [],
    members: ["owner@example.com"],
    folderId,
    createdAt: millis(0),
    updatedAt: millis(0),
    ...extra,
  } as DocMeta;
}

const FOLDERS = [
  folder("root-a", null, [], "Alpha"),
  folder("child", "root-a", ["root-a"], "Child"),
  folder("grandchild", "child", ["root-a", "child"], "Grandchild"),
  folder("root-b", null, [], "Beta"),
];

describe("buildTree", () => {
  it("nests by parent and sorts siblings by name", () => {
    const tree = buildTree(FOLDERS);
    expect(tree.map((n) => n.folder.name)).toEqual(["Alpha", "Beta"]);
    expect(tree[0].children[0].folder.name).toBe("Child");
    expect(tree[0].children[0].children[0].folder.name).toBe("Grandchild");
  });

  it("records depth, so the rail can indent without a rule per level", () => {
    const tree = buildTree(FOLDERS);
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("treats a folder whose parent is not visible as a ROOT", () => {
    /**
     * Real and not exceptional: you can be granted a nested folder without
     * being granted its parent. Dropping it would make a folder somebody
     * deliberately shared simply disappear.
     */
    const tree = buildTree([folder("orphan", "unknown-parent", ["unknown-parent"])]);
    expect(tree).toHaveLength(1);
    expect(tree[0].folder.folderId).toBe("orphan");
  });

  it("does not hang on a corrupt parent cycle", () => {
    // The move endpoint's cycle guard should make this impossible. This is what
    // happens if it ever does not.
    const cyclic = [folder("a", "b", ["b"]), folder("b", "a", ["a"])];
    expect(() => buildTree(cyclic)).not.toThrow();
  });

  it("handles an empty list", () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe("flattenTree", () => {
  it("shows only the children of expanded folders", () => {
    const tree = buildTree(FOLDERS);
    expect(flattenTree(tree, new Set()).map((n) => n.folder.folderId)).toEqual([
      "root-a",
      "root-b",
    ]);
    expect(
      flattenTree(tree, new Set(["root-a"])).map((n) => n.folder.folderId),
    ).toEqual(["root-a", "child", "root-b"]);
  });
});

describe("pathToFolder", () => {
  it("returns every ancestor plus the folder itself", () => {
    // Uses the STORED ancestors array, which the server maintains alongside
    // membership — so it is correct even when an intermediate folder is not in
    // this user's own list.
    expect(pathToFolder("grandchild", FOLDERS)).toEqual([
      "root-a",
      "child",
      "grandchild",
    ]);
  });

  it("is empty at the root and for an unknown folder", () => {
    expect(pathToFolder(null, FOLDERS)).toEqual([]);
    expect(pathToFolder("nope", FOLDERS)).toEqual([]);
  });
});

describe("breadcrumbFor", () => {
  it("is root-first and ends at the folder", () => {
    expect(breadcrumbFor("grandchild", FOLDERS).map((f) => f.name)).toEqual([
      "Alpha",
      "Child",
      "Grandchild",
    ]);
  });

  it("skips an ancestor this user cannot see, rather than breaking", () => {
    const partial = [folder("grandchild", "child", ["root-a", "child"])];
    expect(breadcrumbFor("grandchild", partial).map((f) => f.folderId)).toEqual([
      "grandchild",
    ]);
  });
});

describe("validMoveTargets", () => {
  it("excludes the folder itself and everything beneath it", () => {
    const targets = validMoveTargets("root-a", FOLDERS).map((f) => f.folderId);
    expect(targets).toEqual(["root-b"]);
  });

  it("allows moving a leaf anywhere else", () => {
    const targets = validMoveTargets("grandchild", FOLDERS).map((f) => f.folderId);
    expect(targets).toEqual(["root-a", "child", "root-b"]);
  });
});

describe("documents", () => {
  const DOCS = [
    document_("a", null, { title: "Zulu", updatedAt: millis(300), stats: { views: 1 } as never }),
    document_("b", "root-a", { title: "alpha", updatedAt: millis(100), stats: { views: 9 } as never }),
    document_("c", null, { title: "Mike", updatedAt: millis(200) }),
  ];

  it("scopes to a folder, with null meaning the root", () => {
    expect(docsInFolder(DOCS, null).map((d) => d.docId)).toEqual(["a", "c"]);
    expect(docsInFolder(DOCS, "root-a").map((d) => d.docId)).toEqual(["b"]);
  });

  it("sorts by name case-insensitively", () => {
    expect(sortDocs(DOCS, "name").map((d) => d.title)).toEqual(["alpha", "Mike", "Zulu"]);
  });

  it("sorts by recency and by reads", () => {
    expect(sortDocs(DOCS, "recent").map((d) => d.docId)).toEqual(["a", "c", "b"]);
    expect(sortDocs(DOCS, "views").map((d) => d.docId)).toEqual(["b", "a", "c"]);
  });

  it("sorts recency by the current version's publish, not by a rename or a share", () => {
    // b was renamed last (updatedAt 900), but a's content changed last.
    const docs = [
      document_("a", null, { currentVersion: "v2", updatedAt: millis(100), latest: { version: "v2", at: millis(500) } as never }),
      document_("b", null, { currentVersion: "v1", updatedAt: millis(900), latest: { version: "v1", at: millis(200) } as never }),
      document_("c", null, { updatedAt: millis(300) }),
    ];
    expect(sortDocs(docs, "recent").map((d) => d.docId)).toEqual(["a", "c", "b"]);
  });

  it("reads a summary of an older version as no summary: just published, the record's time is the newer", () => {
    // d's v3 is published but not yet summarized; its summary still names v2.
    const docs = [
      document_("d", null, { currentVersion: "v3", updatedAt: millis(800), latest: { version: "v2", at: millis(100) } as never }),
      document_("e", null, { currentVersion: "v1", updatedAt: millis(900), latest: { version: "v1", at: millis(400) } as never }),
    ];
    expect(sortDocs(docs, "recent").map((d) => d.docId)).toEqual(["d", "e"]);
  });

  it("does not mutate the input", () => {
    const order = DOCS.map((d) => d.docId);
    sortDocs(DOCS, "name");
    expect(DOCS.map((d) => d.docId)).toEqual(order);
  });

  it("filters over title, slug and owner", () => {
    expect(filterDocs(DOCS, "ZUL").map((d) => d.docId)).toEqual(["a"]);
    expect(filterDocs(DOCS, "owner@").map((d) => d.docId)).toHaveLength(3);
    expect(filterDocs(DOCS, "  ").map((d) => d.docId)).toHaveLength(3);
    expect(filterDocs(DOCS, "nothing")).toEqual([]);
  });
});
