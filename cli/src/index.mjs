#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `bikeshed` — publish and revise documents from the terminal (SPEC §19).

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { CONFIG_PATH, readConfig, resolveAuth, writeConfig } from "./config.mjs";
import { CliError, callTool, fetchSkill, listSkills, uploadFile, whoami } from "./client.mjs";

/**
 * This is the END-USER tool, and it is deliberately not the same thing as the
 * scripts in `scripts/`. Conflating the two is how somebody runs a teardown
 * against production, so the difference is stated in `--help`, in the README,
 * and here:
 *
 *   scripts/*.mjs   whoever owns the deployment. Admin credentials. Talks to
 *                   Firestore and Storage directly. Provisions and withdraws.
 *   bikeshed        any signed-up user. A personal access token. Talks to the
 *                   deployment over HTTPS. Publishes and revises documents.
 *
 * Every command takes `--json`, so it composes inside a script or an agent's
 * shell without anybody parsing human-readable output.
 */

const USAGE = `bikeshed — publish and revise documents

  bikeshed login                       store a personal access token
  bikeshed list                        documents you can read
  bikeshed publish <file>              create a new document
  bikeshed update <id> <file>          publish a new version
  bikeshed get <id>                    print a document's source
  bikeshed comments <id>               unresolved feedback, with its anchored text
  bikeshed reply <id> <thread> <text>  reply in a thread
  bikeshed open <id>                   open it in a browser

  Where a command takes <id> it also takes the link you were sent. An unlisted
  document you are not a member of needs the link: its key is in it.

Organising
  bikeshed folders                     the folder tree, with ids
  bikeshed mkdir <name> [--parent <id>]  create a folder
  bikeshed mv <id> <folder|root>       move a document

Skills
  bikeshed skills                      skills this deployment publishes
  bikeshed skills install <dir>        write them into an agent's skills directory
                                       (Claude Code: ~/.claude/skills)

What you can publish
  .md .markdown          rendered to HTML on the server; get returns the Markdown
  .html .htm             stored as written
  .zip                   several files, index.html or index.md at the root
  Up to 25 MB. An update keeps the format: a .zip replaces every file, one .md
  or .html replaces the entry and keeps the files beside it.
  Scripts run once a person trusts the document in the app: its owner for
  everyone, any reader for themselves. Each update sandboxes it again. Images,
  stylesheets and fonts from other sites load either way. Markdown is
  CommonMark with tables, strikethrough and task lists: Mermaid, math,
  footnotes and front matter show as typed. The deployment's /llms.txt has the
  full list.

Options
  --json                 machine-readable output
  --title <text>         title for publish
  --id <id>              with publish: the address, /d/<id> (default: from the title)
  --folder <id>          destination folder for publish
  --parent <id>          parent folder for mkdir
  --limit <n>            with list: rows per page (default 20, max 50)
  --cursor <id>          with list: the page after the one that printed it
  --all                  with list: every page; with comments: resolved too
  --watch                with publish/update: republish on every save
  --origin <url>         the deployment (default: the one you logged in to)
  --token <token>        override the stored token
  --help                 this

Environment
  BIKESHED_ORIGIN, BIKESHED_TOKEN, BIKESHED_AGENT

This is the end-user tool. The scripts in scripts/ are the OPERATOR tools: they
use admin credentials, talk to the database directly, and can tear a deployment
down. They are not the same thing.
`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function out(json, value, human) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  human();
}

/**
 * A document as a person holds it: its id, or the link they were sent. The link
 * is the only place an unlisted document's key exists, so a pasted one is read
 * for both — `…/d/<id>[/<version>]?k=<key>` — and the key goes along as the
 * tools' `k` argument (SPEC §17).
 */
