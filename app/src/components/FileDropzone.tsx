// SPDX-License-Identifier: Apache-2.0
// The drop target and pickers every upload dialog shows: a page, a zip, a folder or several files (SPEC §2, §11).

import { useRef, useState } from "react";
import { Icon } from "./Icon";
import { captureDrop, combine, formatBytes, pickFromInput, type Pick } from "../bundleInput";

/** Whether this browser can choose a folder. Touch devices pick several files instead. */
function canChooseFolder(): boolean {
  if (typeof document === "undefined") return false;
  const coarse = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return !coarse && "webkitdirectory" in document.createElement("input");
}

/** "Q3 review — 24 files, 41.2 MB", or one file's name and size. */
export function pickSummary(pick: Pick): { name: string; detail: string } {
  const bytes = pick.files.reduce((n, f) => n + f.file.size, 0);
  if (!pick.fromFolder && pick.files.length === 1) return { name: pick.files[0].file.name, detail: formatBytes(bytes) };
  const count = `${pick.files.length.toLocaleString()} file${pick.files.length === 1 ? "" : "s"}`;
  return { name: pick.folder ?? count, detail: pick.folder ? `${count}, ${formatBytes(bytes)}` : formatBytes(bytes) };
}

/**
 * What a person brings, dropped or chosen, as one pick. Nothing is refused
 * here: the dialog shows what publishing it would do, problems included, so a
 * person sees why before anything has crossed the network.
 */
export function FileDropzone({ pick, onPick }: { pick: Pick | null; onPick: (pick: Pick) => void }) {
  const [dragging, setDragging] = useState(false);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [folders] = useState(canChooseFolder);
  const summary = pick ? pickSummary(pick) : null;

  const chosen = (list: FileList | null) => {
    if (list && list.length > 0) onPick(pickFromInput(list));
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
        void captureDrop(e.dataTransfer).then((picks) => {
          if (picks.length > 0) onPick(combine(picks));
        });
      }}
    >
      <Icon name="upload" size={28} />
      {summary ? (
        <>
          <strong className="upload-pick-name">{summary.name}</strong>
          <span className="caption">{summary.detail}</span>
        </>
      ) : (
        <>
          <strong>Drop a page, a .zip or a folder here</strong>
          <span className="caption">A page with its stylesheets, scripts, pictures and video, or several files at once.</span>
        </>
      )}
      <div className="upload-pickers">
        <button type="button" className="btn btn-sm" onClick={() => filesRef.current?.click()}>
          {pick ? "Choose other files" : "Choose files"}
        </button>
        {folders ? (
          <button type="button" className="btn btn-sm" onClick={() => folderRef.current?.click()}>
            {pick ? "Choose another folder" : "Choose a folder"}
          </button>
        ) : null}
      </div>
      <input
        ref={filesRef}
        type="file"
        multiple
        tabIndex={-1}
        aria-label="Choose files"
        className="visually-hidden"
        onChange={(e) => { chosen(e.target.files); e.target.value = ""; }}
      />
      {folders ? (
        <input
          ref={folderRef}
          type="file"
          tabIndex={-1}
          aria-label="Choose a folder"
          className="visually-hidden"
          {...{ webkitdirectory: "", directory: "" }}
          onChange={(e) => { chosen(e.target.files); e.target.value = ""; }}
        />
      ) : null}
    </div>
  );
}
