#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `bikeshed` — publish and revise documents from the terminal (SPEC §19).

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { CONFIG_PATH, readConfig, resolveAuth, writeConfig } from "./config.mjs";
import {
  CliError,
  VERSION,
  callTool,
  exchangeCode,
  fetchSkill,
  fetchSource,
  listSkills,
  printable,
  revokeOwnToken,
  uploadFile,
  whoami,
} from "./client.mjs";
import {
  CLI_CLIENT_ID,
  LOGIN_TIMEOUT_MS,
  authorizeUrl,
  canOpenBrowser,
  createPkce,
  createState,
  deviceName,
  discover,
  listenForCallback,
  openBrowser,
} from "./login.mjs";

/**
 * A person's own client: their personal access token, over HTTPS, able to do
 * exactly what they can do in the browser and nothing more.
 *
 * Every command takes `--json`, so it composes inside a script or an agent's
 * shell without anybody parsing human-readable output.
 */

const USAGE = `bikeshed ${VERSION} — publish and revise documents

  bikeshed login                       sign in through your browser (--paste for a token)
  bikeshed logout                      sign out (revokes a token from browser sign-in)
  bikeshed list                        documents you can read
  bikeshed publish <file>              create a new document
  bikeshed update <id> <file>          publish a new version
  bikeshed fork <id>                   your own copy, which remembers its original
  bikeshed lineage <id>                what it was forked from; for its owner, its forks
  bikeshed get <id>                    print a document's source
  bikeshed comments <id>               unresolved feedback, with its anchored text
                                       (--version <v> for an earlier version's)
  bikeshed changes <id> --since <cursor|last|all>
                                       what happened since a cursor; --wait to
                                       keep checking until something does
  bikeshed comment <id> <text> --body <comment>
                                       start a thread on a passage
  bikeshed reply <id> <thread> <text>  reply in a thread
  bikeshed resolve <id> <thread>       close a thread once its point is dealt with
  bikeshed reopen <id> <thread>        open a resolved thread again
  bikeshed suggest <id> <text> --with <new text>
                                       propose new text for a passage, for a
                                       person to accept or reject (--delete to
                                       propose removing it)
  bikeshed revise <id> <thread> --with <new text>
                                       change your suggestion before it is
                                       decided; what it said before is kept
  bikeshed withdraw <id> <thread>      take back your suggestion before it is
                                       decided; its thread stays
  bikeshed accept <id> <thread>        accept a suggestion, as its owner or an
                                       approver: the change goes into the draft
  bikeshed reject <id> <thread>        decline a suggestion, as its owner or an
                                       approver (--reason <why>)
  bikeshed commit <id>                 publish the draft as the next version
  bikeshed open <id>                   open it in a browser

  Where a command takes <id> it also takes the link you were sent. An unlisted
  document you are not a member of needs the link: its key is in it.

Organising
  bikeshed folders                     the folder tree, with ids and readers
  bikeshed folder <id>                 who can read a folder, and so what is in it
  bikeshed mkdir <name> [--parent <id>]  create a folder
  bikeshed mv <id> <folder|root>       move a document
  bikeshed rename <id> <title>         change a document's title; its address stays

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
  --title <text>         title for publish or fork (fork default: the original's)
  --id <id>              with publish: the address, /d/<id> (default: from the title)
  --folder <id>          destination folder for publish or fork
  --version <v>          with fork: the version to copy; with comments: the
                         version to read (default: current); on its own,
                         which version of bikeshed this is
  --parent <id>          parent folder for mkdir
  --limit <n>            with list: rows per page (default 20, max 50)
  --cursor <id>          with list: the page after the one that printed it
  --since <cursor>       with changes: a cursor publish, fork, get --json or
                         changes printed; "last" where this sign-in left off;
                         or "all"
  --wait                 with changes: keep checking until something happens
  --interval <s>         with changes --wait: seconds between checks (default
                         60, at least 30)
  --timeout <s>          with changes --wait: give up after this long (default
                         3600), exit 3, and print the cursor to resume from
  --base <v>             with update: the version you revised; refused if
                         somebody has published since
  --all                  with list: every page; with comments: resolved too
  --with <text>          with suggest or revise: what the passage should say instead
  --delete               with suggest or revise: propose deleting the passage
  --note <text>          with suggest or revise: why, for whoever decides
  --reason <text>        with reject: why, for the suggestion's author
  --prefix <text>        with suggest: words just before a passage that repeats
  --suffix <text>        with suggest: words just after it
  --watch                with publish/update: republish on every save
  --paste                with login: paste a token made at /account instead
  --no-browser           with login: print the sign-in link without opening it
  --origin <url>         the deployment (default: the one you logged in to)
  --token <token>        override the stored token
  --help                 this

Environment
  BIKESHED_ORIGIN, BIKESHED_TOKEN, BIKESHED_AGENT
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

/**
 * Sign in. Through the browser by default, by pasting a token with --paste.
 *
 * The browser flow needs no terminal on stdin, on purpose: an agent's shell
 * has none, and an agent running `npx -y bikeshed-now login` on a person's
 * behalf is the case it exists for. The person approves in their own browser;
 * the agent never sees the token, and neither does anybody reading its
 * output. So the address goes to stderr, stdout stays parseable for --json,
 * and the token is never printed.
 */
async function login(flags) {
  if (flags.paste) return pasteLogin(flags);
  // A job runner has no browser and no person to approve. Waiting five minutes
  // to say so would be the slowest possible way to fail.
  if (isCi(process.env.CI) && !flags["no-browser"]) {
    fail("In CI, set BIKESHED_TOKEN and BIKESHED_ORIGIN.");
  }
  return browserLogin(flags);
}

function isCi(value) {
  return Boolean(value) && value !== "0" && value.toLowerCase() !== "false";
}

async function browserLogin(flags) {
  const interactive = Boolean(process.stdin.isTTY);
  // Never asked: --origin, BIKESHED_ORIGIN, the last sign-in, then the default,
  // the same order as every other command. The line below names it.
  let where = resolveAuth(flags).origin;
  try {
    const url = new URL(where);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    where = url.origin;
  } catch {
    fail(`not a deployment address: ${where} (try https://bikeshed.now)`);
  }

  const meta = await discover(where);
  if (!meta) {
    // A deployment from before browser sign-in. A person at a terminal can
    // still paste; anything else is told how, rather than left at a prompt
    // nobody will answer.
    if (interactive) {
      console.error(`${where} predates browser sign-in, so this will ask for a token instead.\n`);
      return pasteLogin({ ...flags, origin: where });
    }
    fail(`${where} predates browser sign-in. Create a token at ${where}/account and run \`bikeshed login --paste\`.`);
  }

  const { verifier, challenge } = createPkce();
  const state = createState();
  const timeoutMs = Number(process.env.BIKESHED_LOGIN_TIMEOUT_MS) || LOGIN_TIMEOUT_MS;
  const callback = await listenForCallback({ state, issuer: meta.issuer, timeoutMs });
  const resource = `${where}/mcp`;
  const url = authorizeUrl(meta.authorization_endpoint, {
    clientId: CLI_CLIENT_ID,
    redirectUri: callback.redirectUri,
    challenge,
    state,
    resource,
    device: deviceName(),
  });

  const onInterrupt = () => {
    callback.close();
    console.error("\nCancelled. Nothing was saved.");
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);

  let answer;
  try {
    const here = canOpenBrowser();
    const opening = !flags["no-browser"] && here && openBrowser(url);
    console.error(
      opening
        ? `Opening your browser to sign in to ${where}. If it does not open, visit:`
        : `To sign in to ${where}, open this in your browser:`,
    );
    console.error(`\n  ${url}\n`);
    if (!flags["no-browser"] && !here) {
      // The redirect comes back to 127.0.0.1 on THIS machine, which a browser
      // on another one cannot reach.
      console.error("If your browser is on another computer, it cannot reach back here: use `bikeshed login --paste` instead.");
    }
    console.error("Waiting for you to approve… (Ctrl-C to cancel)");
    answer = await callback.result;
  } finally {
    process.off("SIGINT", onInterrupt);
  }

  if (answer.error) {
    if (answer.error === "access_denied") fail("You chose not to connect. Nothing was saved.");
    fail(`Sign-in did not finish: ${printable(answer.description ?? answer.error)}. Nothing was saved.`);
  }

  const token = await exchangeCode(meta.token_endpoint, {
    code: answer.code,
    verifier,
    redirectUri: callback.redirectUri,
    clientId: CLI_CLIENT_ID,
    resource,
  });
  // Checked before it is stored, the same as a pasted one.
  await whoami(where, token);
  // `via` is what lets `logout` revoke this token: one made by browser sign-in
  // belongs to this computer alone, where a pasted one may be in CI as well.
  writeConfig({ ...readConfig(), origin: where, token, via: "browser" });

  // The environment outranks the file (resolveAuth), so a variable left over
  // from an earlier session would quietly keep being used instead.
  // A BIKESHED_ORIGIN naming this same deployment changes nothing.
  const shadowing = [];
  if (process.env.BIKESHED_TOKEN) shadowing.push("BIKESHED_TOKEN");
  if (process.env.BIKESHED_ORIGIN && process.env.BIKESHED_ORIGIN.replace(/\/+$/, "") !== where) {
    shadowing.push("BIKESHED_ORIGIN");
  }
  if (shadowing.length === 1) {
    console.error(`${shadowing[0]} is set in this shell, and it outranks what was just saved. Unset it to use this sign-in.`);
  } else if (shadowing.length === 2) {
    console.error("BIKESHED_TOKEN and BIKESHED_ORIGIN are set in this shell, and they outrank what was just saved. Unset them to use this sign-in.");
  }

  out(flags.json, { origin: where, saved: CONFIG_PATH, via: "browser" }, () =>
    console.log(`Signed in to ${where}. Saved to ${CONFIG_PATH} (readable only by you).`),
  );
}

