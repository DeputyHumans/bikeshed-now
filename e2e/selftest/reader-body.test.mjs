// SPDX-License-Identifier: Apache-2.0
// Reader convergence excludes owned presence paint, retaining every authored element and marker value (SPEC §6a, §16).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openParser, KNOWN_OWN_VALUES } from "../lib/bytes.mjs";
import { bodyHash, readerBodyHash, readerBodyInPage } from "../lib/frame.mjs";

let parser;
before(async () => { parser = await openParser(); });
after(async () => { await parser?.close(); });
const body = (peer, authored = "theirs") => `<body><p data-bshd="whatever">${authored}</p><svg><text>vector</text></svg><div data-bshd="peers"><span>${peer}</span></div><style data-bshd="peer-style">.${peer}{color:red}</style></body>`;

async function sample(html, probe = readerBodyInPage) {
  await parser.page.setContent(html);
  return parser.page.evaluate(probe, [...KNOWN_OWN_VALUES]);
}

async function judge(probe) {
  const a = await sample(body("A"), probe);
  const b = await sample(body("B"), probe);
  assert.equal(a, b, "per-reader presence paint must not masquerade as divergent authored content");
  const changed = await sample(body("B", "changed authored text"), probe);
  assert.notEqual(a, changed, "unknown data-bshd values are authored and remain in convergence");
  assert.match(a, /<svg><text>vector<\/text><\/svg>/, "authored structure survives the comparison");
}

test("reader body sampling leaves the live DOM intact and ignores only owned paint", async () => {
  await judge(readerBodyInPage);
  const raw = await bodyHash(parser.page);
  const clean = await readerBodyHash(parser.page);
  assert.notEqual(raw.hash, clean.hash);
  assert.equal((await bodyHash(parser.page)).hash, raw.hash, "sampling never edits the frame");
});

test("NEGATIVE: raw DOM and stripping every marker each fail their intended comparison", async () => {
  await assert.rejects(judge(() => document.body.innerHTML), /presence paint must not/);
  const stripAll = new Function(`return (${readerBodyInPage.toString().replace('values.has(el.getAttribute("data-bshd"))', 'true')});`)();
  await assert.rejects(judge(stripAll), /unknown data-bshd values are authored/);
});
