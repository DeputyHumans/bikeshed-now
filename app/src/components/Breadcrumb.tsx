// SPDX-License-Identifier: Apache-2.0
// Where you are in the folder tree (SPEC §13).

import { Fragment } from "react";
import { Link } from "react-router-dom";
import { breadcrumbFor } from "../workspace/tree";
import type { FolderMeta } from "../types";

/**
 * One trail, two places.
 *
 * In the workspace the last FOLDER is where you are, so it is not a link. In
 * the viewer the DOCUMENT is where you are, so every folder above it is — which
 * is the whole point of putting the trail there: a reader who followed a link
 * into a document had no route to the folder holding it, or to the workspace,
 * short of the browser's back button.
 *
 * `current` is what makes that one component rather than two. The alternative
 * was a second trail renderer in the viewer, which is how two breadcrumbs end
 * up disagreeing about what a separator looks like.
 */
export function Breadcrumb({
  folderId,
  folders,
  current,
  rootTo = "/everything",
}: {
  folderId: string | null;
  folders: FolderMeta[];
  /** The leaf, when it is not a folder. Every folder then becomes a link. */
  current?: string;
  /**
   * Where "Everything" goes. Signed out there is no workspace to go to, and
   * a reader of a public document is sent to the landing page, not to sign up.
   */
  rootTo?: string;
}) {
  const trail = breadcrumbFor(folderId, folders);
  return (
    <nav className="breadcrumb" aria-label={current ? "Document path" : "Folder path"}>
      <Link to={rootTo}>Everything</Link>
      {trail.map((folder, i) => (
        <Fragment key={folder.folderId}>
          {/* Marked so a narrow viewport can drop this crumb AND its separator
              as one thing. The separator before `current` is not marked, and is
              what keeps "Everything / this document" reading correctly. */}
          <span className="breadcrumb-sep" data-folder="" aria-hidden="true">
            /
          </span>
          {!current && i === trail.length - 1 ? (
            <span aria-current="page">{folder.name}</span>
          ) : (
            <Link to={`/folder/${folder.folderId}`}>{folder.name}</Link>
          )}
        </Fragment>
      ))}
      {current ? (
        <>
          <span className="breadcrumb-sep" aria-hidden="true">
            /
          </span>
          <span className="breadcrumb-current" aria-current="page" title={current}>
            {current}
          </span>
        </>
      ) : null}
    </nav>
  );
}