/**
 * Paste a token made at /account. The flow from before browser sign-in.
 *
 * Only the token is read from stdin. Asking for the deployment first read a
 * piped token as the address, and printed it back inside the /account link.
 */
async function pasteLogin(flags) {
  const { origin: where } = resolveAuth(flags);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`Create a token at ${where}/account — choose "Command line".`);
    console.log("It is shown once, so copy it now.\n");
    const token = (await rl.question("Token: ")).trim();
    if (!token) fail("no token given");

    // Verified before it is stored, so a typo fails here rather than on the
    // next command with a confusing message.
    await whoami(where, token);
    writeConfig({ ...readConfig(), origin: where, token, via: "paste" });
    console.log(`\nSaved to ${CONFIG_PATH} (readable only by you).`);
  } finally {
    rl.close();
  }
}

/**
 * Sign this computer out.
 *
 * Only the SAVED sign-in, never BIKESHED_TOKEN or --token: those belong to a
 * shell or a job, and revoking one would sign out something nobody meant to
 * touch. A token from browser sign-in exists for this computer alone, so it is
 * revoked on the deployment as well as forgotten here. A pasted one may be in
 * CI too, so it is only forgotten, as is one saved before `login` recorded
 * which kind it was (SPEC §23).
 *
 * The token is forgotten whatever the deployment says, and when it cannot be
 * reached at all: after `logout`, this computer is signed out. `revoked` in
 * --json means the deployment confirmed the token no longer works.
 */
