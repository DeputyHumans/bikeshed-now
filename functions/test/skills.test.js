// SPDX-License-Identifier: Apache-2.0
// The packaged skills describe the surface that actually exists (SPEC §19).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..");

/**
 * Why this test exists
 * --------------------
 * A skill is instructions an agent BELIEVES. If one names `bikeshed rename` or
 * a `delete_document` tool, an agent will try it, spend a round trip on a
 * refusal it cannot act on, and — the expensive case — conclude the capability
 * is missing when it is merely misnamed. Prose about a surface rots the moment
 * the surface moves, and nothing here would notice.
 *
 * So the skills are checked against the two things they describe: the commands
 * the CLI advertises in `--help`, and the tools the MCP server actually serves.
 * The same check runs over `docs/agent-guide.md`, which a deployment serves at
 * `/llms.txt` and which rots in exactly the same way.
 *
 * The reverse direction is checked too — every tool and every command must be
 * NAMED in the guide — because the failure that costs most is not a skill
 * describing something absent. It is a capability nobody is told about.
 */

const GUIDE = readFileSync(join(ROOT, "docs", "agent-guide.md"), "utf8");

/** Every tool the server serves, from the built bundle. */
const { TOOL_NAMES } = require("../lib/mcp/tools.js");

/** Commands the CLI advertises. `--help` is the contract; the table is not. */
function advertisedCommands() {
  const usage = execFileSync(
    process.execPath,
    [join(ROOT, "cli", "src", "index.mjs"), "--help"],
    { encoding: "utf8" },
  );
  return new Set([...usage.matchAll(/^ {2}bikeshed ([a-z][a-z-]*)/gm)].map((m) => m[1]));
}

/**
 * Only CODE is scanned, never prose.
 *
 * "on a Bikeshed deployment" is a sentence; `bikeshed publish` is a claim about
 * what exists. Scanning prose would make every mention of the product's name
 * look like a command, and the check would be abandoned within a week.
 */
function codeSpans(text) {
  const spans = [];
  for (const m of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) spans.push(m[1]);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) spans.push(m[1]);
  return spans;
}

function commandsIn(text) {
  const found = new Set();
  for (const span of codeSpans(text)) {
    for (const m of span.matchAll(/\bbikeshed ([a-z][a-z-]*)/g)) found.add(m[1]);
  }
  return found;
}

function toolsIn(text) {
  const found = new Set();
  for (const span of codeSpans(text)) {
    for (const m of span.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)) found.add(m[1]);
  }
  return found;
}

/** Every document that makes claims about the surface, by the name to report. */
async function documents() {
  const { readSkills } = await import("../../tools/build-agents.mjs");
  const skills = readSkills();
  return {
    skills,
    texts: [
      ["docs/agent-guide.md", GUIDE],
      ["skills/README.md", readFileSync(join(ROOT, "skills", "README.md"), "utf8")],
      ...skills.map((s) => [`skills/${s.name}/SKILL.md`, s.text]),
    ],
  };
}

// --- The skills are well formed -------------------------------------------

test("every skill declares the name of the directory it is in", async () => {
  const { skills } = await documents();
  assert.ok(skills.length > 0, "there are no skills to check");
  for (const skill of skills) {
    assert.equal(
      skill.declaredName,
      skill.name,
      `skills/${skill.name}/SKILL.md declares "${skill.declaredName}"`,
    );
  }
});

test("every skill's description says when to load it", async () => {
  const { skills } = await documents();
  for (const skill of skills) {
    // The description is the ONLY part an agent reads before deciding whether
    // to load the rest, so a two-word one is a skill that never loads.
    assert.ok(
      skill.description.length >= 60,
      `${skill.name}: description is too short to match against`,
    );
    assert.ok(
      skill.description.length <= 600,
      `${skill.name}: description is long enough to be the skill`,
    );
    assert.match(skill.description, /^Use when /, `${skill.name}: say when, first`);
  }
});

// --- They describe a surface that exists ----------------------------------

test("every bikeshed command any of these documents names is a real one", async () => {
  const advertised = advertisedCommands();
  assert.ok(advertised.has("publish"), "the usage block did not parse");
  const { texts } = await documents();
  for (const [where, text] of texts) {
    for (const command of commandsIn(text)) {
      assert.ok(
        advertised.has(command),
        `${where} names \`bikeshed ${command}\`, which the CLI does not advertise`,
      );
    }
  }
});

test("every MCP tool any of these documents names is a real one", async () => {
  const known = new Set(TOOL_NAMES);
  const { texts } = await documents();
  for (const [where, text] of texts) {
    for (const tool of toolsIn(text)) {
      assert.ok(known.has(tool), `${where} names a tool \`${tool}\` that does not exist`);
    }
  }
});

// --- Nothing exists that the instructions fail to mention ------------------

test("the guide names every tool the server serves", () => {
  // The costly drift is not a skill describing something absent — an agent
  // finds that out in one call. It is a capability nobody is ever told about.
  for (const tool of TOOL_NAMES) {
    assert.ok(GUIDE.includes(tool), `docs/agent-guide.md never mentions ${tool}`);
  }
});

test("the guide names every command the CLI advertises", () => {
  for (const command of advertisedCommands()) {
    assert.ok(
      commandsIn(GUIDE).has(command),
      `docs/agent-guide.md never shows \`bikeshed ${command}\``,
    );
  }
});

test("the guide points at every skill, since it is what an agent reads first", async () => {
  const { skills } = await documents();
  for (const skill of skills) {
    assert.ok(GUIDE.includes(skill.name), `docs/agent-guide.md never mentions ${skill.name}`);
  }
});

// --- What is served is what is in the tree --------------------------------

test("the served index lists exactly the skills in the tree", async () => {
  const { skills } = await documents();
  const index = JSON.parse(
    readFileSync(join(ROOT, "app", "public", "skills", "index.json"), "utf8"),
  );
  assert.deepEqual(
    index.skills.map((s) => s.name),
    skills.map((s) => s.name),
  );
  for (const entry of index.skills) {
    // The path is what `bikeshed skills install` fetches and then writes to
    // disk, so it must stay a plain relative path with no way out of it.
    assert.equal(entry.path, `skills/${entry.name}/SKILL.md`);
    assert.match(entry.name, /^[a-z0-9][a-z0-9-]*$/);
  }
});
