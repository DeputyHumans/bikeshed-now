// SPDX-License-Identifier: Apache-2.0
// Explicit epoch-aware live-log observations preserve retired and legacy bytes in cleanup oracles (SPEC §6b, §16).

/** Keep every epoch, including retired ones: querying only the new empty epoch is a vacuous cleanup check. */
export function flattenLiveLogs(raw) {
  const result = {};
  for (const [epoch, entries] of Object.entries(raw ?? {})) {
    if (typeof entries === 'string') { result[`legacy/${epoch}`] = entries; continue; }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`invalid live log epoch ${epoch}`);
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== 'string') throw new Error(`invalid live log entry ${epoch}/${key}`);
      result[`${epoch}/${key}`] = value;
    }
  }
  return result;
}
export async function readLiveLogs(target, docId) {
  const { rtdbGet } = await import('./admin.mjs');
  return flattenLiveLogs(await rtdbGet(target, `status/${docId}/y`));
}
export async function readLiveLogsPatient(target, docId, options) {
  const { rtdbGetPatient } = await import('./live.mjs');
  return flattenLiveLogs(await rtdbGetPatient(target, `status/${docId}/y`, options));
}
/** Resolve a deliberate write target; generic RTDB readers keep literal wire semantics. */
export async function liveLogPath(target, docId) {
  const { readDoc } = await import('./admin.mjs');
  const meta = await readDoc(target, `docs/${docId}`);
  const epoch = meta?.liveEpoch ?? 'initial';
  if (typeof epoch !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(epoch)) throw new Error('invalid live epoch metadata');
  return `status/${docId}/y/${epoch}`;
}
