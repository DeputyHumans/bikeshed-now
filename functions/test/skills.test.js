// SPDX-License-Identifier: Apache-2.0
// The packaged skills describe the surface that actually exists (SPEC §19).

const test = require("node:test");
const assert = require("node:assert/strict");
const { cpSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const AdmZip = require("adm-zip");

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
 * The same check runs over `docs/agents/agent-guide.md`, which a deployment serves at
 * `/llms.txt` and which rots in exactly the same way.
 *
 * The reverse direction is checked too — every tool and every command must be
 * NAMED in the guide — because the failure that costs most is not a skill
 * describing something absent. It is a capability nobody is told about.
 */

const GUIDE = readFileSync(join(ROOT, "docs", "agents", "agent-guide.md"), "utf8");

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

/**
 * `bikeshed <word>` in code, except where the word is an address: the server
 * name in `claude mcp add --transport http bikeshed https://…/mcp` is followed
 * by the URL, and reading `https` as a command would fail every document that
 * shows a person how to connect.
 */
function commandsIn(text) {
  const found = new Set();
  for (const span of codeSpans(text)) {
    for (const m of span.matchAll(/\bbikeshed (?!https?:)([a-z][a-z-]*)/g)) found.add(m[1]);
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
      ["docs/agents/agent-guide.md", GUIDE],
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

test("no agent-facing document promises that a token publish runs scripts", async () => {
  // `publishNewDocument` writes `trusted: false` for EVERY path a personal access
  // token can reach — the end-user CLI and MCP alike. Only the operator script
  // vouches, because it runs with Admin credentials and a person at the keyboard
  // (SPEC §6c). An agent told otherwise ships a document whose scripts never run
  // and says nothing to the reader looking at an empty box.
  const { texts } = await documents();
  for (const [where, text] of texts) {
    assert.doesNotMatch(
      text,
      /through a token is trusted/,
      `${where} says a token publish is trusted; publish.ts writes trusted: false`,
    );
  }
});

test("the publishing skill's description says what it is used INSTEAD of", async () => {
  // A description that matches only once Bikeshed has been chosen never loads at
  // the moment the choice is made. The harness has its own instruction to publish
  // finished work for other people, and it fires first; a skill that wants to be
  // read then has to match the same moment and name what it displaces.
  const { skills } = await documents();
  const publishing = skills.find((skill) => skill.name === "bikeshed-publishing");
  assert.ok(publishing, "there is no bikeshed-publishing skill");
  assert.match(
    publishing.description,
    /artifact/i,
    "the description never names the tool it is meant to be used instead of",
  );
});

test("no frontmatter value hides a colon a YAML parser would choke on", async () => {
  // `frontmatter()` in tools/build-agents.mjs is a line regex, not a parser, so
  // `description: who: what` passes every check in this repository. A real YAML
  // parser — which is what a harness loading these files uses — reads a nested
  // mapping and rejects the file, and the skill silently never loads.
  const { skills } = await documents();
  for (const skill of skills) {
    const block = skill.text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(block, `${skill.name}: no frontmatter block`);
    for (const line of block[1].split("\n")) {
      const value = line.replace(/^[a-z][a-z_-]*:\s*/, "");
      if (/^["']/.test(value)) continue; // quoted, so a colon inside is safe
      assert.ok(
        !value.includes(": "),
        `${skill.name}: "${value.slice(0, 48)}…" has an unquoted colon and will not parse`,
      );
    }
  }
});

test("every skill fits Claude's skill upload", async () => {
  // Settings → Capabilities → Skills refuses a SKILL.md whose name is over 64
  // characters, is anything but lowercase letters, digits and hyphens, or
  // contains a reserved word; and one whose description is over 1,024
  // characters. A refusal there is a person's dead end, not an agent's.
  const { skills } = await documents();
  for (const skill of skills) {
    const name = skill.declaredName;
    assert.ok(name.length <= 64, `${skill.name}: name is over Claude's 64 characters`);
    assert.match(name, /^[a-z0-9-]+$/, `${skill.name}: Claude takes only a-z, 0-9 and -`);
    assert.doesNotMatch(name, /claude|anthropic/i, `${skill.name}: the name uses a reserved word`);
    assert.ok(
      skill.description.length <= 1024,
      `${skill.name}: description is over Claude's 1,024 characters`,
    );
  }
});

// --- They describe a surface that exists ----------------------------------

test("an address after `bikeshed` is not a command, and a misnamed command still is", () => {
  // The connect line names the server `bikeshed` and then gives its address.
  assert.deepEqual(
    [...commandsIn("`claude mcp add --transport http bikeshed https://<deployment>/mcp`")],
    [],
  );
  assert.deepEqual([...commandsIn("`bikeshed http-proxy`")], ["http-proxy"]);
  // The control: the exception is for an address, not for anything unknown.
  assert.deepEqual([...commandsIn("`bikeshed rename draft.md`")], ["rename"]);
  assert.equal(advertisedCommands().has("rename"), false);
});

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
    assert.ok(GUIDE.includes(tool), `docs/agents/agent-guide.md never mentions ${tool}`);
  }
});

test("the guide names every command the CLI advertises", () => {
  for (const command of advertisedCommands()) {
    assert.ok(
      commandsIn(GUIDE).has(command),
      `docs/agents/agent-guide.md never shows \`bikeshed ${command}\``,
    );
  }
});

test("the guide names the package an agent installs the client from", () => {
  // The guide tells an agent to run `npx -y <name>`. If the package is renamed
  // and the guide is not, that instruction sends it to a registry entry that
  // does not exist, or — worse — to somebody else's.
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "cli", "package.json"), "utf8"),
  );
  assert.ok(
    GUIDE.includes(manifest.name),
    `docs/agents/agent-guide.md never names ${manifest.name}, the published client`,
  );
});