async function logout(flags) {
  const config = readConfig();
  const origin = String(config.origin || resolveAuth().origin).replace(/\/+$/, "");
  const shadowed = () => {
    if (process.env.BIKESHED_TOKEN) {
      console.error("BIKESHED_TOKEN is set in this shell, so commands here still use it. Unset it to sign out here too.");
    }
  };

  if (!config.token) {
    out(flags.json, { origin, revoked: false, forgot: false }, () => console.log("Not signed in on this computer."));
    shadowed();
    return;
  }

  let outcome = "kept";
  let why = "You pasted it in, so something else may use it too.";
  if (config.via === "browser") {
    try {
      outcome = await revokeOwnToken(origin, config.token);
      why = `${origin} is too old to revoke a token from the command line.`;
    } catch (e) {
      outcome = "failed";
      why =
        e instanceof CliError
          ? `${origin} did not revoke it (${printable(e.message, 80)}).`
          : `Could not reach ${origin} to revoke it (${printable(e.cause?.code ?? e.message, 80)}).`;
    }
  }

  const kept = { ...config, origin };
  delete kept.token;
  delete kept.via;
  writeConfig(kept);

  const revoked = outcome === "revoked" || outcome === "invalid";
  out(flags.json, { origin, revoked, forgot: true }, () =>
    console.log(
      outcome === "revoked"
        ? `Signed out. ${origin} revoked the token, and it is gone from this computer.`
        : outcome === "invalid"
          ? `Signed out. The token had already stopped working on ${origin}, and it is gone from this computer.`
          : "Signed out. The token is gone from this computer.",
    ),
  );
  if (!revoked) {
    console.error(`${why} It still works until you revoke it at ${origin}/account, under Access tokens.`);
  }
  shadowed();
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
      // ⑂ marks a fork; where it came from is `bikeshed lineage`'s to say.
      console.log(`${marker} ${doc.id.padEnd(34)} ${doc.version.padEnd(5)} ${doc.title}${doc.forked ? "  ⑂" : ""}`);
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
    out(flags.json, { ...result, url: result.url ?? `${origin}/d/${result.docId}` }, () => {
      console.log(`published ${result.docId} ${result.versionId} — ${origin}/d/${result.docId}`);
      const where = describeAccess(result);
      if (where) console.log(where);
    });
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
    // --base: the version this was revised from, so an update over somebody's
    // newer save is refused instead of replacing it (SPEC §19).
    const base = typeof flags.base === "string" && flags.base ? flags.base : undefined;
    const result = isArchive(file, bytes)
      ? await uploadFile(origin, token, file, { update: id, k: doc.k, base })
      : await callTool(origin, token, "update_document", {
          ...doc,
          content: bytes.toString("utf8"),
          ...(base ? { baseVersion: base } : {}),
        });
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
  const doc = docArgs(ref);
  const result = await callTool(origin, token, "get_document", doc);
  // The tool cuts a long source at a fixed length. Printed as it came, the cut
  // copy exited 0 and looked complete, and `update` with an edit of it
  // published a version missing everything past the cut. So a cut source is
  // read whole, or nothing is printed.
  const whole = result.truncated
    ? await fetchSource(origin, token, {
        id: doc.id,
        version: result.version,
        sourceFile: result.sourceFile,
        k: doc.k,
      })
    : null;
  out(
    flags.json,
    whole ? { ...result, truncated: false, source: whole.toString("utf8") } : result,
    () => process.stdout.write(whole ?? result.source),
  );
}

