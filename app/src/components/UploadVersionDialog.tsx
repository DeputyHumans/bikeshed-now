// SPDX-License-Identifier: Apache-2.0
// A file from disk as a document's next version, for people who iterate outside the app (SPEC §2, §6a).

import { useState } from "react";
import { Modal } from "./Modal";
import { FileDropzone } from "./FileDropzone";
import { useToast } from "./Toast";
import { uploadVersion, type VersionUploadResult } from "../upload";

/** What to tell the person once the server has answered. */
export function versionUploadMessage(result: VersionUploadResult): string {
  return result.deduped
    ? `No changes — the file is identical to ${result.versionId}.`
    : `Published ${result.versionId}.`;
}

/**
 * Says what an upload will do before it does it, because each consequence is
 * one the in-app "Save as new version" either does not have or asks about
 * first: the comments stay behind, the scripts are blocked again, and an
 * unpublished draft is thrown away (SPEC §6a, §6c).
 *
 * The version it goes on top of is fixed when the dialog opens and sent as the
 * base. If somebody publishes while it is open, the dialog says so and will not
 * send; if they publish while the file is on its way, the server refuses it.
 * Either way the file never lands silently on a version nobody here has seen.
 */
export function UploadVersionDialog({
  docId,
  title,
  headVersion,
  trusted,
  draftBy,
  editing = [],
  initialFile = null,
  onClose,
  onPublished,
}: {
  docId: string;
  title: string;
  /** The version current right now, live: it may move while the dialog is open. */
  headVersion: string;
  /** Whether its scripts run now, for whoever is looking. */
  trusted: boolean;
  /** Who last saved the unpublished draft, when there is one. */
  draftBy?: string | null;
  /** Who has it open in the editor, when the caller can see that. */
  editing?: string[];
  /** A file dropped onto the document, to start from. */
  initialFile?: File | null;
  onClose: () => void;
  onPublished: (result: VersionUploadResult) => void;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(initialFile);
  const [progress, setProgress] = useState<number | null>(null);
  // Fixed at open: what the person is told they are replacing.
  const [base] = useState(headVersion);
  const moved = Boolean(headVersion && base && headVersion !== base);
  const blocked = moved || editing.length > 0;

  const upload = async () => {
    if (!file || blocked) return;
    setProgress(0);
    try {
      onPublished(await uploadVersion(file, { docId, baseVersion: base, onProgress: setProgress }));
    } catch (e) {
      toast.error((e as Error).message);
      setProgress(null);
    }
  };

  return (
    <Modal
      title="Upload a new version"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!file || blocked || progress != null}
            aria-busy={progress != null}
            onClick={() => void upload()}
          >
            {progress != null ? "Publishing…" : "Publish"}
          </button>
        </>
      }
    >
      <p>
        The file becomes the next version of <strong>{title}</strong>, after {base || "the current one"}, at the
        same address.
      </p>

      <FileDropzone file={file} onFile={setFile} />

      {progress != null ? (
        <div className="upload-progress" style={{ marginTop: "var(--s-3)" }}>
          <div className="upload-progress-bar" style={{ width: `${progress * 100}%` }} />
        </div>
      ) : null}

      {moved ? (
        <p className="banner banner-warn" role="status" style={{ marginTop: "var(--s-3)" }}>
          {headVersion} was published while this was open. Close this and look at it before you upload over it.
        </p>
      ) : editing.length > 0 ? (
        <p className="banner banner-warn" role="status" style={{ marginTop: "var(--s-3)" }}>
          {editing.join(", ")} {editing.length === 1 ? "has" : "have"} it open in the editor. Publishing now would
          throw away what they are typing, so wait until they have left it.
        </p>
      ) : null}

      <ul className="upload-notes">
        <li>Comments stay on {base || "the current version"}. The new version starts with none.</li>
        {draftBy ? <li>The unpublished edits {draftBy} last saved are discarded.</li> : null}
        {trusted ? <li>Its scripts are blocked again until somebody trusts the new version.</li> : null}
      </ul>
    </Modal>
  );
}
