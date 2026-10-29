// SPDX-License-Identifier: Apache-2.0
// Prevent committed release provenance from contaminating isolated unit evidence or erasing its source observations (SPEC §12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syntheticCampaignTemplate } from './e2e-test-campaign.mjs';
function ledger() {
  return { proofs: [{ id: 'actual-proof' }], controls: [{ id: 'actual-control' }], acceptance: {
    evidenceExport: { source: 'private-artifact' }, sourceDerivations: ['actual-source'], raceEvidencePolicy: { cloud: 'private-artifact' }, exclusions: ['actual-exclusion'],
    concurrencyScope: { maxParticipants: 10 }, requirements: [{ id: 'controls', command: 'run controls', proofs: ['actual-proof'], controlSets: ['actual-set'] }],
    deferredRequirements: [{ id: 'n20', n: 20, proofs: ['actual-proof'] }],
  }, items: [{ id: 'defect', claim: 'original claim', requiredCases: [{ caseId: 'case', n: 10 }], state: 'resolved', resolution: { proofs: ['actual-proof'] } }],
  discoveries: [{ id: 'discovery', state: 'resolved', resolution: { proofs: ['actual-proof'] } }],
  coverage: { items: [{ id: 'historical', state: 'historical-closed', historicalResolution: { source: 'audit' } }, { id: 'current', state: 'resolved', resolution: { proofs: ['actual-proof'] } }] } };
}
test('actual artifacts cannot leak into synthetic cases, including through deferred cells or closure records', () => {
  const out=syntheticCampaignTemplate(ledger());
  assert.doesNotMatch(JSON.stringify(out), /actual-proof|actual-control|actual-source|private-artifact|actual-exclusion|actual-set/);
  assert.equal(out.items[0].state,'open'); assert.equal(out.discoveries[0].state,'open'); assert.equal(out.coverage.items[1].state,'open');
});
test('fixture preparation leaves the real ledger and all structural obligations untouched', () => {
  const real=ledger(), before=structuredClone(real), out=syntheticCampaignTemplate(real);
  assert.deepEqual(real,before);
  assert.deepEqual(out.items[0].requiredCases,real.items[0].requiredCases);assert.equal(out.items[0].claim,real.items[0].claim);
  assert.deepEqual(out.acceptance.concurrencyScope,real.acceptance.concurrencyScope);
  assert.equal(out.acceptance.requirements[0].command,real.acceptance.requirements[0].command);
  assert.equal(out.acceptance.deferredRequirements[0].n,20);
  assert.deepEqual(out.coverage.items[0],real.coverage.items[0]);
});
