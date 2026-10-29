// SPDX-License-Identifier: Apache-2.0
// Exercise explicit stale-snapshot recovery before a test actor begins editing (SPEC §6b).

import assert from "node:assert/strict";

/** Only the documented, non-editable snapshot refusal permits Reload draft. */
export function staleDraftAdmission(state) {
  if (state.editable || state.share !== "off" || state.contentType !== "application/json") return false;
  let body;
  try { body = JSON.parse(state.body); } catch { return false; }
  if (body?.draftChanged !== true || body.error !== "The draft changed. Reload before editing.") return false;
  const url = new URL(state.url);
  return url.pathname.startsWith("/draft/") && Boolean(url.searchParams.get("baseVersion")) &&
    Boolean(url.searchParams.get("liveEpoch")) && /^[a-f0-9]{64}$/.test(url.searchParams.get("draftRevision") ?? "");
}

/** Called only at admission, before this actor has typed or acquired an editable DOM. */
export async function withDraftAdmissionReload(read, reload, note, { maxRetries = 3 } = {}) {
  let state = await read();
  for (let attempt = 1; attempt <= maxRetries && staleDraftAdmission(state); attempt += 1) {
    const previous = new URL(state.url);
    note(`explicit Reload draft after a guarded stale admission (attempt ${attempt}/${maxRetries})`);
    await reload(state.url);
    state = await read();
    const current = new URL(state.url);
    for (const field of ["origin", "pathname"]) {
      assert.equal(current[field], previous[field], `draft admission recovery changed ${field}`);
    }
    for (const field of ["baseVersion", "liveEpoch"]) {
      assert.equal(current.searchParams.get(field), previous.searchParams.get(field), `draft admission recovery changed ${field}`);
    }
  }
  return state;
}
