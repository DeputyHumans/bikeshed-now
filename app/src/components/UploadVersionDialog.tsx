// SPDX-License-Identifier: Apache-2.0
// Files from disk as a document's next version, for people who iterate outside the app (SPEC §2, §6a).

import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { FileDropzone } from "./FileDropzone";
import { PlanSummary } from "./PlanSummary";
import { UploadProgress } from "./UploadProgress";
import { useToast } from "./Toast";
import { useUploadRun } from "../hooks/useUploadRun";
import { publishVersion, type VersionUploadResult } from "../upload";
import { baseFilesOf, planVersion, type BaseFiles, type Pick } from "../bundleInput";
import { getVersion } from "../firestore";

/** What to tell the person once the server has answered. */
export function versionUploadMessage(result: VersionUploadResult): string {
  if (result.deduped) return `No changes — it’s identical to ${result.versionId}.`;
  const c = result.changes;
  if (!c) return `Published ${result.versionId}.`;
  // What moved comes first, and only counts that are not zero: a folder that
  // only drops a file says "1 file removed, 3 unchanged", never "0 changed".
  const counts = ([[c.changed, "changed"], [c.removed, "removed"], [c.unchanged, "unchanged"]] as const).filter(([n]) => n > 0);
  if (counts.length === 0) return `Published ${result.versionId}.`;
  const said = counts.map(([n, what], i) => (i === 0 ? `${n} file${n === 1 ? "" : "s"} ${what}` : `${n} ${what}`));
  return `Published ${result.versionId} — ${said.join(", ")}.`;
}

/**
 * Says what an upload will do before it does it, because each consequence is
 * one the in-app "Save as new version" either does not have or asks about
 * first: the comments stay behind, the scripts are blocked again, and an
 * unpublished draft is thrown away (SPEC §6a, §6c). It also says, file by
 * file, what the upload replaces, adds or leaves out of the next version.
 *
 * The version it goes on top of is fixed when the dialog opens and sent as the
 * base. If somebody publishes while it is open, the dialog says so and will not
 * send; if they publish while the files are on their way, the server refuses
 * them. Either way they never land silently on a version nobody here has seen.
 */
export function UploadVersionDialog({
  docId,
  title,
  headVersion,
  base,
  trusted,
  draftBy,
  editing = [],
  initialPick = null,
  onClose,
  onPublished,
}: {
  docId: string;
  title: string;
  /** The version current right now, live: it may move while the dialog is open. */
  headVersion: string;
  /** What that version holds, for what an upload replaces, keeps and drops. Read here when not given. */
  base?: BaseFiles;
  /** Whether its scripts run now, for whoever is looking. */
  trusted: boolean;
  /** Who last saved the unpublished draft, when there is one. */
  draftBy?: string | null;
  /** Who has it open in the editor, when the caller can see that. */
  editing?: string[];
  /** Files dropped onto the document, to start from. */
  initialPick?: Pick | null;
  onClose: () => void;
  onPublished: (result: VersionUploadResult) => void;
}) {
  const toast = useToast();
  const [pick, setPick] = useState<Pick | null>(initialPick);
  const upload = useUploadRun();
  // Fixed at open: what the person is told they are replacing.
  const [baseVersion] = useState(headVersion);
  const moved = Boolean(headVersion && baseVersion && headVersion !== baseVersion);
  const blocked = moved || editing.length > 0;
  // What the version holds decides what an upload replaces and drops, so it
  // is known before a plan is shown: a guess would call a replacement "added".
  const [files, setFiles] = useState<BaseFiles | "failed" | null>(base ?? null);
  useEffect(() => {
    if (base) { setFiles(base); return; }
    let live = true;
    getVersion(docId, baseVersion)
      .then((v) => { if (live) setFiles(v ? baseFilesOf(v) : "failed"); })
      .catch(() => { if (live) setFiles("failed"); });
    return () => { live = false; };
  }, [base, docId, baseVersion]);
  const plan = useMemo(() => (pick && files && files !== "failed" ? planVersion(pick, files) : null), [pick, files]);
  const ready = Boolean(plan && plan.problems.length === 0 && !blocked);

  const send = async () => {
    if (!plan || !ready) return;
    try {
      const result = await upload.run((control) => publishVersion(plan, { docId, baseVersion, ...control }));
      if (result) onPublished(result);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Closing while the bytes are on their way stops them; once they have all
  // arrived the deployment finishes, and the document shows the new version.
  const close = () => {
    upload.stop();
    onClose();
  };

  return (
    <Modal
      title="Upload a new version"
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
            {upload.busy ? "Publishing…" : "Publish"}
          </button>
        </>
      }
    >
      <p>
        What you upload becomes the next version of <strong>{title}</strong>, after {baseVersion || "the current one"}, at the same address.
      </p>

      <FileDropzone pick={pick} onPick={setPick} />

      {plan && pick ? <PlanSummary plan={plan} pick={pick} version /> : null}
      {pick && files === "failed" ? (
        <p className="banner banner-error" role="alert">The files in {baseVersion} couldn’t be read, so there’s nothing to compare the upload with. Close this and try again.</p>
      ) : null}

      <UploadProgress phase={upload.phase} bytes={plan?.bytes ?? 0} />

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
        <li>Comments stay on {baseVersion || "the current version"}. The new version starts with none.</li>
        {draftBy ? <li>The unpublished edits {draftBy} last saved are discarded.</li> : null}
        {trusted ? <li>Its scripts are blocked again until somebody trusts the new version.</li> : null}
      </ul>
    </Modal>
  );
}
