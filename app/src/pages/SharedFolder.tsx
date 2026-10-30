// SPDX-License-Identifier: Apache-2.0
// A folder opened by its link or its public level, for someone who is not its member (SPEC §17).

import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { UpdatedLine } from "../components/UpdatedLine";
import { ExpiryChip } from "../components/ExpiryChip";
import { NotHere } from "../components/NotHere";
import { CardSkeletons } from "../components/Spinner";
import { unlockFolder, type FolderUnlock } from "../visibility";
import { thumbUrl } from "../thumbs";

/**
 * Read-only, and it looks it: no menus, no upload, no drop zone, no tree.
 * Everything here came from one server answer about one level of the folder
 * (`POST /unlock` with a `folderId`), because the rules give a stranger nothing
 * under `folders/` or `docs/` to read. Every link out carries the key, so a
 * subfolder and a document open on the same proof that opened this page.
 *
 * Shown to the signed-out at `/folder/:id`, and to a signed-in account that is
 * not a member of the folder; a member sees their own workspace there instead.
 */
export function SharedFolder() {
  const { folderId = "" } = useParams();
  const [params] = useSearchParams();
  const k = params.get("k");
  const [answer, setAnswer] = useState<FolderUnlock | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setAnswer(undefined);
    setFailed(false);
    unlockFolder(folderId, k).then(
      (a) => live && setAnswer(a),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [folderId, k]);

  const withKey = (path: string) => (k ? `${path}?k=${encodeURIComponent(k)}` : path);

  const documents = useMemo(
    () =>
      answer && "open" in answer
        ? [...answer.open.documents].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        : [],
    [answer],
  );

  if (failed) {
    return (
      <div className="empty-state">
        <h1>That did not load</h1>
        <p>Something went wrong opening this folder. Try again in a moment.</p>
      </div>
    );
  }
  if (answer === undefined) {
    return (
      <div className="shared-folder">
        <CardSkeletons />
      </div>
    );
  }
  if (answer === null) return <NotHere />;
  if ("ended" in answer) {
    return (
      <div className="empty-state">
        <h1>This link has stopped working</h1>
        <p>
          “{answer.ended.name}” was shared with a link that has stopped working.
          Nothing has been deleted. Ask whoever shared it with you for a new link.
        </p>
      </div>
    );
  }

  const folder = answer.open;
  return (
    <div className="shared-folder">
      <nav className="breadcrumb" aria-label="Folder path">
        {folder.path.map((crumb, i) => (
          <Fragment key={crumb.folderId}>
            {i > 0 ? (
              <span className="breadcrumb-sep" aria-hidden="true">
                /
              </span>
            ) : null}
            {i === folder.path.length - 1 ? (
              <span aria-current="page">{crumb.name}</span>
            ) : (
              <Link to={withKey(`/folder/${crumb.folderId}`)}>{crumb.name}</Link>
            )}
          </Fragment>
        ))}
      </nav>

      <div className="shared-folder-head">
        <h1>
          <Icon name="folder" size={20} /> {folder.name}
        </h1>
        <span className="chip visibility-chip" data-visibility={folder.visibility}>
          <Icon name={folder.visibility === "public" ? "globe" : "eye"} size={12} />
          {folder.visibility === "public" ? "Public" : "Shared by link"}
        </span>
        <ExpiryChip expiresAt={folder.expiresAt} of="folder-link" />
      </div>
      <p className="caption shared-folder-note">
        You can read everything in this folder. Commenting and editing need the
        owner to share it with you by name.
      </p>

      {folder.folders.length === 0 && documents.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing here yet</h2>
          <p>This folder is empty.</p>
        </div>
      ) : null}

      {folder.folders.length > 0 ? (
        <div className="doc-grid">
          {[...folder.folders]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((child) => (
              <div className="doc-card" key={child.folderId}>
                <div className="doc-card-head">
                  <Link to={withKey(`/folder/${child.folderId}`)} className="doc-card-title">
                    <Icon name="folder" size={15} /> {child.name}
                  </Link>
                </div>
              </div>
            ))}
        </div>
      ) : null}

      {documents.length > 0 ? (
        <div className="doc-grid">
          {documents.map((doc) => {
            const href = withKey(`/d/${doc.docId}`);
            const cover = doc.cover ? thumbUrl(doc.docId, doc.cover.versionId, doc.cover.key, "cover", k) : null;
            return (
              <div className="doc-card" key={doc.docId}>
                <Link to={href} className="doc-card-thumb" tabIndex={-1} aria-hidden="true">
                  {cover ? (
                    <img src={cover} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <Icon name="doc" size={22} />
                  )}
                </Link>
                <div className="doc-card-head">
                  <Link to={href} className="doc-card-title">
                    {doc.title}
                  </Link>
                </div>
                {doc.updatedAt !== null || typeof doc.words === "number" ? (
                  <div className="doc-card-meta">
                    <UpdatedLine words={doc.words} at={doc.updatedAt} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {folder.truncated ? (
        <p className="caption shared-folder-note">
          This folder holds more than can be shown at once. Some items are not listed.
        </p>
      ) : null}
    </div>
  );
}
