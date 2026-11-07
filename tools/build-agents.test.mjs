// SPDX-License-Identifier: Apache-2.0
// The address a skill names in the repo, and the one a deployment is given (SPEC §19).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOSTED_ORIGIN, readSkills, servedSkill } from "./build-agents.mjs";
import { TOKEN } from "./stamp-deployment.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVED = join(ROOT, "app", "public", "skills");
const HOST = new URL(HOSTED_ORIGIN).host;

/** The fewest addresses the publishing skill can name and still tell an agent where to go. */
const FEWEST = 3;

const count = (text, needle) => text.split(needle).length - 1;

test("a skill read straight from the repo names a real address, never the placeholder", () => {
  // The marketplace hands these files to an agent as they are, and nothing
  // stamps them on the way. A placeholder here gets exported literally.
  const skills = readSkills();
  assert.ok(skills.length > 0, "there are no skills to check");
  for (const { name, text } of skills) {
    assert.equal(text.includes("<deployment>"), false, `${name} still names the placeholder`);
  }
  const publishing = skills.find((s) => s.name === "bs-publish");
  assert.ok(count(publishing.text, HOSTED_ORIGIN) >= FEWEST, "the publishing skill stopped naming an address");
});

test("what a deployment is given names the placeholder, never the hosted address", () => {
  // The whole point of the swap. A deployment with no custom domain has nothing
  // to stamp with and passes the gate on purpose, so a real address arriving
  // here would be served as is, and the CLI would send that deployment's token
  // to it. Checked against the committed copies, because those are what a build
  // takes, and by bare host, because a bare mention would survive the swap.
  const skills = readSkills();
  for (const { name, text } of skills) {
    const served = readFileSync(join(SERVED, name, "SKILL.md"), "utf8");
    assert.equal(served, servedSkill(text), `app/public/skills/${name} is not the swapped copy`);
    assert.equal(served.includes(HOST), false, `app/public/skills/${name} names ${HOST}`);
  }
  const publishing = readFileSync(join(SERVED, "bs-publish", "SKILL.md"), "utf8");
  assert.ok(count(publishing, TOKEN) >= FEWEST, "the served publishing skill stopped naming the token");
  assert.equal(readFileSync(join(SERVED, "index.json"), "utf8").includes(HOST), false, "index.json names the host");
});

test("the swap replaces every occurrence, and leaves other addresses alone", () => {
  assert.equal(
    servedSkill(`a ${HOSTED_ORIGIN}/mcp b ${HOSTED_ORIGIN} c https://other.example/x`),
    `a ${TOKEN}/mcp b ${TOKEN} c https://other.example/x`,
  );
});

test("the swap does not expand a $ sequence", () => {
  // The token itself holds none today. `split`/`join` keeps that from mattering
  // if it ever does, for the reason tools/stamp-deployment.mjs gives.
  assert.equal(servedSkill("$& $1"), "$& $1");
});

test("the address the skills name is the one the CLI falls back to", () => {
  // Two statements of which deployment an unconfigured reader belongs to.
  const config = readFileSync(join(ROOT, "cli", "src", "config.mjs"), "utf8");
  assert.ok(config.includes(`"${HOSTED_ORIGIN}"`), `cli/src/config.mjs does not default to ${HOSTED_ORIGIN}`);
});

test("the address the skills name is the one the account screen offers the marketplace on", () => {
  // Compared there and printed nowhere, so nothing else would notice it drift,
  // and a deployment that moved would stop offering the marketplace in silence.
  const account = readFileSync(join(ROOT, "app", "src", "pages", "Account.tsx"), "utf8");
  assert.ok(account.includes(`const HOSTED_ORIGIN = "${HOSTED_ORIGIN}";`), `Account.tsx does not compare with ${HOSTED_ORIGIN}`);
});
