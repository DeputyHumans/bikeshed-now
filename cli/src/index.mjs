#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `bikeshed` — publish and revise documents from the terminal (SPEC §19).

import { parseArgs } from "node:util";
import { readFileSync, watch } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { CONFIG_PATH, readConfig, resolveAuth, writeConfig } from "./config.mjs";
import { CliError, callTool, uploadFile, whoami } from "./client.mjs";

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

Options
  --json                 machine-readable output
  --title <text>         title for publish
  --folder <id>          destination folder for publish
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
  const result = await callTool(origin, token, "list_documents", {
    limit: Number(flags.limit) || 20,
  });
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
  const { origin, token } = resolveAuth(flags);
  const file = resolve(path);

  const once = async () => {
    const result = await uploadFile(origin, token, file, {
      title: flags.title,
      folder: flags.folder,
    });
    out(flags.json, result, () =>
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

async function update(flags, [id, path]) {
  if (!id || !path) fail("usage: bikeshed update <id> <file>");
  const { origin, token } = resolveAuth(flags);
  const file = resolve(path);

  const once = async () => {
    const content = readFileSync(file, "utf8");
    const result = await callTool(origin, token, "update_document", { id, content });
    out(flags.json, result, () =>
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

async function get(flags, [id]) {
  if (!id) fail("usage: bikeshed get <id>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "get_document", { id });
  out(flags.json, result, () => process.stdout.write(result.source));
}

async function comments(flags, [id]) {
  if (!id) fail("usage: bikeshed comments <id>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "get_comments", {
    id,
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

async function reply(flags, [id, threadId, ...rest]) {
  const body = rest.join(" ");
  if (!id || !threadId || !body) fail("usage: bikeshed reply <id> <thread> <text>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "reply_to_comment", { id, threadId, body });
  out(flags.json, result, () => console.log(`replied in ${threadId}`));
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

const COMMANDS = { login, list, publish, update, get, comments, reply, open };

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
      folder: { type: "string" },
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
  if (!token && name !== "login" && name !== "open") {
    fail("no token. Run `bikeshed login`, or set BIKESHED_TOKEN.");
  }

  await command(values, rest);
}

main().catch((e) => {
  if (e instanceof CliError) fail(e.message);
  fail(e?.message ?? String(e));
});