async function comments(flags, [ref]) {
  if (!ref) fail("usage: bikeshed comments <id>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "get_comments", {
    ...docArgs(ref),
    // Threads belong to the version they were opened on; a version in a link
    // is not taken as a request for one, only the flag is.
    ...(typeof flags.version === "string" ? { version: flags.version } : {}),
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
      // A suggested edit says what the passage would become, whether it is
      // still open, and what its author proposed before changing it (SPEC §22).
      if (thread.suggestion) {
        const said = (text) => (text === "" ? "(delete it)" : `“${text}”`);
        console.log(`   → ${said(thread.suggestion.replacement)}  [${thread.suggestion.state}]`);
        for (const earlier of thread.suggestion.revisions ?? []) {
          console.log(`     was ${said(earlier.replacement)}${earlier.note ? `  (${earlier.note})` : ""}`);
        }
      }
      for (const comment of thread.comments) {
        const via = comment.via && comment.via !== "web" ? ` [via ${comment.via}]` : "";
        console.log(`   ${comment.author}${via}: ${comment.body}`);
      }
    }
    console.log("");
  });
}

/**
 * Start a thread on one passage of a document's current version. The passage
 * is quoted as a reader sees it, as with `suggest`; what to say about it is a
 * named flag, so the two pieces of free text never run together.
 */
