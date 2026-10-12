// SPDX-License-Identifier: Apache-2.0
// Browser upload, with real progress and a marking default (SPEC §2, §11, §20).

import { useState } from "react";
import { Modal } from "./Modal";
import { FileDropzone } from "./FileDropzone";
import { useToast } from "./Toast";
import { uploadDoc, type UploadResult } from "../upload";
import { logEvent } from "../analytics";
import { MARKING_OFF } from "../export/labels";
import type { Marking } from "../types";

export function UploadDialog({
  folderId,
  accountDefaultMarking,
  onClose,
  onUploaded,
}: {
  folderId: string | null;
  /** Seeds the document's marking. The document's own value is authoritative. */
  accountDefaultMarking: Marking;
  onClose: () => void;
  onUploaded: (result: UploadResult) => void;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [marking, setMarking] = useState<Marking>(accountDefaultMarking ?? MARKING_OFF);
  const [progress, setProgress] = useState<number | null>(null);

  const upload = async () => {
    if (!file) return;
    setProgress(0);
    try {
      const result = await uploadDoc(file, {
        title: title.trim() || undefined,
        id: id.trim() || undefined,
        folderId,
        marking,
        onProgress: setProgress,
      });
      logEvent({
        name: "doc_publish",
        params: { source: "upload", format: result.format },
      });
      onUploaded(result);
    } catch (e) {
      toast.error((e as Error).message);
      setProgress(null);
    }
  };

  return (
    <Modal
      title="Upload a document"
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
            disabled={!file || progress != null}
            aria-busy={progress != null}
            onClick={() => void upload()}
          >
            {progress != null ? "Uploading…" : "Upload"}
          </button>
        </>
      }
    >
      <FileDropzone file={file} onFile={setFile} />

      {progress != null ? (
        <div className="upload-progress" style={{ marginTop: "var(--s-3)" }}>
          <div className="upload-progress-bar" style={{ width: `${progress * 100}%` }} />
        </div>
      ) : null}

      <div className="field" style={{ marginTop: "var(--s-3)" }}>
        <label className="field-label" htmlFor="upload-title">
          Title
        </label>
        <input
          id="upload-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="From the document's <title>, else the file name"
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="upload-id">
          Address
        </label>
        <input
          id="upload-id"
          className="input"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="From the title"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="upload-id-hint"
        />
        <span id="upload-id-hint" className="field-hint">
          The part of the link after /d/. Lowercase letters, digits and hyphens.
          If it's already taken, a few random characters are added to the end.
        </span>
      </div>

      <div className="checkbox-row">
        <input
          id="upload-marking"
          type="checkbox"
          checked={marking.enabled}
          onChange={(e) => setMarking({ ...marking, enabled: e.target.checked })}
        />
        <label htmlFor="upload-marking">
          Stamp exports of this document
          <span className="field-hint" style={{ display: "block" }}>
            Seeded from your account default. You can change it later.
          </span>
        </label>
      </div>

      <p className="field-hint">
        {/* Stated at upload, because this is where the expectation is set: an
            uploaded document is sandboxed until somebody vouches for it. */}
        Uploaded documents run without scripts until you or their owner says
        otherwise. Nothing else about them is restricted.
      </p>
    </Modal>
  );
}
