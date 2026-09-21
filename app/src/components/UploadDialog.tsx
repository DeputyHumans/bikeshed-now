// SPDX-License-Identifier: Apache-2.0
// Browser upload, with real progress and a marking default (SPEC §2, §11, §20).

import { useCallback, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { useToast } from "./Toast";
import { UPLOAD_HINT, isUploadable, uploadDoc, type UploadResult } from "../upload";
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
  const [marking, setMarking] = useState<Marking>(accountDefaultMarking ?? MARKING_OFF);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    (next: File | null) => {
      if (!next) return;
      if (!isUploadable(next)) {
        toast.error(`${UPLOAD_HINT}. That file is not one of those.`);
        return;
      }
      setFile(next);
    },
    [toast],
  );

  const upload = async () => {
    if (!file) return;
    setProgress(0);
    try {
      const result = await uploadDoc(file, {
        title: title.trim() || undefined,
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
            onClick={() => void upload()}
          >
            {progress != null ? "Uploading…" : "Upload"}
          </button>
        </>
      }
    >
      <div
        className="upload-dropzone"
        data-dragging={dragging}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files[0] ?? null);
        }}
      >
        <Icon name="upload" size={28} />
        {file ? (
          <>
            <strong>{file.name}</strong>
            <span className="caption">{Math.round(file.size / 1024)} KB</span>
          </>
        ) : (
          <>
            <strong>Drop a file here</strong>
            <span className="caption">{UPLOAD_HINT}</span>
          </>
        )}
        <button type="button" className="btn btn-sm" onClick={() => inputRef.current?.click()}>
          Choose a file
        </button>
        <input
          ref={inputRef}
          type="file"
          className="visually-hidden"
          accept=".html,.htm,.md,.markdown,.zip"
          onChange={(e) => accept(e.target.files?.[0] ?? null)}
        />
      </div>

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
