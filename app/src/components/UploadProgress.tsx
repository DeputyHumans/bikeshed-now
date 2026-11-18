// SPDX-License-Identifier: Apache-2.0
// An upload's progress, and what closing the dialog would do now (SPEC §2).

import { formatBytes } from "../bundleInput";
import type { UploadPhase } from "../hooks/useUploadRun";

/**
 * Two phases a person needs told apart: while the bytes are on their way,
 * closing stops them and nothing is published; once they have all arrived,
 * the deployment is publishing and finishes whatever happens here.
 */
export function UploadProgress({ phase, bytes }: { phase: UploadPhase; bytes: number }) {
  if (phase.kind === "idle") return null;
  const fraction = phase.kind === "sending" ? phase.fraction : 1;
  return (
    <div className="upload-status" style={{ marginTop: "var(--s-3)" }}>
      <div
        className="upload-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-label={phase.kind === "sending" ? "Sending" : "Publishing"}
      >
        <div className="upload-progress-bar" style={{ width: `${fraction * 100}%` }} />
      </div>
      <p className="caption" aria-live="polite">
        {phase.kind === "sending"
          ? `Sending ${formatBytes(Math.round(fraction * bytes))} of ${formatBytes(bytes)}. Closing this stops the upload.`
          : "Publishing. It finishes even if you close this."}
      </p>
    </div>
  );
}