test("the guide points at every skill, since it is what an agent reads first", async () => {
  const { skills } = await documents();
  for (const skill of skills) {
    assert.ok(GUIDE.includes(skill.name), `docs/agents/agent-guide.md never mentions ${skill.name}`);
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
    // Where the Claude upload is downloaded from; packed into app/dist only.
    assert.equal(entry.archive, `skills/${entry.name}.zip`);
    assert.match(entry.name, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test("each skill's zip opens in another reader as its folder and its stamped SKILL.md", async () => {
  // adm-zip is a second implementation, so this cannot pass merely because the
  // writer and tools/zip.mjs's reader agree with each other. The dist is a copy
  // of app/public stamped the way a configured build stamps it, so the archive
  // is checked against the bytes a deployment actually serves beside it.
  const { servedDocuments, stampDist } = await import("../../tools/stamp-deployment.mjs");
  const { skills } = await documents();
  const base = mkdtempSync(join(tmpdir(), "bikeshed-skillzip-"));
  const dist = join(base, "dist");
  try {
    for (const rel of servedDocuments()) {
      cpSync(join(ROOT, "app", "public", rel), join(dist, rel));
    }
    stampDist(dist, "https://stamp.example");

    for (const skill of skills) {
      const zip = new AdmZip(join(dist, "skills", `${skill.name}.zip`));
      const entries = zip.getEntries();
      assert.deepEqual(
        entries.map((e) => e.entryName),
        [`${skill.name}/`, `${skill.name}/SKILL.md`],
        `${skill.name}.zip holds something other than its folder and SKILL.md`,
      );
      const [folder, file] = entries;
      assert.equal(folder.isDirectory, true);
      assert.equal(file.isDirectory, false);
      for (const entry of entries) assert.equal(entry.header.method, 0, "stored, not deflated");
      assert.equal(file.attr >>> 16, 0o100644);
      assert.equal(folder.attr >>> 16, 0o040755);

      const served = readFileSync(join(dist, "skills", skill.name, "SKILL.md"));
      assert.equal(file.getData().equals(served), true, `${skill.name}.zip is not the served SKILL.md`);
      assert.equal(served.toString("utf8").includes("<deployment>"), false);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