async function comment(flags, [ref, ...rest]) {
  const exact = rest.join(" ");
  const usage = "usage: bikeshed comment <id> <text> --body <comment> [--prefix …] [--suffix …]";
  if (!ref || !exact) fail(usage);
  // An empty --body is what an unset shell variable sends; a thread that says
  // nothing is a highlight somebody has to resolve for no reason.
  if (typeof flags.body !== "string" || !flags.body.trim()) fail(usage);
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "add_comment", {
    ...docArgs(ref),
    exact,
    body: flags.body,
    ...(typeof flags.prefix === "string" ? { prefix: flags.prefix } : {}),
    ...(typeof flags.suffix === "string" ? { suffix: flags.suffix } : {}),
  });
  out(flags.json, result, () => console.log(`opened ${result.threadId}`));
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

/**
 * Close a thread on the current version, or open it again. Either leaves a
 * note in the thread saying who did it and through what, which is how the
 * person who raised the point hears (SPEC §19).
 */
// `resolve` alone is node:path's, imported above.
async function resolveThread(flags, args) {
  await setResolved(flags, args, "resolve");
}

async function reopenThread(flags, args) {
  await setResolved(flags, args, "reopen");
}

async function setResolved(flags, [ref, threadId, ...rest], verb) {
  if (!ref || !threadId || rest.length) fail(`usage: bikeshed ${verb} <id> <thread>`);
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, `${verb}_thread`, { ...docArgs(ref), threadId });
  out(flags.json, result, () => console.log(`${verb === "resolve" ? "resolved" : "reopened"} ${threadId}`));
}

/**
 * Propose new text for one passage of a document's current version. The
 * passage is quoted as a reader sees it, which is how `comments` prints it, so
 * a quote can go straight from one command to the other.
 */
async function suggest(flags, [ref, ...rest]) {
  const exact = rest.join(" ");
  const usage = "usage: bikeshed suggest <id> <text> (--with <new text> | --delete) [--note <why>]";
  if (!ref || !exact) fail(usage);
  const replacement = replacementFrom(flags, usage);
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "suggest_edit", {
    ...docArgs(ref),
    exact,
    replacement,
    ...(typeof flags.note === "string" ? { note: flags.note } : {}),
    ...(typeof flags.prefix === "string" ? { prefix: flags.prefix } : {}),
    ...(typeof flags.suffix === "string" ? { suffix: flags.suffix } : {}),
  });
  out(flags.json, result, () =>
    console.log(`suggested in ${result.threadId}; a person who can approve will accept or reject it`),
  );
}

/** The replacement `suggest` and `revise` were given: --with, or --delete by name. */
function replacementFrom(flags, usage) {
  const replacing = typeof flags.with === "string";
  if (replacing === Boolean(flags.delete)) fail(usage);
  // An empty --with is what an unset shell variable sends; deleting a passage
  // has to be asked for by name.
  if (replacing && flags.with === "") fail("an empty --with would delete the passage; say --delete if you mean that");
  return replacing ? flags.with : "";
}

/**
 * Change the text of a suggestion of yours that nobody has decided yet. What
 * it said before is kept, for whoever decides (SPEC §22).
 */
async function revise(flags, [ref, threadId, ...rest]) {
  const usage = "usage: bikeshed revise <id> <thread> (--with <new text> | --delete) [--note <why>]";
  if (!ref || !threadId || rest.length) fail(usage);
  const replacement = replacementFrom(flags, usage);
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "revise_suggestion", {
    ...docArgs(ref),
    threadId,
    replacement,
    ...(typeof flags.note === "string" ? { note: flags.note } : {}),
  });
  out(flags.json, result, () => console.log(`changed ${threadId}; what it said before is kept`));
}

/**
 * Accept a suggestion, as the document's owner or an approver. The change is
 * made in the draft, where the decisions of a review gather until `commit`
 * publishes them as one version (SPEC §22).
 */
async function accept(flags, [ref, threadId, ...rest]) {
  if (!ref || !threadId || rest.length) fail("usage: bikeshed accept <id> <thread>");
  const { origin, token } = resolveAuth(flags);
  // Deciding takes a real role on the document, never a link, so only the id is sent.
  const result = await callTool(origin, token, "accept_suggestion", { id: docArgs(ref).id, threadId });
  out(flags.json, result, () => console.log(`accepted ${threadId}; the change is in the draft — \`bikeshed commit\` publishes it`));
}