function docArgs(ref) {
  if (!/^https?:\/\//i.test(ref)) return { id: ref };
  let url;
  try {
    url = new URL(ref);
  } catch {
    fail(`not a document link: ${ref}`);
  }
  const match = url.pathname.match(/^\/d\/([^/]+)(?:\/[^/]+)?\/?$/);
  if (!match) fail(`not a document link: ${ref}`);
  const k = url.searchParams.get("k");
  return { id: decodeURIComponent(match[1]), ...(k ? { k } : {}) };
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** A .zip by name, or by the bytes the deployment itself sniffs for. */
function isArchive(path, bytes) {
  return /\.zip$/i.test(path) || bytes.subarray(0, 4).equals(ZIP_MAGIC);
}

// --- Commands --------------------------------------------------------------

async function login(flags) {
  const { origin } = resolveAuth(flags);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const where =
      flags.origin ||
      (await rl.question(`Deployment [${origin}]: `)).trim() ||
      origin;
    console.log(`\nCreate a token at ${where}/account — choose "Command line".`);
    console.log("It is shown once, so copy it now.\n");
    const token = (await rl.question("Token: ")).trim();
    if (!token) fail("no token given");

    // Verified before it is stored, so a typo fails here rather than on the
    // next command with a confusing message.
    await whoami(where, token);
    writeConfig({ ...readConfig(), origin: where, token });
    console.log(`\nSaved to ${CONFIG_PATH} (readable only by you).`);
  } finally {
    rl.close();
  }
}

async function list(flags) {
  const { origin, token } = resolveAuth(flags);
  const page = (limit, cursor) => {
    const args = { limit };
    if (cursor) args.cursor = cursor;
    return callTool(origin, token, "list_documents", args);
  };

  let result;
  if (flags.all) {
    // Pages at the server's cap (LIST_LIMIT), which is the fewest round trips.
    // The result keeps one page's shape, so `--json` needs no second parser.
    const documents = [];
    let cursor = flags.cursor;
    do {
      const next = await page(50, cursor);
      documents.push(...next.documents);
      cursor = next.nextCursor;
    } while (cursor);
    result = { documents, nextCursor: null };
  } else {
    result = await page(Number(flags.limit) || 20, flags.cursor);
  }

  out(flags.json, result, () => {
    if (result.documents.length === 0) {
      console.log("Nothing yet. `bikeshed publish <file>` to start.");
      return;
    }
    for (const doc of result.documents) {
      const marker = doc.visibility === "private" ? " " : doc.visibility === "public" ? "◉" : "◐";
      console.log(`${marker} ${doc.id.padEnd(34)} ${doc.version.padEnd(5)} ${doc.title}`);
    }
    if (result.nextCursor) console.log(`\n… more: --cursor ${result.nextCursor}`);
  });
}

async function publish(flags, [path]) {
  if (!path) fail("usage: bikeshed publish <file>");
  if (flags.id === true) fail("usage: bikeshed publish <file> --id <id>");
  const { origin, token } = resolveAuth(flags);
  const file = resolve(path);

  const once = async () => {
    const result = await uploadFile(origin, token, file, {
      title: flags.title,
      folder: flags.folder,
      id: flags.id,
    });
    // A taken id still publishes, under a suffix. Said on stderr so `--json`
    // stays parseable; "not available" also covers a deployment too old to
    // know the parameter, which ignores it.
    if (flags.id && result.docId !== flags.id) {
      console.error(`${flags.id} was not available; published at ${result.docId}`);
    }
    // The address is in the human line already; `--json` carried only the id, so
    // anything reading it had to know how to build a URL out of a docId.
    out(flags.json, { ...result, url: result.url ?? `${origin}/d/${result.docId}` }, () =>
      console.log(`published ${result.docId} ${result.versionId} — ${origin}/d/${result.docId}`),
    );
    return result;
  };

  const first = await once();
  if (flags.watch) {
    // Watch republishes as UPDATES after the first, or every save would create
    // another document.
    await watchFile(file, () =>
      update({ ...flags, watch: false }, [first.docId, file]),
    );
  }
}

async function update(flags, [ref, path]) {
  if (!ref || !path) fail("usage: bikeshed update <id> <file>");
  const { origin, token } = resolveAuth(flags);
  const file = resolve(path);
  const doc = docArgs(ref);
  const { id } = doc;

  const once = async () => {
    const bytes = readFileSync(file);
    // An archive goes up as bytes, to the one endpoint that takes them. Read as
    // text, every byte above 0x7f in it would become U+FFFD on the way.
    const result = isArchive(file, bytes)
      ? await uploadFile(origin, token, file, { update: id, k: doc.k })
      : await callTool(origin, token, "update_document", { ...doc, content: bytes.toString("utf8") });
    out(flags.json, { ...result, url: result.url ?? `${origin}/d/${id}` }, () =>
      console.log(
        result.deduped
          ? `no change — identical to ${result.versionId}`
          : `published ${result.versionId} (${result.fileCount} file(s), ${result.bytes} bytes)`,
      ),
    );
    return result;
  };

  await once();
  if (flags.watch) await watchFile(file, once);
}

async function get(flags, [ref]) {
  if (!ref) fail("usage: bikeshed get <id>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "get_document", docArgs(ref));
  out(flags.json, result, () => process.stdout.write(result.source));
}

async function comments(flags, [ref]) {
  if (!ref) fail("usage: bikeshed comments <id>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "get_comments", {
    ...docArgs(ref),
    includeResolved: Boolean(flags.all),
  });
  out(flags.json, result, () => {
    if (result.threads.length === 0) {
      console.log("No open comments.");
      return;
    }
    for (const thread of result.threads) {
      // The QUOTE first, because it is what makes a comment actionable: it says
      // which passage to change without opening the document.
      console.log(`\n── ${thread.threadId}${thread.section ? `  (${thread.section})` : ""}`);
      if (thread.quote) console.log(`   “${thread.quote}”`);
      for (const comment of thread.comments) {
        const via = comment.via && comment.via !== "web" ? ` [via ${comment.via}]` : "";
        console.log(`   ${comment.author}${via}: ${comment.body}`);
      }
    }
    console.log("");
  });
}

async function reply(flags, [ref, threadId, ...rest]) {
  const body = rest.join(" ");
  if (!ref || !threadId || !body) fail("usage: bikeshed reply <id> <thread> <text>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "reply_to_comment", {
    ...docArgs(ref),
    threadId,
    body,
  });
  out(flags.json, result, () => console.log(`replied in ${threadId}`));
}

