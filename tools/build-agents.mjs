#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Keep the two generated agent documents in step with their sources (SPEC §19).

/**
 * Usage:
 *   node tools/build-agents.mjs          write both generated files
 *   node tools/build-agents.mjs --check  verify both, exit 1 on drift
 *
 * There are two audiences, and conflating them is how an agent ends up reading
 * the wrong instructions confidently:
 *
 *   CLAUDE.md          → AGENTS.md            for an agent CHANGING THIS SOURCE
 *   docs/agents/agent-guide.md → app/public/llms.txt for an agent USING A DEPLOYMENT
 *   skills/            → app/public/skills/  the long form of the second
 *
 * `AGENTS.md` is the cross-tool convention, so it must exist and must say the
 * same thing as `CLAUDE.md` rather than a stale paraphrase of it. `/llms.txt`
 * is what an agent fetches from a running deployment, so it must say the same
 * thing as the guide in the tree.
 *
 * Both are generated rather than hand-maintained for the same reason the
 * security rules are: two copies of one instruction drift, and the drift is
 * invisible until somebody acts on the wrong one.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A banner is prepended where the generated file has a name somebody would
 * plausibly open and edit. `llms.txt` gets none: it is served verbatim to
 * agents, and a note about this repository's build process is noise to a reader
 * who has never seen the repository.
 */
const PAIRS = [
  {
    source: "CLAUDE.md",
    target: "AGENTS.md",
    banner:
      "<!-- GENERATED from CLAUDE.md by tools/build-agents.mjs — DO NOT EDIT. Edit CLAUDE.md and run `npm run build:agents`.\n\n" +
      "     This file exists because AGENTS.md is the cross-tool convention, and an agent that reads it should get exactly what Claude Code reads, not a paraphrase that fell behind. -->\n\n",
  },
  {
    source: "docs/agents/agent-guide.md",
    target: "app/public/llms.txt",
    banner: "",
  },
];

/**
 * The skills, and the index that lets a client discover them.
 *
 * Generated for the same reason the two documents above are: the copy a
 * deployment serves has to be the copy in the tree, and "remember to update the
 * other one" is not a mechanism. The index is generated from the frontmatter
 * rather than hand-written, so a skill cannot be added without becoming
 * discoverable, or removed without disappearing.
 */
const SKILLS_DIR = join(ROOT, "skills");
const SKILLS_OUT = join(ROOT, "app", "public", "skills");

/** The `name:` and `description:` of a SKILL.md, from its YAML frontmatter. */
export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    // Deliberately not a YAML parser: the frontmatter here is two scalar keys,
    // and a dependency to read two scalar keys is not a trade worth making.
    // Anything more elaborate is rejected by the skills test rather than
    // silently half-read.
    const pair = /^([a-z]+):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

/** Every skill in the tree, in a stable order, with its text. */
export function readSkills() {
  let names = [];
  try {
    names = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const text = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
    const fields = frontmatter(text) ?? {};
    return {
      name,
      description: fields.description ?? "",
      declaredName: fields.name ?? "",
      path: `skills/${name}/SKILL.md`,
      // Packed into app/dist by tools/stamp-deployment.mjs from the stamped
      // SKILL.md, for Claude's skill upload. Not in app/public, so not written
      // here: a zip of the unstamped text would be the wrong download.
      archive: `skills/${name}.zip`,
      text,
    };
  });
}

/**
 * The discovery document, formatted exactly as it is written and compared.
 *
 * `archive` is additive: `bikeshed skills install` reads only `path`.
 */
function skillIndex(skills) {
  return `${JSON.stringify(
    {
      skills: skills.map(({ name, description, path, archive }) => ({
        name,
        description,
        path,
        archive,
      })),
    },
    null,
    2,
  )}\n`;
}

/**
 * Everything below runs only when this file is a COMMAND.
 *
 * `functions/test/skills.test.js` imports `readSkills` to check the skills
 * against the surface they describe, and an import that writes files — or exits
 * the process on drift — would turn that test into a build step with a hidden
 * side effect.
 */
const RUN_DIRECTLY = process.argv[1] === fileURLToPath(import.meta.url);

function run() {
  const check = process.argv.includes("--check");
  let drifted = 0;

  for (const { source, target, banner } of PAIRS) {
    const expected = banner + readFileSync(join(ROOT, source), "utf8");

    if (!check) {
      writeFileSync(join(ROOT, target), expected);
      console.log(`wrote ${target} from ${source}`);
      continue;
    }

    let current = null;
    try {
      current = readFileSync(join(ROOT, target), "utf8");
    } catch {
      /* missing counts as drift */
    }
    if (current !== expected) {
      console.error(`${target} does not match ${source}.`);
      drifted += 1;
    }
  }

  const skills = readSkills();
  const skillFiles = [
    ["index.json", skillIndex(skills)],
    ...skills.map((s) => [join(s.name, "SKILL.md"), s.text]),
  ];

  for (const [rel, expected] of skillFiles) {
    const target = join(SKILLS_OUT, rel);
    if (!check) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, expected);
      console.log(`wrote app/public/skills/${rel}`);
      continue;
    }
    let current = null;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      /* missing counts as drift */
    }
    if (current !== expected) {
      console.error(`app/public/skills/${rel} does not match skills/${rel}.`);
      drifted += 1;
    }
  }

  /**
   * A skill deleted from the tree has to disappear from the deployment too.
   * Writing the files that should exist would otherwise leave the old one being
   * served forever, still listed by nothing and still installed by anyone who
   * knew its URL.
   */
  if (check) {
    let served = [];
    try {
      served = readdirSync(SKILLS_OUT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      /* nothing served yet */
    }
    const known = new Set(skills.map((s) => s.name));
    for (const name of served) {
      if (!known.has(name)) {
        console.error(`app/public/skills/${name} is served but no longer in skills/.`);
        drifted += 1;
      }
    }
  }

  if (check) {
    if (drifted > 0) {
      console.error("\nrun `npm run build:agents` and commit the result.");
      process.exit(1);
    }
    console.log("agent instructions: in sync");
  }
}

if (RUN_DIRECTLY) run();
