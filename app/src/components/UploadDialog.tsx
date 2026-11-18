// SPDX-License-Identifier: Apache-2.0
// Browser upload of a page, a zip or a folder, with real progress and a marking default (SPEC §2, §11, §20).

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { FileDropzone } from "./FileDropzone";
import { PlanSummary } from "./PlanSummary";
import { UploadProgress } from "./UploadProgress";
import { useToast } from "./Toast";
import { useUploadRun } from "../hooks/useUploadRun";
import { publishNew, type UploadResult } from "../upload";
import { planNew, type Pick } from "../bundleInput";
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
  const [pick, setPick] = useState<Pick | null>(null);
  const plan = useMemo(() => (pick ? planNew(pick) : null), [pick]);
  const upload = useUploadRun();
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [marking, setMarking] = useState<Marking>(accountDefaultMarking ?? MARKING_OFF);
  const markingChosen = useRef(false);
  useEffect(() => {
    if (!markingChosen.current) setMarking(accountDefaultMarking ?? MARKING_OFF);
  }, [accountDefaultMarking]);
  const ready = Boolean(plan && plan.problems.length === 0);

  const send = async () => {
    if (!plan || !ready) return;
    try {
      const result = await upload.run((control) => publishNew(plan, {
        title: title.trim() || undefined,
        id: id.trim() || undefined,
        folderId,
        marking,
        ...control,
      }));
      if (!result) return;
      logEvent({
        name: "doc_publish",
        params: { source: "upload", format: result.format },
      });
      onUploaded(result);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Closing while the bytes are on their way stops them, and nothing is made.
  const close = () => {
    upload.stop();
    onClose();
  };

  return (
    <Modal
      title="Upload a document"
      onClose={close}
      footer={
        <>
          <span className="spacer" />
          {/* Publishing cannot be taken back, so there is nothing to cancel;
              the dialog's own close button stays, and the caption says so. */}
          {upload.phase.kind === "publishing" ? null : (
            <button type="button" className="btn" onClick={close}>
              {upload.phase.kind === "sending" ? "Stop" : "Cancel"}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready || upload.busy}
            aria-busy={upload.busy}
            onClick={() => void send()}
          >
            {upload.busy ? "Uploading…" : "Upload"}
          </button>
        </>
      }
    >
      <FileDropzone pick={pick} onPick={setPick} />

      {plan && pick ? <PlanSummary plan={plan} pick={pick} version={false} /> : null}

      <UploadProgress phase={upload.phase} bytes={plan?.bytes ?? 0} />

      <div className="field" style={{ marginTop: "var(--s-3)" }}>
        <label className="field-label" htmlFor="upload-title">
          Title
        </label>
        <input
          id="upload-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="From the page's <title>, else the file or folder name"
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
          onChange={(e) => { markingChosen.current = true; setMarking({ ...marking, enabled: e.target.checked }); }}
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