async function folders(flags) {
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "list_folders", {});
  out(flags.json, result, () => {
    if (result.folders.length === 0) {
      console.log("No folders. `bikeshed mkdir <name>` to make one.");
      return;
    }
    for (const folder of result.folders) {
      // Indentation comes from the PATH, not from walking parents: a folder
      // whose parent is not shared with you still sits at its real depth, and
      // its path already says so with an ellipsis for the level you cannot see.
      const depth = folder.path.split("/").length - 1;
      const label = `${"  ".repeat(depth)}${folder.name}`;
      const note = folder.canWrite ? "" : "  (read-only)";
      console.log(`${label.padEnd(40)} ${folder.id}${note}`);
    }
    if (result.truncated) {
      console.log("\nThere are more folders than this listing shows.");
    }
  });
}

async function mkdir(flags, rest) {
  const name = rest.join(" ");
  if (!name) fail("usage: bikeshed mkdir <name> [--parent <id>]");
  const { origin, token } = resolveAuth(flags);
  const args = { name };
  if (flags.parent) args.parent = flags.parent;
  const result = await callTool(origin, token, "create_folder", args);
  out(flags.json, result, () => console.log(`${result.name}  ${result.folderId}`));
}

async function mv(flags, [id, dest]) {
  /**
   * The destination is REQUIRED, and the workspace root has to be spelled.
   *
   * On the MCP side an omitted `folder` means the root, because the protocol
   * has no way to send an empty one. A positional argument does: leaving it off
   * is something a person does by accident, and "bikeshed mv report" silently
   * pulling a document out of the folder it was filed in is not a mistake the
   * interface should make easy.
   */
  if (!id || !dest) fail("usage: bikeshed mv <id> <folder|root>");
  const { origin, token } = resolveAuth(flags);
  const args = dest === "root" ? { id } : { id, folder: dest };
  const result = await callTool(origin, token, "move_document", args);
  out(flags.json, result, () =>
    console.log(result.folder ? `moved ${id} into ${result.folder}` : `moved ${id} to the root`),
  );
}

