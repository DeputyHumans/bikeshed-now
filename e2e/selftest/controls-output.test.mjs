// SPDX-License-Identifier: Apache-2.0
// Full control-worker summaries drain their pipe before process exit (SPEC §12).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

test('a full control-worker summary survives piped output and exit', async () => {
  const source = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('\n', source.indexOf('  ledger.ok = allOk;'));
  const end = source.indexOf('\n}', start);
  const completion = source.slice(start, end).replace('  save();', '');
  const controls = Array.from({ length: 241 }, (_, i) => ({
    set: `controls-${i}`, oracle: 'long scenario '.repeat(160), ok: true,
    red: { case: { status: 'fail' } }, green: { status: 'pass' }, problems: [],
  }));
  const script = `import { join } from 'node:path'; const dir='/tmp/controls'; const allOk=true; const ledger=${JSON.stringify({ controls })}; ${completion}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [], errors = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const output = Buffer.concat(chunks).toString();
  assert.ok(output.length > 400_000, 'the complete summary exceeds pipe capacity');
  const result = JSON.parse(output);
  assert.equal(result.controls.length, 241);
  assert.equal(result.controls.at(-1).oracle, controls.at(-1).oracle);
});
