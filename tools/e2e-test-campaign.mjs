// SPDX-License-Identifier: Apache-2.0
// Isolate synthetic evidence tests from completed campaign artifacts while retaining every structural obligation (SPEC §12).
export function syntheticCampaignTemplate(ledger) {
  const c = structuredClone(ledger);
  c.proofs = []; c.controls = [];
  for (const key of ['sourceDerivations', 'raceEvidencePolicy', 'exclusions', 'evidenceExport']) delete c.acceptance[key];
  for (const row of [...c.acceptance.requirements, ...(c.acceptance.deferredRequirements ?? [])]) {
    row.proofs = [];
    if (row.id === 'controls') row.controlSets = [];
  }
  for (const row of [...c.items, ...c.discoveries, ...c.coverage.items]) {
    if (row.state === 'historical-closed') continue;
    row.state = 'open';
    delete row.resolution;
  }
  return c;
}