/** Publish the draft as the document's next version, as "Save as new version" does in the app. */
async function commit(flags, [ref, ...rest]) {
  if (!ref || rest.length) fail("usage: bikeshed commit <id>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "commit_draft", { id: docArgs(ref).id });
  out(flags.json, result, () =>
    console.log(result.deduped ? `nothing new: the draft is ${result.versionId} already` : `published ${result.versionId}`),
  );
}

/**
 * Decline a suggestion, as the document's owner or an approver. The passage
 * stays as it is and the thread closes with a note giving the reason, which
 * its author is sent (SPEC §22).
 */
async function reject(flags, [ref, threadId, ...rest]) {
  if (!ref || !threadId || rest.length) fail("usage: bikeshed reject <id> <thread> [--reason <why>]");
  const { origin, token } = resolveAuth(flags);
  // Deciding takes a real role on the document, never a link, so only the id is sent.
  const result = await callTool(origin, token, "reject_suggestion", {
    id: docArgs(ref).id,
    threadId,
    ...(typeof flags.reason === "string" ? { reason: flags.reason } : {}),
  });
  out(flags.json, result, () => console.log(`rejected ${threadId}`));
}

/** Take back a suggestion of yours that nobody has decided yet; its thread stays. */
async function withdraw(flags, [ref, threadId, ...rest]) {
  if (!ref || !threadId || rest.length) fail("usage: bikeshed withdraw <id> <thread>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "withdraw_suggestion", { ...docArgs(ref), threadId });
  out(flags.json, result, () => console.log(`withdrew ${threadId}`));
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
      // Filing a document here shares it with everyone counted, and emails nobody.
      const readers = typeof folder.readers === "number" ? `  ${folder.readers} can read` : "";
      console.log(`${label.padEnd(40)} ${folder.id}${readers}${note}`);
    }
    if (result.truncated) {
      console.log("\nThere are more folders than this listing shows.");
    }
  });
}

/**
 * Where a published document is filed and who can read it there, from what the
 * server read after the write, for a person to be told. Empty for a deployment
 * too old to say.
 */
function describeAccess(result) {
  const access = result.access;
  if (!access) return "";
  const where = result.filedIn ? `filed in ${result.filedIn.path}` : "at the root";
  const who = access.readers === 1 ? "only you can read it" : `${access.readers} people can read it`;
  const also = access.alsoReadableBy ? `, and ${access.alsoReadableBy}` : "";
  return `${where}: ${who}${also}`;
}