/**
 * Skills are instructions, not code, and they are fetched from the DEPLOYMENT
 * rather than bundled with this CLI on purpose: a deployment running an older
 * version should hand out the skills that describe what it can actually do.
 *
 * No token is needed — they are public static files, the same ones `/llms.txt`
 * points at.
 */
async function skillsCommand(flags, [sub, dir]) {
  const { origin } = resolveAuth(flags);
  const index = await listSkills(origin);

  if (!sub) {
    out(flags.json, index, () => {
      for (const skill of index.skills) {
        console.log(`${skill.name}\n  ${skill.description}\n`);
      }
      console.log(`bikeshed skills install <dir>   — Claude Code: ~/.claude/skills`);
    });
    return;
  }
  if (sub !== "install") fail("usage: bikeshed skills [install <dir>]");
  if (!dir) fail("usage: bikeshed skills install <dir>");

  const root = resolve(dir);
  const written = [];
  for (const skill of index.skills) {
    // The name decides a path on this machine, so it is validated here rather
    // than trusted from the response. A deployment is not an adversary, but a
    // name is still the wrong place to find out it could have been one.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.name)) {
      fail(`refusing a skill with an unusable name: ${skill.name}`);
    }
    const body = await fetchSkill(origin, skill);
    const target = join(root, skill.name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), body);
    written.push(join(skill.name, "SKILL.md"));
  }
  out(flags.json, { installed: written, into: root }, () => {
    for (const file of written) console.log(`${root}/${file}`);
  });
}

async function open(flags, [id]) {
  if (!id) fail("usage: bikeshed open <id>");
  const { origin } = resolveAuth(flags);
  const url = `${origin}/d/${id}`;
  const { spawn } = await import("node:child_process");
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
  console.log(url);
}

/**
 * Re-run on every save, debounced.
 *
 * Editors write in bursts — a truncate, then a write, sometimes a rename — so a
 * naive watcher fires three times per save and publishes twice more than it
 * should. The content hash would make the extra calls no-ops, but they would
 * still be three round trips per keystroke-pause.
 */
async function watchFile(file, run) {
  console.log(`watching ${basename(file)} — ctrl-C to stop`);
  let timer = null;
  watch(file, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      run().catch((e) => console.error(`error: ${e.message}`));
    }, 250);
  });
  await new Promise(() => {}); // until interrupted
}

// --- Entry point -----------------------------------------------------------

const COMMANDS = {
  login,
  list,
  publish,
  update,
  get,
  comments,
  reply,
  open,
  folders,
  mkdir,
  mv,
  skills: skillsCommand,
};

/** Commands that reach a deployment without authenticating as anybody. */
const NO_TOKEN = new Set(["login", "open", "skills"]);

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      title: { type: "string" },
      id: { type: "string" },
      folder: { type: "string" },
      parent: { type: "string" },
      origin: { type: "string" },
      token: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
    },
  });

  const [name, ...rest] = positionals;
  if (values.help || !name) {
    console.log(USAGE);
    return;
  }

  const command = COMMANDS[name];
  if (!command) fail(`unknown command: ${name}\n\n${USAGE}`);

  const { token } = resolveAuth(values);
  if (!token && !NO_TOKEN.has(name)) {
    fail("no token. Run `bikeshed login`, or set BIKESHED_TOKEN.");
  }

  await command(values, rest);
}

main().catch((e) => {
  if (e instanceof CliError) fail(e.message);
  fail(e?.message ?? String(e));
});
