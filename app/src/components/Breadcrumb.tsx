// SPDX-License-Identifier: Apache-2.0
// Where you are in the folder tree (SPEC §13).

import { Link } from "react-router-dom";
import { breadcrumbFor } from "../workspace/tree";
import type { FolderMeta } from "../types";

export function Breadcrumb({
  folderId,
  folders,
}: {
  folderId: string | null;
  folders: FolderMeta[];
}) {
  const trail = breadcrumbFor(folderId, folders);
  return (
    <nav className="breadcrumb" aria-label="Folder path">
      <Link to="/">Everything</Link>
      {trail.map((folder, i) => (
        <span key={folder.folderId} style={{ display: "contents" }}>
          <span className="breadcrumb-sep" aria-hidden="true">
            /
          </span>
          {i === trail.length - 1 ? (
            <span aria-current="page">{folder.name}</span>
          ) : (
            <Link to={`/folder/${folder.folderId}`}>{folder.name}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}