/** Who can read one folder: and so who can read anything filed in it. */
async function folder(flags, [id]) {
  if (!id) fail("usage: bikeshed folder <id>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "get_folder", { id });
  out(flags.json, result, () => {
    console.log(`${result.path}  ${result.id}${result.canWrite ? "" : "  (read-only)"}`);
    console.log(`${result.readers} can read it${result.readers === 1 ? " (only you)" : ""}:`);
    for (const person of result.people) console.log(`  ${person}`);
    if (result.morePeople > 0) console.log(`  and ${result.morePeople} more`);
    if (result.teams.length) console.log(`teams: ${result.teams.join(", ")}`);
    console.log(`can edit: ${[...result.editors, ...(result.moreEditors ? [`and ${result.moreEditors} more`] : [])].join(", ")}`);
  });
}

/** Exit status when `changes --wait` gives up: distinct from 1, an error. */
const WAIT_TIMED_OUT = 3;
/** The shortest wait between checks: each one reads the log and the document. */
const MIN_INTERVAL_S = 30;

/**
 * What happened on a document since a cursor (SPEC §19, ADR 0016).
 *
 * `--since` is required: a check that starts from nowhere in particular
 * reports nothing, and nothing reads as nothing happened. Every page is read
 * before anything is printed, and the cursor printed last is the one to pass
 * next time: replace whatever you held with it.
 *
 * `--wait` keeps checking until something happens, then prints it and exits 0.
 * A harness that wakes an agent when a background command ends (Claude Code
 * does) gets watching from one command. On timeout it exits 3 and still prints
 * the cursor, so the next wait resumes rather than restarts.
 */
async function changes(flags, [ref]) {
  const usage = "usage: bikeshed changes <id> --since <cursor|last|all> [--wait] [--interval <s>] [--timeout <s>]";
  if (!ref) fail(usage);
  if (typeof flags.since !== "string" || !flags.since) {
    fail(`${usage}\n--since is required: a cursor that publish, fork, get --json or changes printed; "last", where this sign-in left off; or "all"`);
  }
  const interval = Math.max(MIN_INTERVAL_S, flags.interval === undefined ? 60 : Number(flags.interval) || 0);
  const timeout = flags.timeout === undefined ? 3600 : Number(flags.timeout);
  if (!Number.isFinite(timeout) || timeout < 0) fail(usage);
  const { origin, token } = resolveAuth(flags);
  const doc = docArgs(ref);
  const started = Date.now();
  let since = flags.since;
  const events = [];
  for (;;) {
    const result = await callTool(origin, token, "get_changes", { ...doc, since });
    since = result.cursor;
    events.push(...result.events);
    if (result.more) continue;
    const waitFor = Math.max(interval, Number(result.retryAfter) || 0);
    if (!flags.wait || events.length > 0) return printChanges(flags, { ...result, events });
    if ((Date.now() - started) / 1000 + waitFor > timeout) {
      process.exitCode = WAIT_TIMED_OUT;
      return printChanges(flags, { ...result, events, timedOut: true });
    }
    await new Promise((r) => setTimeout(r, waitFor * 1000));
  }
}

function printChanges(flags, result) {
  out(flags.json, result, () => {
    if (result.timedOut) console.log("nothing new before the timeout");
    for (const e of result.events) {
      const quote = e.quote ? ` “${e.quote}”` : "";
      const words = e.body ? `: ${e.body}` : e.replacement !== undefined ? ` → “${e.replacement}”` : "";
      const via = e.channel && e.channel !== "web" ? ` [via ${e.channel}]` : "";
      console.log(`${e.at}  ${e.type}  ${e.by ?? ""}${via}${e.threadId ? `  (${e.threadId})` : ""}${quote}${words}`);
    }
    if (result.needsReply?.length) console.log(`waiting on a reply: ${result.needsReply.join(", ")}`);
    console.log(`next: --since ${result.cursor}`);
  });
}

/**
 * Your own copy of a document you can read. The original's author sees that it
 * was forked — a count, never who — and the fork records where it came from,
 * which only people who can open the original are shown (SPEC §21).
 */
async function fork(flags, [ref]) {
  if (!ref) fail("usage: bikeshed fork <id> [--version <v>] [--folder <id>] [--title <text>]");
  const { origin, token } = resolveAuth(flags);
  const args = docArgs(ref);
  if (typeof flags.version === "string") args.version = flags.version;
  if (typeof flags.folder === "string") args.folder = flags.folder;
  if (typeof flags.title === "string") args.title = flags.title;
  const result = await callTool(origin, token, "fork_document", args);
  out(flags.json, { ...result, url: result.url ?? `${origin}/d/${result.docId}` }, () =>
    console.log(`forked ${args.id} into ${result.docId} — ${result.url ?? `${origin}/d/${result.docId}`}`),
  );
}

/**
 * Where a document came from, nearest first, as far as you can open, and — for
 * its owner — what has been forked from it. The deployment decides what you may
 * see; this only prints it (SPEC §21).
 */
async function lineage(flags, [ref]) {
  if (!ref) fail("usage: bikeshed lineage <id>");
  const { origin, token } = resolveAuth(flags);
  const result = await callTool(origin, token, "get_lineage", docArgs(ref));
  out(flags.json, result, () => console.log(describeLineage(result)));
}

/** The human form of a get_lineage result. */
function describeLineage(result) {
  const lines = [];
  if (result.forked) {
    if (result.forkedFrom.length === 0) {
      lines.push("forked from a document you can't open");
    }
    result.forkedFrom.forEach((a, i) => {
      const changed = a.changedSince ? "   (changed since)" : "";
      lines.push(`${i === 0 ? "forked from" : "  which was"}  ${a.id} ${a.version}  ${a.title}${changed}`);
    });
    if (result.forkedFrom.length > 0 && result.moreYouCannotOpen) {
      lines.push("  which was   forked from a document you can't open");
    }
  } else if (!result.forks) {
    lines.push(`${result.id} is not a fork.`);
  }
  if (result.forks) {
    const { total, youCannotOpen, listed } = result.forks;
    if (lines.length) lines.push("");
    if (total === 0) {
      lines.push("Nobody has forked it yet.");
    } else {
      const times = total === 1 ? "once" : `${total} times`;
      lines.push(youCannotOpen ? `forked ${times}; ${youCannotOpen} you can't open` : `forked ${times}`);
      for (const f of listed) {
        const when = f.forkedAt ? f.forkedAt.slice(0, 10) : "";
        const owner = f.owner ? `  ${f.owner}` : "";
        lines.push(`  ${f.id.padEnd(34)} ${f.visibility.padEnd(8)} ${when.padEnd(10)} ${f.title}${owner}`);
      }
    }
  }
  return lines.join("\n");
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
  // Moving is an editor's act, and a link's key only lets somebody read, so
  // only the id goes along.
  const doc = docArgs(id).id;
  const args = dest === "root" ? { id: doc } : { id: doc, folder: dest };
  const result = await callTool(origin, token, "move_document", args);
  out(flags.json, result, () =>
    console.log(result.folder ? `moved ${doc} into ${result.folder}` : `moved ${doc} to the root`),
  );
}

/**
 * Give a document a new title. Its address is its id, which never changes, so
 * every link already sent keeps working (SPEC §4). The title is the rest of the
 * line, so it needs no quotes.
 */
async function rename(flags, [ref, ...rest]) {
  const title = rest.join(" ").trim();
  if (!ref || !title) fail("usage: bikeshed rename <id> <title>");
  const { origin, token } = resolveAuth(flags);
  // Renaming takes no link key, as in the workspace list: only the id is sent.
  const result = await callTool(origin, token, "rename_document", { id: docArgs(ref).id, title });
  out(flags.json, result, () => console.log(`renamed ${result.id} to “${result.title}”`));
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

async function open(flags, [ref]) {
  if (!ref) fail("usage: bikeshed open <id>");
  const { origin } = resolveAuth(flags);
  // An unlisted document opens only with its key, and the link is the one place
  // the key lives, so a link keeps it.
  const { id, k } = docArgs(ref);
  const url = `${origin}/d/${encodeURIComponent(id)}${k ? `?k=${encodeURIComponent(k)}` : ""}`;
  // Best effort, and the address is printed either way. This used to spawn
  // `start`, which is a cmd.exe builtin rather than a program, so on Windows
  // the spawn failed and, with nothing listening for the error, crashed.
  openBrowser(url);
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
  logout,
  list,
  publish,
  update,
  fork,
  lineage,
  get,
  comments,
  changes,
  comment,
  reply,
  resolve: resolveThread,
  reopen: reopenThread,
  suggest,
  revise,
  withdraw,
  accept,
  reject,
  commit,
  open,
  folders,
  folder,
  mkdir,
  mv,
  rename,
  skills: skillsCommand,
};

/** Commands that reach a deployment without authenticating as anybody. */
const NO_TOKEN = new Set(["login", "logout", "open", "skills"]);

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
      version: { type: "string" },
      parent: { type: "string" },
      origin: { type: "string" },
      token: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      with: { type: "string" },
      delete: { type: "boolean", default: false },
      paste: { type: "boolean", default: false },
      "no-browser": { type: "boolean", default: false },
      note: { type: "string" },
      reason: { type: "string" },
      body: { type: "string" },
      prefix: { type: "string" },
      suffix: { type: "string" },
      since: { type: "string" },
      wait: { type: "boolean", default: false },
      interval: { type: "string" },
      timeout: { type: "string" },
      base: { type: "string" },
    },
  });

  const [name, ...rest] = positionals;
  // On its own, --version is about this program; after `fork` it names the
  // version of a document to copy, which is why it is not checked first.
  // Declared as taking a value for fork's sake, it swallows a `--json` that
  // follows it, so that value is read back as the flag it was.
  if (!name && !values.help && (values.version !== undefined || values.v)) {
    out(values.json || values.version === "--json", { version: VERSION }, () => console.log(`bikeshed ${VERSION}`));
    return;
  }
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
