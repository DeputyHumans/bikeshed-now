// SPDX-License-Identifier: Apache-2.0
// Self-test: accounts.mjs rand4 draws each of [a-z0-9] equally often, so no suffix of a run's addresses and ids is likelier than another (SPEC §12).

/**
 * Statistical, with margins wide enough to be deterministic in practice.
 * 50,000 calls are 200,000 characters: about 5,556 per character when each
 * is 1/36, with a standard deviation near 74. `b % 36` over every byte gives
 * a–d 8/256 (6,250 expected) and every other character 7/256 (5,469): the
 * gap between the two groups' means is about 780 with that bias, and about
 * 0 ± 40 without. The bar is 300, more than seven deviations from both.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rand4 } from "../lib/accounts.mjs";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

test("rand4: four characters of [a-z0-9], each of the 36 equally likely (no modulo bias towards a–d)", () => {
  const counts = new Map([...ALPHABET].map((c) => [c, 0]));
  const calls = 50_000;
  for (let i = 0; i < calls; i += 1) {
    const s = rand4();
    assert.match(s, /^[a-z0-9]{4}$/);
    for (const c of s) counts.set(c, counts.get(c) + 1);
  }
  const mean = (cs) => cs.reduce((n, c) => n + counts.get(c), 0) / cs.length;
  const low = mean([..."abcd"]);
  const rest = mean([...ALPHABET.slice(4)]);
  assert.ok(Math.abs(low - rest) < 300, `a–d are drawn ${Math.round(low)} times each on average, the other 32 ${Math.round(rest)}: one group is favoured`);
  const expected = (calls * 4) / 36;
  for (const [c, n] of counts) assert.ok(Math.abs(n - expected) < 600, `${c} drawn ${n} times, expected about ${Math.round(expected)}`);
});
