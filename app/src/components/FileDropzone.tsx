// SPDX-License-Identifier: Apache-2.0
// The drop target and file picker every upload dialog shows (SPEC §2, §11).

import { useRef, useState } from "react";
import { Icon } from "./Icon";
import { useToast } from "./Toast";
import { UPLOAD_HINT, isUploadable } from "../upload";

/**
 * One file, dropped or chosen. A file of a kind the server would refuse is
 * turned away here, where the person still has the dialog open, rather than
 * after its bytes have crossed the network.
 */
export function FileDropzone({ file, onFile }: { file: File | null; onFile: (file: File) => void }) {
  const toast = useToast();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (next: File | null) => {
    if (!next) return;
    if (!isUploadable(next)) {
      toast.error(`${UPLOAD_HINT}. That file is not one of those.`);
      return;
    }
    onFile(next);
  };

  return (
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
          <span className="caption">{file.size < 1024 ? `${file.size} bytes` : `${Math.round(file.size / 1024)} KB`}</span>
        </>
      ) : (
        <>
          <strong>Drop a file here</strong>
          <span className="caption">{UPLOAD_HINT}</span>
        </>
      )}
      <button type="button" className="btn btn-sm" onClick={() => inputRef.current?.click()}>
        {file ? "Choose another file" : "Choose a file"}
      </button>
      <input
        ref={inputRef}
        type="file"
        className="visually-hidden"
        accept=".html,.htm,.md,.markdown,.zip"
        onChange={(e) => accept(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}
