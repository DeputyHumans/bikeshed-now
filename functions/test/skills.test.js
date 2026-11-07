// SPDX-License-Identifier: Apache-2.0
// The packaged skills describe the surface that actually exists (SPEC §19).

const test = require("node:test");
const assert = require("node:assert/strict");
const { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require("node:fs");
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
  // The user guide is HTML, where code is an element rather than backticks.
  // Without this, adding it below would check nothing and pass.
  for (const m of text.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)) spans.push(decodeEntities(m[1]));
  return spans;
}

/** Enough of HTML's entities for code: `&lt;id&gt;` must read as `<id>`. */
function decodeEntities(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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
      ["claude-plugin/README.md", readFileSync(join(ROOT, "claude-plugin", "README.md"), "utf8")],
      ...skills.map((s) => [`claude-plugin/skills/${s.name}/SKILL.md`, s.text]),
      // The guides a deployment opens at /docs and /docs/developers. People
      // read them, but the developer guide makes the same claims about the
      // surface, and the user guide must go on naming none it gets wrong.
      ...["docs", "docs-developers"].map((id) => [
        `content/${id}/bundle/index.html`,
        readFileSync(join(ROOT, "content", id, "bundle", "index.html"), "utf8"),
      ]),
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
      `claude-plugin/skills/${skill.name}/SKILL.md declares "${skill.declaredName}"`,
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

test("every skill is named bs- and one word", async () => {
  // People type these. The prefix stays because the single zips and
  // `bikeshed skills install` have no plugin to namespace them, where a bare
  // `publish` says nothing, and Claude Code keeps some bare names for itself.
  const { skills } = await documents();
  for (const skill of skills) {
    assert.match(skill.name, /^bs-[a-z]+$/, `${skill.name} is not bs- and one word`);
  }
});

test("every skill's description names Bikeshed, because its name no longer does", async () => {
  // The description is what an agent matches. With only `bs-` in the name,
  // a description that left the product out could load for anyone's publishing.
  const { skills } = await documents();
  for (const skill of skills) {
    assert.match(skill.description, /Bikeshed/, `${skill.name}: the description never says Bikeshed`);
  }
});

test("every skill a document names exists, and the old names are gone", async () => {
  // They send an agent to each other by name, and nothing else would notice a
  // reference to a skill that is not there.
  const { skills, texts } = await documents();
  const known = new Set(skills.map((s) => s.name));
  const served = ["llms.txt", "skills/index.json", ...skills.map((s) => s.path)].map((rel) => [
    `app/public/${rel}`,
    readFileSync(join(ROOT, "app", "public", rel), "utf8"),
  ]);
  let references = 0;
  for (const [where, text] of [...texts, ...served]) {
    for (const [name] of text.matchAll(/\bbs-[a-z][a-z-]*/g)) {
      references += 1;
      assert.ok(known.has(name), `${where} names a skill ${name} that does not exist`);
    }
    assert.doesNotMatch(
      text,
      /bikeshed-(publishing|feedback|folders|permissions)/,
      `${where} still uses an old skill name`,
    );
  }
  assert.ok(references > 0, "no document named a skill, so this checked nothing");
});

test("no document calls a skill by a word that is not its name", async () => {
  // The check above only sees `bs-…`, so "the feedback skill" walked past it
  // after the rename: nothing is called that, and an agent is left to guess.
  const { texts } = await documents();
  const architecture = ["spec.md", "threat-model.md"].map((file) => [
    `docs/architecture/${file}`,
    readFileSync(join(ROOT, "docs", "architecture", file), "utf8"),
  ]);
  for (const [where, text] of [...texts, ...architecture]) {
    assert.doesNotMatch(
      text,
      /\b(?:publishing|feedback|folders?|permissions?|sharing)\s+skills?\b/i,
      `${where} calls a skill by something other than its name`,
    );
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
  const publishing = skills.find((skill) => skill.name === "bs-publish");
  assert.ok(publishing, "there is no bs-publish skill");
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
  // Customize > Skills refuses a SKILL.md whose name is over 64
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
  assert.deepEqual([...commandsIn("`bikeshed unpublish draft.md`")], ["unpublish"]);
  assert.equal(advertisedCommands().has("unpublish"), false);
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

// Only the agent guide used to be held to naming everything, so the developer
// guide's command reference, which says it is "every bikeshed command, in one
// place", went without `revise` and `withdraw` for a release, and nothing
// failed. SPEC §19's tool table is held the same way.
const DEVELOPER_GUIDE = readFileSync(join(ROOT, "content", "docs-developers", "bundle", "index.html"), "utf8");

test("the developer guide names every tool and every command", () => {
  const tools = toolsIn(DEVELOPER_GUIDE);
  for (const tool of TOOL_NAMES) {
    assert.ok(tools.has(tool), `content/docs-developers never shows \`${tool}\``);
  }
  const commands = commandsIn(DEVELOPER_GUIDE);
  for (const command of advertisedCommands()) {
    assert.ok(commands.has(command), `content/docs-developers never shows \`bikeshed ${command}\``);
  }
});

test("SPEC §19 names every tool the server serves", () => {
  const spec = readFileSync(join(ROOT, "docs", "architecture", "spec.md"), "utf8");
  const start = spec.indexOf("\n## 19.");
  const end = spec.indexOf("\n## 20.", start);
  assert.ok(start >= 0 && end > start, "SPEC §19 was not found");
  const tools = toolsIn(spec.slice(start, end));
  for (const tool of TOOL_NAMES) {
    assert.ok(tools.has(tool), `SPEC §19 never shows \`${tool}\``);
  }
});

// The consent page (`app/src/pages/Connect.tsx`) is the list a person approves
// an app against, and SPEC §23 makes it §19's list. When 0.11.0 let an agent
// accept, reject and resolve, the page went on saying it could not, and no test
// read it. So every tool must be claimed by a phrase on the "will be able to"
// list, and no claimed phrase may appear on the "won't" list. A new tool fails
// here until somebody decides how the page says it.
const CONSENT_CLAIMS = {
  list_versions: "read what you can read",
  get_document_access: "manage sharing",
  set_document_access: "manage sharing",
  get_folder_access: "manage sharing",
  set_folder_access: "manage sharing",
  set_document_visibility: "change visibility",
  set_folder_visibility: "change visibility",
  rename_folder: "rename folders",
  move_folder: "move documents and folders you own",
  delete_folder: "to the trash",
  trash_document: "to the trash",
  restore_from_trash: "to the trash",
  list_trash: "read what you can read",
  list_documents: "read what you can read",
  get_document: "read what you can read",
  get_lineage: "read what you can read",
  get_comments: "read what you can read",
  get_changes: "read what you can read",
  list_folders: "read what you can read",
  get_folder: "read what you can read",
  publish_document: "publish",
  fork_document: "publish",
  update_document: "revise",
  rename_document: "rename documents",
  commit_draft: "new version",
  suggest_edit: "suggest edits",
  revise_suggestion: "suggest edits",
  withdraw_suggestion: "suggest edits",
  accept_suggestion: "accept",
  reject_suggestion: "reject",
  add_comment: "comment",
  reply_to_comment: "reply",
  resolve_thread: "resolve threads",
  reopen_thread: "resolve threads",
  create_folder: "create folders",
  move_document: "move documents and folders you own",
};

function consentLists() {
  const page = readFileSync(join(ROOT, "app", "src", "pages", "Connect.tsx"), "utf8");
  const list = (cls) => {
    const m = page.match(new RegExp(`<ul className="${cls}">([\\s\\S]*?)</ul>`));
    assert.ok(m, `Connect.tsx has no <ul className="${cls}">`);
    return [...m[1].matchAll(/<li>([^<]*)<\/li>/g)].map((li) => li[1].toLowerCase()).join("\n");
  };
  return { will: list("connect-list"), wont: list("connect-list connect-list-not") };
}

test("the consent page says what every tool lets an app do, and never the opposite", () => {
  const { will, wont } = consentLists();
  for (const tool of TOOL_NAMES) {
    const claim = CONSENT_CLAIMS[tool];
    assert.ok(claim, `the consent page has no phrase for ${tool}: add one here, and say it on the page`);
    assert.ok(will.includes(claim), `the consent page never says an app can "${claim}" (${tool})`);
    assert.ok(!wont.includes(claim), `the consent page says an app cannot "${claim}", yet ${tool} does`);
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

// --- A count is a claim too ------------------------------------------------

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty",
];

const TENS = ["twenty", "thirty", "forty"];

/**
 * "all twelve tools", "Thirteen MCP tools", "13 tools", "twenty-one tools":
 * every count of the tools a text gives, as a number. Only a number directly
 * before "tools" or "MCP tools" counts, so "the three folder tools" is a
 * remark about three of them and is left alone. A compound is read whole: a
 * hyphen is a word boundary, so "twenty-one" would otherwise read as "one".
 */
function toolCounts(text) {
  const compound = `(?:${TENS.join("|")})-(?:${NUMBER_WORDS.slice(1, 10).join("|")})`;
  const word = `${compound}|\\d+|${[...TENS, ...NUMBER_WORDS].join("|")}`;
  const pattern = new RegExp(`(?<![\\w-])(${word})\\s+(?:MCP\\s+)?tools\\b`, "gi");
  return [...text.matchAll(pattern)].map((m) => ({ said: m[0], n: numberOf(m[1].toLowerCase()) }));
}

function numberOf(word) {
  if (/^\d+$/.test(word)) return Number(word);
  const [tens, unit] = word.split("-");
  const t = TENS.indexOf(tens);
  if (t >= 0) return (t + 2) * 10 + (unit ? NUMBER_WORDS.indexOf(unit) : 0);
  return NUMBER_WORDS.indexOf(word);
}

test("a tool count is read as the number it says, and a remark about some tools is not one", () => {
  assert.deepEqual(
    toolCounts("all twelve tools, Thirteen MCP tools, 14 tools, the three folder tools").map((c) => c.n),
    [12, 13, 14],
  );
  // A compound is one number, not its last word.
  assert.deepEqual(toolCounts("all twenty-one tools, Twenty-two MCP tools, twenty tools").map((c) => c.n), [21, 22, 20]);
});

test("every count of the tools these documents give is the number the server serves", async () => {
  // The name checks above cannot see a number. "you have all twelve tools" sat
  // four lines above a table of thirteen, in what every deployment serves at
  // /llms.txt, for a whole release. The README and the verification
  // walkthrough state the same figure, so they are held to it too; the ADRs
  // and the changelog record what it was, and are not.
  const { texts } = await documents();
  const alsoStating = ["README.md", "docs/development/verification.md"].map((path) => [
    path,
    readFileSync(join(ROOT, path), "utf8"),
  ]);
  for (const [where, text] of [...texts, ...alsoStating]) {
    for (const { said, n } of toolCounts(text)) {
      assert.equal(n, TOOL_NAMES.length, `${where} says "${said}", but the server serves ${TOOL_NAMES.length}`);
    }
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

// --- What a marketplace reads straight from the repo ------------------------

/** The catalogue at the repo root, and the one plugin it lists. */
function catalogue() {
  return JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
}

function manifest() {
  return JSON.parse(readFileSync(join(ROOT, "claude-plugin", ".claude-plugin", "plugin.json"), "utf8"));
}

/** A directory's names, sorted, without what Finder leaves behind on a Mac. */
const listing = (...path) => readdirSync(join(...path)).filter((n) => n !== ".DS_Store").sort();

test("the catalogue has the fields Claude requires, and lists one plugin", () => {
  const { name, owner, plugins } = catalogue();
  assert.match(name, /^[a-z0-9-]+$/);
  assert.doesNotMatch(name, /claude|anthropic/i, "a name impersonating an official marketplace is refused");
  assert.equal(typeof owner?.name, "string");
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, manifest().name, "the catalogue lists a plugin that is not this one");
});

test("neither the catalogue nor the manifest sets a version", () => {
  // A SKILL.md-only change deploys without a release, and a fixed version keeps
  // readers on their cached copy "however many commits" are pushed. With none,
  // the commit decides, so a corrected skill reaches them.
  assert.equal("version" in catalogue().plugins[0], false, "the catalogue sets a version");
  assert.equal("version" in manifest(), false, "the manifest sets a version");
});

test("the catalogue warns that it is for one deployment, whatever the manifest says", () => {
  // Someone running their own deployment who adds this gets skills naming the
  // hosted one, and the CLI would send their token there. Someone browsing the
  // catalogue reads the entry's description even when the manifest sets its own,
  // so the warning holds only while the entry sets one.
  const { description, plugins } = catalogue();
  assert.match(description ?? "", /bikeshed\.now/, "the catalogue's own description names no deployment");
  assert.match(plugins[0].description ?? "", /bikeshed\.now/, "the entry's description names no deployment");
  assert.match(plugins[0].description ?? "", /your own deployment/, "the entry's description has lost its warning");
  assert.equal(new URL(plugins[0].homepage).host, "bikeshed.now");
});

test("the manifest describes the plugin, because an upload has nothing else to show", () => {
  // An uploaded zip comes with no catalogue, so a field missing here is a blank
  // on the plugin's page: "No description found in plugin.json".
  const { displayName, description, author, homepage, repository, keywords } = manifest();
  assert.equal(displayName, "Bikeshed");
  assert.equal(typeof description, "string", "the manifest has no description");
  assert.ok(description.length >= 60, "the description is too short to say what the plugin does");
  assert.equal(typeof author?.name, "string", "the manifest has no author");
  assert.ok(Array.isArray(keywords) && keywords.length > 0, "the manifest has no keywords");
  // A homepage that does not parse stops the plugin loading at all.
  for (const [field, value] of [["homepage", homepage], ["repository", repository]]) {
    assert.equal(URL.canParse(value), true, `the manifest's ${field} is not a URL: ${value}`);
  }
});

test("the manifest is one any deployment can ship", () => {
  // The same file goes into the zip every deployment offers.
  const text = readFileSync(join(ROOT, "claude-plugin", ".claude-plugin", "plugin.json"), "utf8");
  assert.equal(text.includes("bikeshed.now"), false, "the manifest names one deployment");
  const { name, license } = manifest();
  assert.match(name, /^[a-z0-9-]{1,64}$/);
  assert.equal(license, "Apache-2.0");
});

test("the plugin's icon is one the directory accepts, and the first one submitted is the one it keeps", () => {
  // The directory takes a square PNG or JPEG of 512 to 2048 px, under 2 MB, and
  // adding or changing it after the first submission changes nothing.
  const { icon } = manifest();
  assert.match(icon ?? "", /^\.\//, "a path in a manifest starts with ./");
  const file = readFileSync(join(ROOT, "claude-plugin", icon));
  assert.equal(file.subarray(0, 8).toString("latin1"), "\x89PNG\r\n\x1a\n", "the icon is not a PNG");
  const [width, height] = [file.readUInt32BE(16), file.readUInt32BE(20)];
  assert.equal(width, height, "the icon is not square");
  assert.ok(width >= 512 && width <= 2048, `the icon is ${width} px`);
  assert.ok(file.length < 2 * 1024 * 1024, "the icon is over 2 MB");
});

test("the plugin's source is a directory holding the skills and nothing a host would act on", async () => {
  // Every top-level name there means something to a host: a `bin/` stops
  // claude.ai installing the plugin at all, and `hooks/` or `.mcp.json` would
  // run or connect something. So the list is closed rather than checked for
  // the names known today.
  const { readSkills } = await import("../../tools/build-agents.mjs");
  const { source } = catalogue().plugins[0];
  assert.equal(source, "./claude-plugin", "organization sync takes a relative path only with ./");
  const root = join(ROOT, source);
  assert.deepEqual(listing(root), [".claude-plugin", "README.md", "skills"]);
  assert.deepEqual(listing(root, ".claude-plugin"), ["icon.png", "plugin.json"]);
  const skills = readSkills().map((s) => s.name);
  assert.ok(skills.length > 0, "there are no skills");
  assert.deepEqual(listing(root, "skills"), skills);
  for (const name of skills) {
    assert.deepEqual(listing(root, "skills", name), ["SKILL.md"], `${name} holds something else`);
  }
});

test("the repo root is a marketplace and never itself a plugin", () => {
  // A plugin here would copy the whole repo into every reader's cache.
  assert.deepEqual(listing(ROOT, ".claude-plugin"), ["marketplace.json"]);
  assert.equal(existsSync(join(ROOT, ".claude-plugin", "plugin.json")), false);
});

test("the plugin zip opens in another reader, with its manifest where a host looks for it", async () => {
  // A host refuses an archive without one `.claude-plugin/plugin.json` at its
  // root, and adm-zip is a second implementation, as in the test below.
  const { pluginArchive, servedDocuments, stampDist } = await import("../../tools/stamp-deployment.mjs");
  const { skills } = await documents();
  const base = mkdtempSync(join(tmpdir(), "bikeshed-pluginzip-"));
  const dist = join(base, "dist");
  try {
    for (const rel of servedDocuments()) {
      cpSync(join(ROOT, "app", "public", rel), join(dist, rel));
    }
    stampDist(dist, "https://stamp.example");

    const zip = new AdmZip(join(dist, pluginArchive().path));
    const names = zip.getEntries().map((e) => e.entryName);
    assert.equal(names.filter((n) => n.endsWith("plugin.json")).length, 1, "a host needs exactly one manifest");
    assert.deepEqual(JSON.parse(zip.readAsText(".claude-plugin/plugin.json")), manifest());
    const icon = readFileSync(join(ROOT, "claude-plugin", manifest().icon));
    assert.equal(zip.getEntry(".claude-plugin/icon.png")?.getData().equals(icon), true, "the zip's icon is not the tracked one");
    for (const entry of zip.getEntries()) assert.equal(entry.header.method, 0, "stored, not deflated");
    for (const skill of skills) {
      const held = zip.getEntry(`skills/${skill.name}/SKILL.md`);
      assert.ok(held, `the plugin zip has no ${skill.name}`);
      const served = readFileSync(join(dist, "skills", skill.name, "SKILL.md"));
      assert.equal(held.getData().equals(served), true, `${skill.name} is not the served SKILL.md`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the served index names the plugin zip", async () => {
  const { pluginArchive } = await import("../../tools/stamp-deployment.mjs");
  const index = JSON.parse(readFileSync(join(ROOT, "app", "public", "skills", "index.json"), "utf8"));
  assert.equal(index.plugin, pluginArchive().path);
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
