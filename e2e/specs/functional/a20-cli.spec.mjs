// SPDX-License-Identifier: Apache-2.0
// A20.7: every `bikeshed` command with --json against the target through e2e/lib/cli.mjs, and never an origin outside it (SPEC §19, §23).

/**
 * The command line is a thin shell over the endpoints the app already calls
 * (SPEC §19): POST /publish for bytes, POST /mcp for everything else, GET
 * /content for the rest of a cut source, POST /tokens to revoke itself. Each
 * case runs the stack tree's own CLI through lib/cli.mjs, which builds its
 * environment from nothing and forces BIKESHED_ORIGIN, and checks what the
 * command printed under --json against what the deployment then holds.
 *
 * Time: the functional tier gives a spec file 10 minutes, and on a shared
 * stack a write (an account, a token, a publish, a move) has taken 7 to 17
 * seconds. So:
 *   - one owner and one stranger are cast for this file, both with
 *     notifications off; every case mints its own token(s), uses its own CLI
 *     home and makes its own documents, so no case reads another's state (the
 *     one case that needs an empty account, list, casts its own);
 *   - each selected case's tokens and seed documents are made at once, in
 *     parallel, before the first case runs (`prepare`), and a case awaits its
 *     own: the writes it is about are still its own, in order;
 *   - inside a case, commands that do not depend on each other run together.
 *
 * Every comment, suggestion and decision is the owner's own, on the owner's
 * own document, so nothing here sends email on either tier. Documents and
 * folders the CLI creates are written to the run's ledger as soon as their ids
 * are known, so a later act on them passes the production guard and
 * quarantine finds them.
 *
 * Every --json command keeps human prompts and notices on stderr. Open
 * returns its complete URL; both login flows identify the saved deployment
 * and credential source without returning the token.
 *
 * Load. On the long-lived shared stack one function call has taken 15 to 60
 * seconds (measured 2026-10-11, its Firestore emulator at 100% CPU: mkdir
 * 18 s, rename 41 s, every upload and fork past 60 s), and the Hosting
 * emulator answers 504 ITSELF for a function that has not answered within
 * its minute (60,057-60,140 ms in the CLI's own timings). The product never
 * answered that request, so nothing was measured: every case declares
 * `inconclusiveOnStackTimeout`, and a CLI run whose `cut` names that 504
 * (lib/cli.mjs runCli, spawnCli) or a response the case reads itself goes
 * through lib/test.mjs `answered()`, so such a case ends INCONCLUSIVE with
 * the evidence. Any other status, a quick 504 included, is the product's and
 * is judged.
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after, before } from "node:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { answered, currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { bearerHttp, listTokens, mintToken, openSession } from "../../lib/session.mjs";
import { absentDocId, docIdFor, ledgerDoc as ledgerDocLib, ledgerFolder as ledgerFolderLib, ledgerToken, publish, readFixture, seedThreads, zipBundle } from "../../lib/seed.mjs";
import { cliEntry, cliHome, runCli, spawnCli } from "../../lib/cli.mjs";
import { patchCapability } from "../../lib/options.mjs";
import { agentName, createHttp } from "../../lib/http.mjs";
import { approveViaApi } from "../../lib/oauth.mjs";
import { closeAdmin, listObjects, readCollection, readDoc, readObject } from "../../lib/admin.mjs";
import { closeWindows, setVisibility } from "../../lib/grant.mjs";
import { tinyPng } from "../../lib/thumbs.mjs";
import { egressMark, readEgress } from "../../lib/egress.mjs";
import { eventually } from "../../lib/assert.mjs";
import { mcpClient } from "../../lib/mcp.mjs";
import { eventAt, settleLog } from "../../lib/changes.mjs";

const target = currentTarget();
after(async () => {
  if (!target) return;
  // A20.7d's document is made unlisted in its setup, outside any case: its window is the process's.
  await closeWindows();
  await closeAdmin(target);
});

const BOTH = ["local", "prod"];
const LOCAL = ["local"];

/** The patch set the skills-name case needs: a stack whose /skills/index.json names an unusable skill first. */
const BAD_SKILL_SET = "a20-cli-bad-skill-name";
const BAD_SKILL = patchCapability(BAD_SKILL_SET);
const BAD_SKILL_NAME = "..";

/** Where the egress log stood when this spec file started: CLI refusals after it are this file's to explain. */
const EGRESS_SINCE = target?.kind === "local" && target.stack?.logs?.egress ? egressMark(target) : 0;

const sha = (b) => createHash("sha256").update(b).digest("hex");
const tag = () => `${runTag(target.runId)}-${rand4()}`;

// --- a stack that did not answer ------------------------------------------------------

/**
 * lib/ requests wait past Hosting's 60 s cut-off, so a slow answer ends in an
 * answer or Hosting's own 504 (which `inconclusiveOnStackTimeout` and
 * `answered()` judge), never in the client's 60 s deadline racing it.
 */
const REQUEST_MS = 150_000;
/** How long one CLI process may run before runCli kills it: a command is up to three requests, each up to Hosting's minute. */
const CLI_MS = 240_000;

/** The account's tokens (POST /tokens {op: "list"}), judged answered. */
async function tokensOf(session) {
  return answered(await listTokens(session), "POST /tokens list").json?.tokens ?? [];
}

/** The CLI's own version, from the package.json beside the entry that runs (SPEC §19: read from its own package.json). */
function cliVersion() {
  const { entry } = cliEntry(target);
  return JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")).version;
}

/** A small HTML page whose paragraphs are p1…pn. */
function page(title, paras) {
  const body = paras.map((p, i) => `<p id="p${i + 1}">${p}</p>`).join("\n");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>\n${body}\n</body></html>\n`;
}

// --- people, tokens and seed documents ------------------------------------------------

let castOnce = null;
/** This file's owner and stranger, each with a session: cast on first use. */
function people() {
  castOnce ??= (async () => {
    const [ownerAcct, strangerAcct] = await cast(target, ["owner", "stranger"], { notifications: false });
    const [owner, stranger] = await Promise.all([openSession(target, ownerAcct, { timeoutMs: REQUEST_MS }), openSession(target, strangerAcct, { timeoutMs: REQUEST_MS })]);
    return { owner, stranger };
  })();
  return castOnce;
}

/**
 * `who` ("owner" or "stranger") of this file — or, with `fresh`, an account of
 * its own — with `tokens` fresh cli tokens; `docs` are publish() options,
 * published as that person while the tokens are minted.
 */
async function ready(key, { who = "owner", tokens = 1, fresh = false, docs = [] } = {}) {
  let session;
  if (fresh) {
    const [acct] = await cast(target, [who], { notifications: false });
    session = await openSession(target, acct, { timeoutMs: REQUEST_MS });
  } else {
    session = (await people())[who];
  }
  const email = session.account.email;
  const minted = [];
  for (let i = 0; i < tokens; i++) minted.push(await mintToken(session, { name: `e2e a20-cli ${key} ${i + 1}`, channel: "cli" }));
  const published = [];
  for (const d of docs) published.push(await publish(session.http, { filename: "index.html", ownerEmail: email, ...d }));
  return { who, session, account: session.account, email, tokens: minted, token: minted[0]?.token, docs: published };
}

/** Case names, by key: `prepare` makes only what the selected cases need. */
const NAMES = {
  a: "A20.7a --version --json prints {version} from the CLI's own package.json, and --version alone prints `bikeshed <version>`",
  b: "A20.7b publish --json stores the file's bytes at the requested --id as v1 (url, cursor, filedIn, access) with provenance channel cli via upload and the CLI's own client header; a taken --id still publishes, under another id, said on stderr only",
  c: "A20.7c list --json pages newest first with --limit and --cursor, and --all returns all three documents",
  d: "A20.7d get and get --json return the whole source of a document over get_document's 200,000-character cap (truncated false, the uploaded bytes); a pasted ?k= link reads an unlisted document for a non-member, and the bare id answers as an absent one",
  e: "A20.7e update --json sends an .html through update_document (publishedVia mcp), the same bytes again is deduped, and a stale --base is refused naming the current version, minting nothing",
  f: "A20.7f update of a .zip, by name or by its magic bytes, goes up as bytes to /publish?update= (publishedVia cli): every entry, a binary image included, is stored byte for byte, and --base is honoured there too",
  g: "A20.7g fork --json makes the caller's own copy (v1, url, cursor), and lineage --json links the fork to its source and the source to its fork",
  h: "A20.7h comment, reply, resolve, reopen and comments --json (with --all) carry one thread through its life; comment refuses an empty --body before anything is sent",
  i: "A20.7i suggest needs exactly one of --with and --delete and refuses an empty --with before anything is sent; suggest, revise, withdraw, reject, accept and commit --json carry suggestions to a published version, and comments --version reads the earlier one",
  j: "A20.7j changes --json: --since is required; `all` reads what another credential caused, with quote and body; a quiet cursor comes back unchanged; another document's cursor is refused; --wait --timeout on a quiet cursor exits 3 with the cursor; --wait returns 0 with what arrived after its first check, at least --interval 30 s in",
  k: "A20.7k mkdir, folders, folder, publish --folder, mv and rename --json file and retitle documents; mv needs its destination and spells the root `root`; rename keeps the address",
  l: "A20.7l skills --json lists the deployment's skills, and skills install <dir> --json writes each one's SKILL.md as served, without a token",
  m: "A20.7m skills install refuses a bare parent-directory name first in the index and writes nothing",
  z: "A20.7m2 skills install refuses an uppercase name first in the index and writes nothing",
  aa: "A20.7m3 skills install refuses an underscore name first in the index and writes nothing",
  n: "A20.7n open prints the document's address, keeping a pasted link's key, and hands exactly that address to the system opener",
  o: "A20.7o open --json prints a JSON value on stdout, as SPEC §19 says every command takes --json",
  p: "A20.7p login --json signs in through the browser flow and saves a cli token marked via browser; logout --json revokes it on the deployment (401 after) and keeps the origin; a token revoking another token's id is refused 403",
  q: "A20.7q logout --json only forgets a pasted token (it keeps working), never touches BIKESHED_TOKEN, and with nothing saved says so",
  r: "A20.7r login --paste --json prints a JSON value on stdout, as SPEC §19 says every command takes --json",
  s: "A20.7s publish --watch --json publishes once per burst of saves: the first save, then one update per burst (two new versions, then an identical burst deduped), one JSON result each",
  t: "A20.7t publish --watch --json writes nothing but JSON to stdout, as SPEC §19 says every command takes --json",
  w: "A20.7w list --all reads both default-sized pages: all 51 documents exactly once in newest-first order",
  x: "A20.7x changes reads both default-sized pages: all 103 recorded events exactly once in stored order",
  y: "A20.7y changes --interval 1 respects the 30-second floor when the server requests no additional delay",
  v: "A20.7v login in CI refuses before opening a browser or saving a credential",
  u: "A20.7u no CLI process this spec started reached for anything outside the stack (zero egress refusals with this spec as parent), and the commands it runs here reach the stack itself",
};

/** The passages the seeded documents hold, quoted by the cases that act on them. */
const Q = {
  h: "the passage under discussion",
  i1: "the original wording",
  i2: "a clause to drop",
  i3: "a sentence to keep",
  j: "a watched passage",
};

/** What each case needs made before it runs. */
const SETUP = {
  b: () => ready("b", { docs: [{ body: page("Taken", ["Holds the id first."]), title: `CLI publish taken ${tag()}`, name: "cli-publish-taken" }] }),
  c: () => ready("c", { fresh: true, docs: [1, 2, 3].map((n) => ({ body: page(`List ${n}`, [`Listed document ${n}.`]), title: `CLI list ${n} ${tag()}`, name: `cli-list-${n}` })) }),
  d: async () => {
    const [owner, stranger] = await Promise.all([
      ready("d", { docs: [{ fixture: "large-doc.html", filename: "large-doc.html", title: `CLI get ${tag()}`, name: "cli-get-large" }] }),
      ready("d", { who: "stranger" }),
    ]);
    // Unlisted here, and private again in after(): two writes out of the case's time.
    const { linkToken } = await setVisibility(target, { owner: owner.session, doc: owner.docs[0].docId, visibility: "unlisted" });
    return { ...owner, stranger, linkToken };
  },
  e: () => {
    const title = `CLI update ${tag()}`;
    return ready("e", { docs: [{ body: page(title, ["First text."]), title, name: "cli-update" }] });
  },
  f: async () => {
    const title = `CLI zip ${tag()}`;
    const v1 = { "index.html": Buffer.from(page(title, ["Bundle v1."])), "img.png": tinyPng({ rgb: [10, 20, 30] }) };
    return ready("f", { docs: [{ body: await zipBundle(v1, target), filename: "bundle.zip", title, name: "cli-zip" }] });
  },
  g: () => {
    const title = `CLI fork source ${tag()}`;
    return ready("g", { docs: [{ body: page(title, ["Source text."]), title, name: "cli-fork-src" }] });
  },
  h: () => {
    const title = `CLI comments ${tag()}`;
    return ready("h", { docs: [{ body: page(title, [`Here is ${Q.h} in the first paragraph.`, "Another paragraph."]), title, name: "cli-comments" }] });
  },
  i: () => {
    const title = `CLI suggestions ${tag()}`;
    return ready("i", { docs: [{ body: page(title, [`Keep ${Q.i1} for now.`, `Remove ${Q.i2} please.`, `And ${Q.i3} as written.`]), title, name: "cli-suggestions" }] });
  },
  j: () => {
    const title = `CLI changes ${tag()}`;
    return ready("j", {
      tokens: 4,
      docs: [
        { body: page(title, [`Here is ${Q.j} for the watcher.`]), title, name: "cli-changes" },
        { body: page("other", ["Another document."]), title: `CLI changes other ${tag()}`, name: "cli-changes-other" },
      ],
    });
  },
  k: () => ready("k", { docs: [{ body: page("Renamed soon", ["A document to retitle."]), title: `CLI rename ${tag()}`, name: "cli-rename" }] }),
  p: () => ready("p"),
  q: () => ready("q"),
  r: () => ready("r"),
  s: () => ready("s"),
  u: () => ready("u"),
};

/**
 * What runs on after a case's setup, outside the setup queue, while earlier
 * cases run: the two cases whose subject is time. Each returns what it saw
 * (no assertion) and a log its case replays as steps; the case asserts.
 */
const BACKGROUND = {
  j: (o) => changesWaiter(o),
  s: (o) => watchBursts(o),
};

/** The --test-name-pattern(s) this process was started with (node passes them to each file's process). */
function namePatterns() {
  return process.execArgv
    .filter((a) => a.startsWith("--test-name-pattern="))
    .map((a) => {
      const p = a.slice("--test-name-pattern=".length);
      const m = /^\/(.*)\/([a-z]*)$/s.exec(p);
      return m ? new RegExp(m[1], m[2]) : new RegExp(p);
    });
}

/**
 * How many setups run at once. Each request the stack's function emulator
 * cannot hand to a warm worker starts a cold one; twenty at once on a shared
 * stack timed requests out at 60 s and answered a CLI publish 504. Two at a
 * time, in case order, stays ahead of the cases without that.
 */
const SETUP_CONCURRENCY = 2;
let setupsRunning = 0;
const setupQueue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      setupsRunning++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          setupsRunning--;
          setupQueue.shift()?.();
        });
    };
    if (setupsRunning < SETUP_CONCURRENCY) run();
    else setupQueue.push(run);
  });
}

const prepared = new Map();
/** Start (once, queued) what case `key` needs, then its background phase; the promise never rejects unhandled. */
function prepare(key) {
  if (!prepared.has(key)) {
    const p = limited(SETUP[key]).then((o) => (BACKGROUND[key] ? BACKGROUND[key](o).then((bg) => ({ ...o, bg })) : o));
    p.catch(() => {});
    prepared.set(key, p);
  }
  return prepared.get(key);
}

/** A step log for work done outside a case, replayed into the case's steps by `setup`. */
function stepLog() {
  const t0 = Date.now();
  const lines = [];
  return { lines, step: (text) => lines.push(`[+${((Date.now() - t0) / 1000).toFixed(2)}s before the case] ${text}`) };
}

before(() => {
  if (!target) return;
  const patterns = namePatterns();
  for (const key of Object.keys(SETUP)) {
    if (patterns.length === 0 || patterns.some((re) => re.test(NAMES[key]))) prepare(key);
  }
});

/** The case's prepared actor, with a fresh CLI home. */
async function setup(ctx, key) {
  const o = await prepare(key);
  ctx.step(`${o.who} ${o.email}: ${o.tokens.length} cli token(s); document(s) ${o.docs.map((d) => `${d.docId} ${d.versionId}`).join(", ") || "none"}`);
  for (const line of o.bg?.log ?? []) ctx.step(line);
  return { ...o, home: cliHome(target) };
}

/** The same person with one of their other tokens and a CLI home of its own. */
function withToken(who, i) {
  return { ...who, token: who.tokens[i].token, home: cliHome(target) };
}

// --- running the CLI ----------------------------------------------------------------

/** `bikeshed <args>` as `who` (its token and home unless overridden), logged as a step. */
async function cli(ctx, who, args, o = {}) {
  const token = "token" in o ? o.token : who?.token;
  const home = o.home ?? who?.home ?? cliHome(target);
  ctx.step(`bikeshed ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}${token ? "" : "   (no token)"}`);
  const r = await runCli(target, args, { token, home, input: o.input, env: o.env, traceCalls: o.traceCalls, timeoutMs: o.timeoutMs ?? CLI_MS });
  ctx.step(`  → ${args[0]} exit ${r.code}${r.signal ? ` (${r.signal})` : ""} in ${r.ms} ms${r.stderr ? `; stderr ${JSON.stringify(r.stderr.slice(0, 200))}` : ""}`);
  // A case's own run that the stack did not answer (runCli's `cut`) ends
  // INCONCLUSIVE here; a background phase (a stepLog, no ctx.inconclusive)
  // returns it as it is, and the case's okJson judges it.
  if (typeof ctx.inconclusive === "function") answered(r);
  return r;
}

/** Exit 0 and stdout is exactly one JSON value; returns it. */
function okJson(r, what) {
  answered(r, what);
  assert.equal(r.code, 0, `${what}: exit ${r.code}, stderr ${JSON.stringify(r.stderr.slice(0, 400))}`);
  assert.ok(r.json !== undefined && r.json !== null && typeof r.json === "object", `${what}: stdout is one JSON value: ${JSON.stringify(r.stdout.slice(0, 300))}`);
  return r.json;
}

/** Exit 1, stderr matching `re`, nothing on stdout. */
function refused(r, what, re) {
  answered(r, what);
  assert.equal(r.code, 1, `${what}: exit ${r.code}, stdout ${JSON.stringify(r.stdout.slice(0, 200))}`);
  assert.match(r.stderr, re, `${what}: stderr`);
  assert.equal(r.stdout, "", `${what}: nothing on stdout`);
}

/**
 * Split stdout into the top-level JSON values `out()` printed (pretty, one
 * after another) and whatever else is on it, outside any value.
 */
function jsonStream(text) {
  const docs = [];
  const stray = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let loose = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (depth === 0 && ch !== "{" && ch !== "[") {
      loose += ch;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") {
      if (depth === 0) {
        if (loose.trim()) stray.push(loose.trim());
        loose = "";
        start = i;
      }
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) docs.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  if (loose.trim()) stray.push(loose.trim());
  return { docs, stray };
}

/** The URLs the stub opener recorded in a CLI home. The CLI spawns it detached and exits, so it may land after. */
function openedIn(home) {
  return existsSync(home.opened) ? readFileSync(home.opened, "utf8").split("\n").filter(Boolean) : [];
}

/** Ledger what the CLI created the moment its id is known (lib/seed.mjs ledgerDoc, ledgerFolder): the CLI passes through no creating helper. */
function ledgerDoc(docId, who, { via = "cli", forkOf } = {}) {
  ledgerDocLib(target, { docId, via, ownerEmail: who.email, actor: "cli", ...(forkOf ? { forkOf } : {}) });
}
function ledgerFolder(folderId, who, { parentId = null, name = null } = {}) {
  ledgerFolderLib(target, { folderId, via: "cli", ownerEmail: who.email, actor: "cli", parentId, name });
}

/** Write a file into a CLI home (its cwd), returning the name to pass. */
function put(who, name, content) {
  writeFileSync(join(who.home.home, name), content);
  return name;
}

/**
 * The stored files of a version, read from Storage under its record's
 * storagePrefix (the bytes themselves, not a function's rendering of them).
 */
async function storedFiles(docId, versionId) {
  const rec = await readDoc(target, `docs/${docId}/versions/${versionId}`);
  const prefix = `${rec?.storagePrefix ?? `docs/${docId}/${versionId}`}/`;
  const keys = await listObjects(target, prefix);
  const files = await Promise.all(keys.map(async (key) => [key.slice(prefix.length), await readObject(target, key)]));
  return Object.fromEntries(files);
}

/** A document's version ids, sorted by number. */
async function versionIds(docId) {
  const rows = await readCollection(target, `docs/${docId}/versions`);
  return rows.map((r) => r.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** The longest the long-running CLI (publish --watch) may live, whatever happens to its case: lib/cli.mjs spawnCli kills its group then. */
const WATCH_MAX_MS = 300_000;

// --- A20.7a --version -----------------------------------------------------------

scenario(NAMES.a, { tiers: BOTH, timeoutMs: 60_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const version = cliVersion();
  const home = cliHome(target);
  const [jR, plain] = await Promise.all([cli(ctx, null, ["--version", "--json"], { home, token: null }), cli(ctx, null, ["--version"], { home, token: null })]);
  assert.deepEqual(okJson(jR, "--version --json"), { version }, "the version is the one in cli/package.json");
  assert.deepEqual({ code: plain.code, stdout: plain.stdout }, { code: 0, stdout: `bikeshed ${version}\n` });
});

// --- A20.7l / A20.7m skills -----------------------------------------------------------

scenario(NAMES.l, {
  tiers: BOTH,
  // These stacks deliberately serve unusable names; their refusal cases own installation.
  needs: [`!${BAD_SKILL}`, `!${patchCapability("a20-cli-uppercase-skill")}`, `!${patchCapability("a20-cli-underscore-skill")}`],
  timeoutMs: 180_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const http = ctx.http({ actor: "anonymous", timeoutMs: REQUEST_MS });
  const index = (await http.get("/skills/index.json", { expect: 200 })).json;
  precondition(Array.isArray(index?.skills) && index.skills.length > 0, "the deployment serves a skill index");
  const home = cliHome(target);
  const dir = join(home.home, "agent-skills");
  const [listedR, instR, badR] = await Promise.all([
    cli(ctx, null, ["skills", "--json"], { home, token: null }),
    cli(ctx, null, ["skills", "install", dir, "--json"], { home, token: null }),
    cli(ctx, null, ["skills", "uninstall", "--json"], { home, token: null }),
  ]);
  assert.deepEqual(okJson(listedR, "skills --json"), index, "skills --json is the deployment's index");
  const names = index.skills.map((s) => s.name);
  assert.deepEqual(okJson(instR, "skills install --json"), { installed: names.map((n) => `${n}/SKILL.md`), into: dir });
  assert.deepEqual(readdirSync(dir).sort(), [...names].sort(), "one directory per skill, nothing else");
  for (const s of index.skills) {
    const served = (await http.get(`/${s.path}`, { expect: 200 })).buffer;
    assert.equal(sha(readFileSync(join(dir, s.name, "SKILL.md"))), sha(served), `${s.name}/SKILL.md is the served file`);
  }
  refused(badR, "an unknown skills subcommand", /^error: usage: bikeshed skills \[install <dir>\]/);
});

/** Only the first entry is invalid: this makes no atomic-install promise for later entries. */
async function refuseFirstSkill(ctx, badName) {
  const http = ctx.http({ actor: "anonymous", timeoutMs: REQUEST_MS });
  const index = (await http.get("/skills/index.json", { expect: 200 })).json;
  precondition(index?.skills?.[0]?.name === badName, `the patched index names ${badName} first`);
  const home = cliHome(target);
  const parent = join(home.home, "skills-parent");
  const dir = join(parent, "agent-skills");
  mkdirSync(dir, { recursive: true });
  const r = await cli(ctx, null, ["skills", "install", dir, "--json"], { home, token: null });
  refused(r, "skills install with an unusable name", new RegExp(`^error: refusing a skill with an unusable name: ${badName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\n$`));
  assert.deepEqual(readdirSync(dir), [], "nothing was written into the directory");
  assert.deepEqual(readdirSync(parent), ["agent-skills"], "nothing escaped it");
}

scenario(NAMES.m, { tiers: LOCAL, needs: [BAD_SKILL], timeoutMs: 120_000, inconclusiveOnStackTimeout: true }, (ctx) => refuseFirstSkill(ctx, BAD_SKILL_NAME));
scenario(NAMES.z, { tiers: LOCAL, needs: [patchCapability("a20-cli-uppercase-skill")], timeoutMs: 120_000, inconclusiveOnStackTimeout: true }, (ctx) => refuseFirstSkill(ctx, "Bikeshed"));
scenario(NAMES.aa, { tiers: LOCAL, needs: [patchCapability("a20-cli-underscore-skill")], timeoutMs: 120_000, inconclusiveOnStackTimeout: true }, (ctx) => refuseFirstSkill(ctx, "bikeshed_skill"));

// --- A20.7n / A20.7o open -------------------------------------------------------------

scenario(NAMES.n, { tiers: BOTH, timeoutMs: 120_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const id = docIdFor(target, "cli-open");
  const k = `e2e-key-${rand4()}`;
  const [h1, h2] = [cliHome(target), cliHome(target)];
  const [r, r2] = await Promise.all([
    cli(ctx, null, ["open", id], { home: h1, token: null }),
    cli(ctx, null, ["open", `${target.origin}/d/${id}/v1?k=${k}`], { home: h2, token: null }),
  ]);
  const want1 = `${target.origin}/d/${id}`;
  const want2 = `${target.origin}/d/${id}?k=${k}`;
  assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: `${want1}\n` });
  assert.deepEqual({ code: r2.code, stdout: r2.stdout }, { code: 0, stdout: `${want2}\n` }, "a link's key stays with it, a version in it does not");
  // The CLI starts the opener detached and exits; the stub writes its line on its own time.
  await eventually(() => openedIn(h1).length > 0 && openedIn(h2).length > 0, { timeout: 15_000, interval: 100, message: "the stub opener ran for both" });
  assert.deepEqual([openedIn(h1), openedIn(h2)], [[want1], [want2]], "the opener got exactly the printed address");
});

scenario(NAMES.o, { tiers: BOTH, timeoutMs: 120_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const id = docIdFor(target, "cli-open-json");
  const home = cliHome(target);
  const url = `${target.origin}/d/${id}?k=e2e-json-key`;
  const r = await cli(ctx, null, ["open", `${target.origin}/d/${id}/v1?k=e2e-json-key`, "--json"], { home, token: null });
  assert.deepEqual(okJson(r, "open --json"), { url }, "open --json reports the complete document URL");
  await eventually(() => openedIn(home).length > 0, { timeout: 15_000, interval: 100, message: "the JSON open invoked the opener" });
  assert.deepEqual(openedIn(home), [url], "open --json opens exactly the returned URL");
});

// --- A20.7b publish ---------------------------------------------------------------

scenario(NAMES.b, { tiers: BOTH, timeoutMs: 420_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "b");
  const taken = o.docs[0].docId;
  const id = docIdFor(target, "cli-publish");
  const title = `CLI publish ${tag()}`;
  const bytes = page(title, ["Alpha passage for the command line.", "Beta passage, plain."]);
  put(o, "note.html", bytes);

  ctx.step(`at a free --id, and at ${taken}, which another document already holds`);
  const [r, again] = await Promise.all([
    cli(ctx, o, ["publish", "note.html", "--id", id, "--title", title, "--json"]),
    cli(ctx, o, ["publish", "note.html", "--id", taken, "--title", `${title} again`, "--json"]),
  ]);
  const j = okJson(r, "publish --json");
  if (j.docId) ledgerDoc(j.docId, o);
  const j2 = okJson(again, "publish --id <taken> --json");
  if (j2.docId) ledgerDoc(j2.docId, o);
  assert.deepEqual(
    { docId: j.docId, versionId: j.versionId, title: j.title, url: j.url, filedIn: j.filedIn, readers: j.access?.readers, people: j.access?.people },
    { docId: id, versionId: "v1", title, url: `${target.origin}/d/${id}`, filedIn: null, readers: 1, people: [o.email] },
  );
  assert.equal(r.stderr, "", "nothing on stderr when the id was free");
  assert.equal(typeof j.cursor, "string", "publish --json carries the cursor to watch from (SPEC §19)");
  assert.notEqual(j2.docId, taken, "a taken id is not reused");
  assert.equal(j2.versionId, "v1");
  assert.equal(again.stderr, `${taken} was not available; published at ${j2.docId}\n`, "the CLI says so on stderr, so --json stays parseable (SPEC §19)");

  ctx.step("the cursor publish printed is one `changes` accepts; v1 is the file, with its provenance; the holder of the taken id is untouched");
  const [cR, files, rec, holder] = await Promise.all([
    cli(ctx, o, ["changes", id, "--since", j.cursor, "--json"], { home: cliHome(target) }),
    storedFiles(id, "v1"),
    readDoc(target, `docs/${id}/versions/v1`),
    readDoc(target, `docs/${taken}`),
  ]);
  assert.deepEqual(okJson(cR, "changes --since <publish cursor>").events, [], "nothing happened since the publish (the caller's own publish is not reported)");
  assert.deepEqual(Object.keys(files), ["index.html"]);
  assert.equal(sha(files["index.html"]), sha(Buffer.from(bytes)), "v1's index.html is the uploaded file");
  assert.deepEqual(
    { publishedVia: rec.publishedVia, channel: rec.publishedBy?.channel, client: rec.publishedBy?.client, agent: rec.publishedBy?.agent, tokenId: rec.publishedBy?.tokenId, email: rec.publishedByEmail },
    { publishedVia: "upload", channel: "cli", client: `bikeshed-cli/${cliVersion()}`, agent: agentName(target), tokenId: o.tokens[0].tokenId, email: o.email },
    "version provenance (SPEC §17: channel from the token record, client and agent as reported)",
  );
  assert.deepEqual({ currentVersion: holder.currentVersion, title: holder.title }, { currentVersion: "v1", title: o.docs[0].json.title }, "the document holding the id is untouched");
});

// --- A20.7c list ------------------------------------------------------------------

scenario(NAMES.c, { tiers: BOTH, timeoutMs: 420_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "c");
  // Published together, so the order is the server's: createdAt, newest first.
  const created = await Promise.all(o.docs.map(async (d) => ({ id: d.docId, at: (await readDoc(target, `docs/${d.docId}`)).createdAt.toMillis() })));
  precondition(new Set(created.map((d) => d.at)).size === 3, "three distinct creation times");
  const newestFirst = created.sort((a, b) => b.at - a.at).map((d) => d.id);

  const [p1R, allR] = await Promise.all([cli(ctx, o, ["list", "--limit", "2", "--json"]), cli(ctx, o, ["list", "--all", "--json"], { home: cliHome(target) })]);
  const p1 = okJson(p1R, "list --limit 2");
  assert.deepEqual(p1.documents.map((d) => d.id), newestFirst.slice(0, 2), "page 1: the two newest");
  assert.equal(typeof p1.nextCursor, "string", "page 1 says there is more");
  const p2 = okJson(await cli(ctx, o, ["list", "--limit", "2", "--cursor", p1.nextCursor, "--json"]), "list --cursor");
  assert.deepEqual(p2.documents.map((d) => d.id), newestFirst.slice(2), "page 2: the oldest");
  assert.equal(p2.nextCursor, null, "page 2 is the last");
  const all = okJson(allR, "list --all");
  assert.deepEqual(all.documents.map((d) => d.id), newestFirst, "--all: all three documents, in order");
  assert.equal(all.nextCursor, null);
  assert.deepEqual(
    all.documents.map((d) => ({ version: d.version, visibility: d.visibility, owner: d.owner })),
    newestFirst.map(() => ({ version: "v1", visibility: "private", owner: o.email })),
  );
});

// --- A20.7d get -------------------------------------------------------------------

scenario(NAMES.d, { tiers: BOTH, timeoutMs: 480_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const bytes = readFixture("large-doc.html", { raw: true });
  precondition(bytes.length > 200_000, `the large-doc fixture is over 200,000 characters (${bytes.length})`);
  const o = await setup(ctx, "d");
  const stranger = { ...o.stranger, home: cliHome(target) };
  const up = o.docs[0];

  ctx.step("unlisted in its setup: the owner's get, then a stranger's get <link> --json, with get <id> and get <absent id> alongside");
  const k = o.linkToken;
  precondition(typeof k === "string" && k.length > 0, "the unlisted document has a link key");
  const link = `${target.origin}/d/${up.docId}?k=${k}`;
  const absent = absentDocId(target, "cli-get-absent");
  // One large read at a time: run together they queue in the stack's function
  // emulator, and the last one passed Hosting's 60 s proxy limit (a 504). The
  // source is over get_document's 200,000-character cap (SPEC §19), so each
  // read is get_document's cut copy plus the rest through /content.
  const [plain, bare, none] = await Promise.all([
    cli(ctx, o, ["get", up.docId]),
    cli(ctx, stranger, ["get", up.docId, "--json"], { home: cliHome(target) }),
    cli(ctx, stranger, ["get", absent, "--json"], { home: cliHome(target) }),
  ]);
  assert.equal(plain.code, 0, `get: exit ${plain.code}, stderr ${JSON.stringify(plain.stderr.slice(0, 300))}`);
  assert.equal(sha(Buffer.from(plain.stdout, "utf8")), sha(bytes), "get prints the whole source, byte for byte, and nothing else");
  const viaLink = okJson(await cli(ctx, stranger, ["get", link, "--json"]), "get <link> --json");
  assert.deepEqual(
    { id: viaLink.id, version: viaLink.version, truncated: viaLink.truncated, canEdit: viaLink.canEdit, length: viaLink.source?.length, cursor: typeof viaLink.cursor },
    { id: up.docId, version: "v1", truncated: false, canEdit: false, length: bytes.length, cursor: "string" },
    "the whole-source JSON preserves the cursor to watch from",
  );
  assert.equal(sha(Buffer.from(viaLink.source, "utf8")), sha(bytes), "get --json carries the whole source: the link's key reached /content for the rest too");
  refused(bare, "get <unlisted id> without its key", /^error: no document with id "/);
  refused(none, "get <absent id>", /^error: no document with id "/);
  assert.equal(bare.stderr.replace(up.docId, "<id>"), none.stderr.replace(absent, "<id>"), "the same answer as an id that does not exist (SPEC §17)");
});

// --- A20.7e update (.html) -------------------------------------------------------

scenario(NAMES.e, { tiers: BOTH, timeoutMs: 420_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "e");
  const up = o.docs[0];
  const title = up.json.title;
  const v2 = page(title, ["Second text, from the command line."]);
  put(o, "v2.html", v2);

  const j = okJson(await cli(ctx, o, ["update", up.docId, "v2.html", "--json"]), "update <id> v2.html --json");
  assert.deepEqual({ versionId: j.versionId, deduped: j.deduped, url: j.url }, { versionId: "v2", deduped: false, url: `${target.origin}/d/${up.docId}` });

  put(o, "v3.html", page(title, ["Third text, revised from v1."]));
  const [rec, files, sameR, stale] = await Promise.all([
    readDoc(target, `docs/${up.docId}/versions/v2`),
    storedFiles(up.docId, "v2"),
    cli(ctx, o, ["update", up.docId, "v2.html", "--json"]),
    cli(ctx, o, ["update", up.docId, "v3.html", "--base", "v1", "--json"]),
  ]);
  assert.deepEqual(
    { publishedVia: rec.publishedVia, channel: rec.publishedBy?.channel, client: rec.publishedBy?.client, parentVersion: rec.parentVersion },
    { publishedVia: "mcp", channel: "mcp", client: `bikeshed-cli/${cliVersion()}`, parentVersion: "v1" },
    "an .html update goes through update_document",
  );
  assert.equal(sha(files["index.html"]), sha(Buffer.from(v2)), "v2 is the file");
  const same = okJson(sameR, "update with identical bytes");
  assert.deepEqual({ versionId: same.versionId, deduped: same.deduped }, { versionId: "v2", deduped: true });
  refused(stale, "update --base v1 after v2", /the document is at v2 now, not v1/);
  assert.deepEqual(await versionIds(up.docId), ["v1", "v2"], "neither the dedup nor the stale update minted a version");
});

// --- A20.7f update (.zip) --------------------------------------------------------

scenario(NAMES.f, { tiers: BOTH, timeoutMs: 480_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "f");
  const up = o.docs[0];
  precondition(up.versionId === "v1", "the bundle published as v1");
  const title = up.json.title;

  const v2 = { "index.html": Buffer.from(page(title, ["Bundle v2, with a new image."])), "img.png": tinyPng({ rgb: [250, 200, 150] }) };
  precondition(v2["img.png"].some((b) => b > 0x7f), "the image holds bytes a text read would corrupt");
  put(o, "bundle.zip", await zipBundle(v2, target));
  const r2 = await cli(ctx, o, ["update", up.docId, "bundle.zip", "--json"]);
  const [doc2, rec2] = await Promise.all([readDoc(target, `docs/${up.docId}`), readDoc(target, `docs/${up.docId}/versions/v2`)]);
  assert.deepEqual(
    { exit: r2.code, versionId: r2.json?.versionId, current: doc2?.currentVersion, publishedVia: rec2?.publishedVia, channel: rec2?.publishedBy?.channel },
    { exit: 0, versionId: "v2", current: "v2", publishedVia: "cli", channel: "cli" },
    "the .zip went up as bytes to /publish?update= (SPEC §19)",
  );

  ctx.step("the same kind of archive under a name that is not .zip, sniffed by its magic bytes; and --base on the bytes path, refused");
  const v3 = { "index.html": Buffer.from(page(title, ["Bundle v3, sniffed."])), "img.png": tinyPng({ rgb: [129, 255, 200] }) };
  put(o, "bundle.bin", await zipBundle(v3, target));
  const [files2, r3, stale] = await Promise.all([
    storedFiles(up.docId, "v2"),
    cli(ctx, o, ["update", up.docId, "bundle.bin", "--json"]),
    cli(ctx, o, ["update", up.docId, "bundle.zip", "--base", "v1", "--json"]),
  ]);
  assert.deepEqual(Object.keys(files2).sort(), ["img.png", "index.html"]);
  for (const name of Object.keys(v2)) assert.equal(sha(files2[name]), sha(v2[name]), `v2's ${name} is byte for byte the bundle's`);
  assert.equal(okJson(r3, "update <id> bundle.bin --json").versionId, "v3");
  refused(stale, "update bundle.zip --base v1 after v2", /the document is at v[23] now, not v1/);
  const [rec3, files3] = await Promise.all([readDoc(target, `docs/${up.docId}/versions/v3`), storedFiles(up.docId, "v3")]);
  assert.equal(rec3.publishedVia, "cli", "an archive by its bytes takes the same path");
  for (const name of Object.keys(v3)) assert.equal(sha(files3[name]), sha(v3[name]), `v3's ${name} is byte for byte the bundle's`);
  assert.deepEqual(await versionIds(up.docId), ["v1", "v2", "v3"]);
});

// --- A20.7g fork and lineage --------------------------------------------------------

scenario(NAMES.g, { tiers: BOTH, timeoutMs: 420_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "g");
  const src = o.docs[0];
  const forkTitle = `CLI fork copy ${tag()}`;
  const f = okJson(await cli(ctx, o, ["fork", src.docId, "--title", forkTitle, "--json"]), "fork --json");
  if (f.docId) ledgerDoc(f.docId, o, { via: "fork", forkOf: src.docId });
  assert.notEqual(f.docId, src.docId);
  assert.deepEqual({ versionId: f.versionId, title: f.title, url: f.url, cursor: typeof f.cursor }, { versionId: "v1", title: forkTitle, url: `${target.origin}/d/${f.docId}`, cursor: "string" });

  const [lf, ls] = await Promise.all([cli(ctx, o, ["lineage", f.docId, "--json"]), cli(ctx, o, ["lineage", src.docId, "--json"], { home: cliHome(target) })]);
  const fj = okJson(lf, "lineage <fork> --json");
  assert.equal(fj.forked, true);
  assert.deepEqual(fj.forkedFrom.map((a) => ({ id: a.id, version: a.version })), [{ id: src.docId, version: "v1" }]);
  const sj = okJson(ls, "lineage <source> --json");
  assert.equal(sj.forked, false);
  assert.deepEqual({ total: sj.forks?.total, listed: sj.forks?.listed?.map((x) => x.id) }, { total: 1, listed: [f.docId] });
});

// --- A20.7h comments ----------------------------------------------------------------

scenario(NAMES.h, { tiers: BOTH, timeoutMs: 600_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "h");
  const id = o.docs[0].docId;
  const quote = Q.h;
  const body = `First point ${tag()}`;
  const [empty, c] = await Promise.all([
    cli(ctx, o, ["comment", id, quote, "--body", "", "--json"], { home: cliHome(target) }),
    cli(ctx, o, ["comment", id, quote, "--body", body, "--json"]),
  ]);
  refused(empty, "comment with an empty --body", /usage: bikeshed comment/);
  const made = okJson(c, "comment --json");
  assert.deepEqual({ version: made.version, quote: made.quote, threadId: typeof made.threadId }, { version: "v1", quote, threadId: "string" });
  const t = made.threadId;
  const replyText = `A reply ${tag()}`;
  okJson(await cli(ctx, o, ["reply", id, t, ...replyText.split(" "), "--json"]), "reply --json");

  const open1 = okJson(await cli(ctx, o, ["comments", id, "--json"]), "comments --json");
  assert.deepEqual(
    open1.threads.map((th) => ({ threadId: th.threadId, quote: th.quote, resolved: th.resolved, comments: th.comments.map((x) => [x.author, x.via, x.body]) })),
    [{ threadId: t, quote, resolved: false, comments: [[o.email, "mcp", body], [o.email, "mcp", replyText]] }],
  );

  okJson(await cli(ctx, o, ["resolve", id, t, "--json"]), "resolve --json");
  const [openAfter, allAfter] = await Promise.all([cli(ctx, o, ["comments", id, "--json"]), cli(ctx, o, ["comments", id, "--all", "--json"], { home: cliHome(target) })]);
  assert.deepEqual(okJson(openAfter, "comments after resolve").threads, [], "resolved threads are not listed without --all");
  assert.deepEqual(okJson(allAfter, "comments --all").threads.map((th) => [th.threadId, th.resolved]), [[t, true]]);

  okJson(await cli(ctx, o, ["reopen", id, t, "--json"]), "reopen --json");
  const open2 = okJson(await cli(ctx, o, ["comments", id, "--json"]), "comments after reopen");
  assert.deepEqual(open2.threads.map((th) => [th.threadId, th.resolved]), [[t, false]]);
});

// --- A20.7i suggestions -------------------------------------------------------------

scenario(NAMES.i, { tiers: BOTH, timeoutMs: 720_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "i");
  const id = o.docs[0].docId;

  ctx.step("the flag rules, all refused by the CLI itself");
  const usage = /^error: usage: bikeshed suggest <id> <text> \(--with <new text> \| --delete\)/;
  const [neither, both, empty, revise0] = await Promise.all([
    cli(ctx, o, ["suggest", id, Q.i1, "--json"]),
    cli(ctx, o, ["suggest", id, Q.i1, "--with", "x", "--delete", "--json"], { home: cliHome(target) }),
    cli(ctx, o, ["suggest", id, Q.i1, "--with", "", "--json"], { home: cliHome(target) }),
    cli(ctx, o, ["revise", id, "t-none", "--json"], { home: cliHome(target) }),
  ]);
  refused(neither, "suggest with neither", usage);
  refused(both, "suggest with both", usage);
  refused(empty, "suggest --with \"\"", /^error: an empty --with would delete the passage; say --delete if you mean that\n$/);
  refused(revise0, "revise with neither", /^error: usage: bikeshed revise /);
  assert.deepEqual((await readCollection(target, `docs/${id}/versions/v1/annotations`)).map((t) => t.id), [], "no refused suggestion reached the deployment");

  ctx.step("three suggestions, then each decided its own way");
  const [s1R, s2R, s3R] = await Promise.all([
    cli(ctx, o, ["suggest", id, Q.i1, "--with", "a first idea", "--note", "draft one", "--json"]),
    cli(ctx, o, ["suggest", id, Q.i2, "--delete", "--json"], { home: cliHome(target) }),
    cli(ctx, o, ["suggest", id, Q.i3, "--with", "a worse sentence", "--json"], { home: cliHome(target) }),
  ]);
  const [s1, s2, s3] = [okJson(s1R, "suggest --with"), okJson(s2R, "suggest --delete"), okJson(s3R, "suggest --with (to reject)")];
  assert.deepEqual([s1, s2, s3].map((s) => [s.version, s.quote]), [["v1", Q.i1], ["v1", Q.i2], ["v1", Q.i3]]);
  const [revR, wR, rejR] = await Promise.all([
    cli(ctx, o, ["revise", id, s1.threadId, "--with", "the better wording", "--note", "draft two", "--json"]),
    cli(ctx, o, ["withdraw", id, s2.threadId, "--json"], { home: cliHome(target) }),
    cli(ctx, o, ["reject", id, s3.threadId, "--reason", "keep it as it is", "--json"], { home: cliHome(target) }),
  ]);
  okJson(revR, "revise --with");
  okJson(wR, "withdraw");
  okJson(rejR, "reject --reason");

  const listed = okJson(await cli(ctx, o, ["comments", id, "--all", "--json"]), "comments --all");
  const byId = Object.fromEntries(listed.threads.map((th) => [th.threadId, th]));
  assert.deepEqual(
    { replacement: byId[s1.threadId]?.suggestion?.replacement, state: byId[s1.threadId]?.suggestion?.state, revisions: byId[s1.threadId]?.suggestion?.revisions?.map((r) => [r.replacement, r.note ?? null]) },
    { replacement: "the better wording", state: "pending", revisions: [["a first idea", "draft one"]] },
    "revise keeps what it said before (SPEC §22)",
  );
  assert.deepEqual({ replacement: byId[s2.threadId]?.suggestion?.replacement, state: byId[s2.threadId]?.suggestion?.state }, { replacement: "", state: "withdrawn" }, "--delete proposes an empty replacement; withdraw closes it");
  assert.deepEqual({ state: byId[s3.threadId]?.suggestion?.state, resolved: byId[s3.threadId]?.resolved }, { state: "rejected", resolved: true });
  assert.ok(byId[s3.threadId].comments.some((x) => x.body.includes("keep it as it is")), "the reason is in the thread");

  ctx.step("accept the revised one and commit: v2 holds exactly that change");
  okJson(await cli(ctx, o, ["accept", id, s1.threadId, "--json"]), "accept");
  const c = okJson(await cli(ctx, o, ["commit", id, "--json"]), "commit");
  assert.deepEqual({ versionId: c.versionId, deduped: c.deduped }, { versionId: "v2", deduped: false });
  const [stored, curR, oldR] = await Promise.all([
    storedFiles(id, "v2"),
    cli(ctx, o, ["comments", id, "--json"]),
    cli(ctx, o, ["comments", id, "--version", "v1", "--all", "--json"], { home: cliHome(target) }),
  ]);
  const v2 = String(stored["index.html"] ?? "");
  assert.ok(v2.includes("Keep the better wording for now.") && !v2.includes(Q.i1), "v2 holds the accepted replacement, not the quote");
  assert.ok(v2.includes(`Remove ${Q.i2} please.`) && v2.includes(`And ${Q.i3} as written.`), "the withdrawn and the rejected suggestions changed nothing");
  assert.deepEqual(await versionIds(id), ["v1", "v2"], "only the commit minted a version");
  ctx.step("the threads stay on v1: comments reads v2's (none), --version v1 reads them");
  const cur = okJson(curR, "comments on v2");
  assert.deepEqual({ version: cur.version, threads: cur.threads }, { version: "v2", threads: [] });
  const old = okJson(oldR, "comments --version v1 --all");
  assert.deepEqual({ version: old.version, threads: old.threads.map((th) => th.threadId).sort() }, { version: "v1", threads: [s1.threadId, s2.threadId, s3.threadId].sort() });
});

// --- A20.7j changes -----------------------------------------------------------------

/**
 * A20.7j's background phase: from the head of the log (after the publish's own
 * event), a waiter starts `changes --wait`; once its first check has read the
 * log, the writer comments. The waiter runs on while earlier cases do; the
 * case awaits it.
 */
async function changesWaiter(o) {
  const log = stepLog();
  const [up] = o.docs;
  const poller = mcpClient(target, { token: o.tokens[3].token, actor: "poller", timeoutMs: REQUEST_MS });
  await poller.initialize();
  log.step("the head of the log, once the publish's own version.published is in it (events are recorded by triggers)");
  const head = await eventually(async () => {
    const r = await poller.ok("get_changes", { id: up.docId, since: "all" });
    return r.events.some((e) => e.type === "version.published") ? r.cursor : false;
  }, { timeout: 240_000, interval: 500, message: "the publish's version.published event" });
  // The waiter's token has never polled this document, so its saved "last"
  // cursor appears exactly when its first check has read the log (SPEC §19:
  // get_changes always saves the cursor it returns).
  const saved = `users/${o.session.uid}/cursors/${o.tokens[2].tokenId}~${up.docId}`;
  const savedBefore = await readDoc(target, saved);
  const waiter = { ...o, token: o.tokens[2].token, home: cliHome(target) };
  const t0 = Date.now();
  const waiting = cli(log, waiter, ["changes", up.docId, "--since", head, "--wait", "--interval", "1", "--timeout", "420", "--json"], { timeoutMs: 480_000, traceCalls: target.kind === "local" });
  waiting.catch(() => {});
  await eventually(async () => (await readDoc(target, saved)) !== null, { timeout: 240_000, interval: 250, message: "the waiting CLI's first check" });
  const firstCheckMs = Date.now() - t0;
  log.step(`the waiter's first check has read the log (${firstCheckMs} ms in); the writer comments now`);
  const writer = { ...o, token: o.tokens[0].token, home: cliHome(target) };
  const body = `Watched comment ${tag()}`;
  const madeR = await cli(log, writer, ["comment", up.docId, Q.j, "--body", body, "--json"]);
  return { log: log.lines, head, savedBefore, waiting, firstCheckMs, body, madeR };
}

scenario(NAMES.j, { tiers: BOTH, timeoutMs: 720_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "j");
  const { bg } = o;
  const [up, other] = o.docs;
  const writer = withToken(o, 0);
  const watcher = withToken(o, 1);
  precondition(bg.savedBefore === null, "the waiter had no saved cursor before its first check");
  const made = okJson(bg.madeR, "the writer's comment, made after the waiter's first check");
  const body = bg.body;

  const poller = ctx.mcp({ token: o.tokens[3].token, actor: "poller", timeoutMs: REQUEST_MS });
  await poller.initialize();
  let recorded;
  const [noSince] = await Promise.all([
    cli(ctx, watcher, ["changes", up.docId, "--json"]),
    eventually(async () => {
      recorded = await poller.ok("get_changes", { id: up.docId, since: "all" });
      const types = recorded.events.filter((e) => e.threadId === made.threadId).map((e) => e.type);
      return types.includes("thread.opened") && types.includes("comment.added");
    }, { timeout: 240_000, interval: 500, message: "both thread and comment events in the log (recorded by independent triggers)" }),
  ]);
  refused(noSince, "changes without --since", /--since is required/);

  const [allR, mineR, foreignR] = await Promise.all([
    cli(ctx, watcher, ["changes", up.docId, "--since", "all", "--json"]),
    cli(ctx, writer, ["changes", up.docId, "--since", "all", "--json"]),
    cli(ctx, watcher, ["changes", other.docId, "--since", "all", "--json"], { home: cliHome(target) }),
  ]);
  const all = okJson(allR, "changes --since all");
  const seen = all.events.filter((e) => e.threadId === made.threadId).map((e) => ({ type: e.type, by: e.by, channel: e.channel, quote: e.quote }));
  assert.deepEqual(
    seen.toSorted((a, b) => a.type.localeCompare(b.type)),
    [
      { type: "comment.added", by: o.email, channel: "mcp", quote: Q.j },
      { type: "thread.opened", by: o.email, channel: "mcp", quote: Q.j },
    ],
    "another credential's thread and comment, each with its quote (SPEC §19)",
  );
  assert.deepEqual(seen.map((e) => e.type), recorded.events.filter((e) => e.threadId === made.threadId).map((e) => e.type), "the CLI preserves recorded order, not trigger occurrence order (SPEC §19, ADR 0016)");
  assert.equal(all.events.find((e) => e.type === "comment.added" && e.threadId === made.threadId)?.body, body, "the comment carries its body");
  assert.deepEqual({ cursor: typeof all.cursor, more: all.more }, { cursor: "string", more: false }, "the small feed is complete, with the cursor to pass next");
  assert.deepEqual(okJson(mineR, "the writer's own changes").events.filter((e) => e.threadId === made.threadId), [], "what the caller caused is left out (SPEC §19)");

  const [quietR, staleR, waitedR] = await Promise.all([
    cli(ctx, watcher, ["changes", up.docId, "--since", all.cursor, "--json"]),
    cli(ctx, watcher, ["changes", up.docId, "--since", okJson(foreignR, "the other document's cursor").cursor, "--json"], { home: cliHome(target) }),
    cli(ctx, watcher, ["changes", up.docId, "--since", all.cursor, "--wait", "--timeout", "5", "--json"], { home: cliHome(target) }),
  ]);
  const quiet = okJson(quietR, "changes on a quiet cursor");
  assert.deepEqual({ events: quiet.events, cursor: quiet.cursor }, { events: [], cursor: all.cursor }, "a quiet poll gives the same cursor back");
  refused(staleR, "a cursor of another document", /^error: since: .*Pass a cursor from an earlier result, "last" or "all"/);
  assert.equal(waitedR.code, 3, `--wait that times out exits 3 (SPEC §19); stderr ${JSON.stringify(waitedR.stderr.slice(0, 200))}`);
  assert.ok(waitedR.json, `the timed-out wait still prints JSON: ${JSON.stringify(waitedR.stdout.slice(0, 200))}`);
  assert.deepEqual({ timedOut: waitedR.json.timedOut, events: waitedR.json.events, cursor: waitedR.json.cursor }, { timedOut: true, events: [], cursor: all.cursor }, "and the cursor to resume from");

  ctx.step("the waiter, whose first check came before the comment, returned with it from a later check");
  const r = await bg.waiting;
  ctx.step(`  → the wait ended after ${r.ms} ms (first check ${bg.firstCheckMs} ms in)`);
  const j = okJson(r, "changes --wait");
  const ordered = all.events.filter((e) => e.threadId === made.threadId).map((e) => [e.type, e.threadId]);
  const waited = j.events.map((e) => [e.type, e.threadId]);
  assert.ok(waited.length > 0 && waited.length <= ordered.length, "the wait returns a nonempty recorded prefix");
  assert.deepEqual(waited, ordered.slice(0, waited.length), "the wait preserves recorded order");
  const resumed = okJson(await cli(ctx, watcher, ["changes", up.docId, "--since", j.cursor, "--json"]), "resuming after the wait");
  assert.deepEqual([...waited, ...resumed.events.map((e) => [e.type, e.threadId])], ordered, "wait and resume deliver both events once, in recorded order");
  assert.equal(j.timedOut, undefined, "it did not time out");
  if (target.kind === "local") {
    const firstBody = r.calls.find((e) => e.phase === "body" && e.tool === "get_changes");
    const nextCall = r.calls.find((e) => e.phase === "start" && e.tool === "get_changes" && e.id > firstBody?.id);
    precondition(firstBody && nextCall, "the wait contains a completed first response and a later check");
    assert.ok(nextCall.ms - firstBody.ms >= 29_900, "the next check follows the completed first response by at least the interval floor");
    ctx.ev.json("cli-wait-calls.json", r.calls);
  } else {
    assert.ok(r.ms >= 30_000, "the supported deployment wait includes its interval");
  }
  // The default server retryAfter is 60 seconds, so this case alone cannot
  // distinguish its delay from the CLI floor. A20.7y isolates the latter.
});

// --- A20.7k folders and rename --------------------------------------------------------

scenario(NAMES.k, { tiers: BOTH, timeoutMs: 600_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "k");
  const renamed = o.docs[0];
  const parentName = `CLI parent ${tag()}`;
  const newTitle = `Renamed by the command line ${tag()}`;
  const [fpR, renR] = await Promise.all([
    cli(ctx, o, ["mkdir", ...parentName.split(" "), "--json"]),
    cli(ctx, o, ["rename", renamed.docId, ...newTitle.split(" "), "--json"], { home: cliHome(target) }),
  ]);
  const fp = okJson(fpR, "mkdir --json");
  if (fp.folderId) ledgerFolder(fp.folderId, o, { name: parentName });
  assert.equal(fp.name, parentName);

  const id = docIdFor(target, "cli-filed");
  put(o, "filed.html", page("Filed", ["A filed document."]));
  const [fcR, pubR] = await Promise.all([
    cli(ctx, o, ["mkdir", "Child", "--parent", fp.folderId, "--json"], { home: cliHome(target) }),
    cli(ctx, o, ["publish", "filed.html", "--id", id, "--folder", fp.folderId, "--json"]),
  ]);
  const fc = okJson(fcR, "mkdir --parent --json");
  if (fc.folderId) ledgerFolder(fc.folderId, o, { parentId: fp.folderId, name: "Child" });
  const pub = okJson(pubR, "publish --folder --json");
  if (pub.docId) ledgerDoc(pub.docId, o);
  assert.deepEqual({ docId: pub.docId, filedIn: pub.filedIn }, { docId: id, filedIn: { id: fp.folderId, path: parentName } });
  const childPath = `${parentName}/Child`;

  refused(await cli(ctx, o, ["mv", id, "--json"]), "mv without a destination", /^error: usage: bikeshed mv <id> <folder\|root>/);
  assert.equal((await readDoc(target, `docs/${id}`)).folderId, fp.folderId, "a refused mv left the document where it was");

  const [toChildR, treeR, oneR] = await Promise.all([
    cli(ctx, o, ["mv", id, fc.folderId, "--json"]),
    cli(ctx, o, ["folders", "--json"], { home: cliHome(target) }),
    cli(ctx, o, ["folder", fc.folderId, "--json"], { home: cliHome(target) }),
  ]);
  const toChild = okJson(toChildR, "mv <id> <folder> --json");
  assert.deepEqual({ id: toChild.id, folder: toChild.folder, filedIn: toChild.filedIn }, { id, folder: fc.folderId, filedIn: { id: fc.folderId, path: childPath } });
  const mine = okJson(treeR, "folders --json").folders.filter((f) => f.id === fp.folderId || f.id === fc.folderId);
  assert.deepEqual(
    mine.map((f) => ({ id: f.id, parent: f.parent, path: f.path, readers: f.readers, canWrite: f.canWrite })).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { id: fp.folderId, parent: null, path: parentName, readers: 1, canWrite: true },
      { id: fc.folderId, parent: fp.folderId, path: childPath, readers: 1, canWrite: true },
    ],
  );
  const one = okJson(oneR, "folder <id> --json");
  assert.deepEqual({ id: one.id, path: one.path, readers: one.readers, people: one.people, editors: one.editors }, { id: fc.folderId, path: childPath, readers: 1, people: [o.email], editors: [o.email] });

  const toRoot = okJson(await cli(ctx, o, ["mv", id, "root", "--json"]), "mv <id> root --json");
  assert.deepEqual({ id: toRoot.id, folder: toRoot.folder, filedIn: toRoot.filedIn }, { id, folder: null, filedIn: null });

  ctx.step("rename took the rest of the line as the title; the id, the address, stays (SPEC §4)");
  assert.deepEqual(okJson(renR, "rename --json"), { id: renamed.docId, title: newTitle, url: `${target.origin}/d/${renamed.docId}` });
  const [retitled, filed] = await Promise.all([readDoc(target, `docs/${renamed.docId}`), readDoc(target, `docs/${id}`)]);
  assert.equal(retitled?.title, newTitle, "the new title is stored on the same document");
  assert.equal(filed.folderId ?? null, null, "the moved document is at the root");
});

// --- A20.7p–r login and logout -----------------------------------------------------------

scenario(NAMES.p, { tiers: BOTH, timeoutMs: 480_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "p");
  const home = cliHome(target);
  const before = new Set((await tokensOf(o.session)).map((t) => t.tokenId));

  ctx.step("login --json: the stub opener records the consent address; the owner approves it; the browser comes back to the CLI's loopback port");
  const login = cli(ctx, null, ["login", "--json"], { home, token: null, timeoutMs: 300_000 });
  let loginEnded = false;
  login.then(() => (loginEnded = true), () => (loginEnded = true)); // awaited below; a cut-off before then must not go unhandled
  // Before it opens anything the CLI reads the deployment's OAuth metadata: up to Hosting's minute on a loaded stack.
  const opened = await eventually(() => openedIn(home).at(0) ?? (loginEnded ? "exited" : false), { timeout: 150_000, interval: 200, message: "the CLI opened the consent address" });
  if (opened === "exited") okJson(await login, "login --json, before it opened anything");
  const consentUrl = new URL(opened);
  const params = Object.fromEntries(consentUrl.searchParams);
  assert.deepEqual(
    { origin: consentUrl.origin, path: consentUrl.pathname, client: params.client_id, method: params.code_challenge_method, resource: params.resource, redirectHost: new URL(params.redirect_uri).hostname },
    { origin: target.origin, path: "/connect", client: "bikeshed-cli", method: "S256", resource: `${target.origin}/mcp`, redirectHost: "127.0.0.1" },
    "the consent address (SPEC §23)",
  );
  const approved = await approveViaApi(createHttp(target, { actor: "owner-consent", timeoutMs: REQUEST_MS }), o.session.idToken, params);
  answered(approved.response, "POST /oauth/consent");
  assert.equal(approved.status, 200, `consent: ${approved.status}`);
  const back = new URL(approved.redirect);
  const browser = createHttp(target, { actor: "owner-browser", allowPorts: [Number(back.port)], timeoutMs: REQUEST_MS });
  assert.equal(answered(await browser.get(approved.redirect), "the CLI's callback page").status, 200, "the CLI's callback page");
  const j = okJson(await login, "login --json");
  const configPath = join(home.config, "bikeshed", "config.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const shaped = /^bsk_[0-9a-f]{32}\./.test(config.token ?? "");
  const tokenId = shaped ? config.token.slice(4, 36) : null;
  let fresh = null;
  try {
    fresh = (await tokensOf(o.session)).filter((t) => !before.has(t.tokenId));
  } finally {
    // The run holds this token from here: ledgered as soon as its id is known, its name once the account lists it.
    if (tokenId) ledgerToken(target, { tokenId, uid: o.session.uid, channel: "cli", name: fresh?.find((t) => t.tokenId === tokenId)?.name ?? null, via: "cli-login" });
  }
  assert.deepEqual(j, { origin: target.origin, saved: configPath, via: "browser" });
  assert.deepEqual({ origin: config.origin, via: config.via, shaped }, { origin: target.origin, via: "browser", shaped: true });
  assert.deepEqual(fresh.map((t) => ({ tokenId: t.tokenId, channel: t.channel, revoked: t.revoked })), [{ tokenId, channel: "cli", revoked: false }], "one new cli token (SPEC §23)");

  ctx.step("the saved sign-in works; a token presenting itself may not revoke another one (403), and both still work");
  const asSaved = bearerHttp(target, config.token, { actor: "saved-token", timeoutMs: REQUEST_MS });
  const [listR, cross] = await Promise.all([
    cli(ctx, null, ["list", "--limit", "1", "--json"], { home, token: null }),
    asSaved.postJson("/tokens", { op: "revoke", tokenId: o.tokens[0].tokenId }),
  ]);
  okJson(listR, "list with the saved sign-in");
  answered(cross, "POST /tokens revoke (another token's id)");
  assert.deepEqual({ status: cross.status, error: cross.json?.error }, { status: 403, error: "A token can revoke only itself." }, "a token cannot revoke another token id");
  for (const [label, tok] of [["the bystander", o.token], ["the saved token", config.token]]) {
    const mcp = ctx.mcp({ token: tok, actor: label, timeoutMs: REQUEST_MS });
    await mcp.initialize();
    await mcp.ok("list_documents", { limit: 1 });
  }

  ctx.step("logout --json revokes the saved token on the deployment and forgets it, keeping the origin");
  const logout = await cli(ctx, null, ["logout", "--json"], { home, token: o.token });
  const out = okJson(logout, "logout --json beside BIKESHED_TOKEN");
  assert.match(logout.stderr, /BIKESHED_TOKEN is set in this shell/, "logout names the separate shell credential");
  assert.deepEqual(out, { origin: target.origin, revoked: true, forgot: true });
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { origin: target.origin }, "the token is gone, the origin kept (SPEC §23)");
  const [probe, listedAfter] = await Promise.all([
    bearerHttp(target, config.token, { actor: "revoked-token", timeoutMs: REQUEST_MS }).postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_documents", arguments: { limit: 1 } } }),
    tokensOf(o.session),
  ]);
  assert.equal(answered(probe, "POST /mcp with the revoked token").status, 401, "the revoked token is refused at /mcp");
  assert.equal(listedAfter.find((t) => t.tokenId === tokenId)?.revoked, true, "the account lists it revoked");
  const bystander = ctx.mcp({ token: o.token, actor: "bystander-after", timeoutMs: REQUEST_MS });
  await bystander.initialize();
  await bystander.ok("list_documents", { limit: 1 });

  ctx.step("an already-revoked saved browser credential is confirmed dead and still forgotten");
  writeFileSync(configPath, JSON.stringify(config));
  const dead = await cli(ctx, null, ["logout", "--json"], { home, token: null });
  assert.deepEqual(okJson(dead, "logout of an already-revoked browser credential"), { origin: target.origin, revoked: true, forgot: true }, "an already-dead credential is confirmed revoked");
  assert.equal(dead.stderr, "", "a confirmed dead credential needs no revocation advice");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { origin: target.origin }, "logout forgets an already-dead credential and retains the origin");
});

scenario(NAMES.q, { tiers: BOTH, timeoutMs: 300_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "q");
  const home = cliHome(target);
  const pasted = await cli(ctx, null, ["login", "--paste"], { home, token: null, input: `${o.token}\n` });
  assert.equal(pasted.code, 0, `login --paste: ${pasted.stderr}`);
  const configPath = join(home.config, "bikeshed", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual({ origin: config.origin, via: config.via, same: config.token === o.token }, { origin: target.origin, via: "paste", same: true });

  const [out, env] = await Promise.all([
    cli(ctx, null, ["logout", "--json"], { home, token: null }),
    cli(ctx, o, ["logout", "--json"], { home: cliHome(target) }),
  ]);
  assert.deepEqual(okJson(out, "logout --json (pasted)"), { origin: target.origin, revoked: false, forgot: true });
  assert.match(out.stderr, /You pasted it in, so something else may use it too\. It still works until you revoke it at /, "it says where to revoke it");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { origin: target.origin });
  ctx.step("nothing saved, BIKESHED_TOKEN set: nothing is revoked, and the shell's token is named");
  assert.deepEqual(okJson(env, "logout --json with only BIKESHED_TOKEN"), { origin: target.origin, revoked: false, forgot: false });
  assert.match(env.stderr, /BIKESHED_TOKEN is set in this shell/);
  const still = ctx.mcp({ token: o.token, actor: "token-after-logouts", timeoutMs: REQUEST_MS });
  await still.initialize();
  await still.ok("list_documents", { limit: 1 });
});

scenario(NAMES.r, { tiers: BOTH, timeoutMs: 180_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "r");
  const home = cliHome(target);
  const r = await cli(ctx, null, ["login", "--paste", "--json"], { home, token: null, input: `${o.token}\n` });
  const saved = join(home.config, "bikeshed", "config.json");
  assert.deepEqual(okJson(r, "login --paste --json"), { origin: target.origin, saved, via: "paste" }, "paste login --json reports the saved credential source");
  assert.deepEqual(JSON.parse(readFileSync(saved, "utf8")), { origin: target.origin, token: o.token, via: "paste" });
  assert.match(r.stderr, /Create a token at .*\/account/);
  assert.match(r.stderr, /Token: /, "the paste prompt stays on stderr");
  assert.equal((r.stdout + r.stderr).includes(o.token), false, "paste login does not echo the token");
});

// --- A20.7s / A20.7t publish --watch ---------------------------------------------------

/**
 * A20.7s's background phase: `publish --watch --json` on a new file (lib/cli.mjs
 * spawnCli), then three bursts of saves, each marked on the watch and awaited
 * until its result prints, then a hold and a stop. It returns the stopped
 * watch and never throws on a wait: the case asserts, and first passes the
 * watch through answered(), whose `cut` times a 504 from the mark that set
 * the CLI working.
 */
async function watchBursts(o) {
  const log = stepLog();
  const home = cliHome(target);
  const id = docIdFor(target, "cli-watch");
  const title = `CLI watch ${tag()}`;
  const file = join(home.home, "watched.html");
  const text = (n) => page(title, [`Watched revision ${n}.`]);
  writeFileSync(file, text(1));
  /**
   * One burst, as an editor saves: a truncate-and-write, an append, then the
   * final content, BURST_GAP_MS apart. Written in one tick, the three merge
   * into one file event and a watcher with no debounce at all looks right
   * (the controls-a20-cli-watch-debounce control passed that way); spread,
   * each is its own event and only the 250 ms debounce makes them one
   * publish. Returns the largest gap the writes actually had.
   */
  const burst = async (n, replace = false) => {
    const at = [];
    writeFileSync(file, page(title, ["partial"]));
    at.push(performance.now());
    await new Promise((r) => setTimeout(r, BURST_GAP_MS));
    appendFileSync(file, "<!-- more -->\n");
    at.push(performance.now());
    await new Promise((r) => setTimeout(r, BURST_GAP_MS));
    if (replace) {
      const replacement = `${file}.save`;
      writeFileSync(replacement, text(n));
      renameSync(replacement, file);
    } else writeFileSync(file, text(n));
    at.push(performance.now());
    return Math.max(at[1] - at[0], at[2] - at[1]);
  };
  const gaps = [];
  let waitFailure = null;
  const args = ["publish", "watched.html", "--watch", "--id", id, "--title", title, "--json"];
  log.step(`bikeshed ${args.join(" ")}   (running until stopped)`);
  // Its first mark, "the start", is the first publish.
  const w = await spawnCli(target, args, { token: o.token, home, maxMs: WATCH_MAX_MS });
  let watching = false;
  try {
    // The readiness precondition accepts either stream, so a regressed notice
    // reaches the stdout oracle instead of making the watch look absent.
    await eventually(() => w.exited !== null || /watching watched\.html/.test(w.stdout + w.stderr), { timeout: 180_000, interval: 100, message: "the first publish, then the watch" });
    watching = w.exited === null;
    if (watching) {
      ledgerDoc(id, o);
      for (const [n, expected, replace] of [[2, 2, false], [3, 3, true], [3, 4, false]]) {
        log.step(`burst writing revision ${n}${replace ? " by atomic replacement" : ""}`);
        w.mark(`the burst writing revision ${n}`);
        gaps.push(await burst(n, replace));
        await eventually(() => jsonStream(w.stdout).docs.length >= expected || w.exited !== null, { timeout: 180_000, interval: 100, message: `result ${expected} of the watch` });
      }
      // The product debounces saves by 250 ms (cli/src/index.mjs watchFile), a
      // fixed time: hold for twelve of those so a second publish from any burst
      // would have printed by now.
      await new Promise((r) => setTimeout(r, 3_000));
    }
  } catch (err) {
    waitFailure = err?.message ?? String(err);
    log.step(`a wait ran out: ${waitFailure}`);
  } finally {
    await w.stop();
  }
  log.step(`stopped; ${jsonStream(w.stdout).docs.length} JSON result(s) printed${w.cut ? `; ${w.cut}` : ""}`);
  return { log: log.lines, id, finalText: text(3), watching, gaps, waitFailure, watch: w, stdout: w.stdout, stderr: w.stderr, exited: w.exited };
}

/**
 * The pause between the writes of one burst (the product debounces for 250
 * ms, cli/src/index.mjs watchFile: a fixed time, so these are fixed sleeps),
 * and the largest gap that still counts as one burst: past it, a correct
 * watcher may rightly publish twice, so the measurement is INCONCLUSIVE.
 */
const BURST_GAP_MS = 50;
const BURST_GAP_LIMIT_MS = 200;

scenario(NAMES.s, { tiers: BOTH, timeoutMs: 600_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "s");
  const { bg } = o;
  ctx.ev.text("watch-stdout.txt", bg.stdout);
  ctx.ev.text("watch-stderr.txt", bg.stderr);
  answered(bg.watch, "publish --watch");
  precondition(bg.watching, `publish --watch was still running after its first publish (exit ${JSON.stringify(bg.exited?.code)}: ${bg.stderr.slice(0, 300)})`);
  ctx.step(`largest gap inside each burst: ${bg.gaps.map((g) => `${g.toFixed(1)} ms`).join(", ")}`);
  if (bg.gaps.some((g) => g >= BURST_GAP_LIMIT_MS)) ctx.inconclusive(`a burst's writes were ${Math.max(...bg.gaps).toFixed(0)} ms apart, not inside the 250 ms debounce with room to spare (limit ${BURST_GAP_LIMIT_MS} ms)`);
  if (bg.waitFailure) throw new Error(`${bg.waitFailure} (stderr ${JSON.stringify(bg.stderr.slice(0, 300))})`);
  const { docs } = jsonStream(bg.stdout);
  assert.deepEqual(
    docs.map((d) => ({ id: d.docId ?? null, versionId: d.versionId, deduped: d.deduped ?? null })),
    [
      { id: bg.id, versionId: "v1", deduped: null },
      { id: null, versionId: "v2", deduped: false },
      { id: null, versionId: "v3", deduped: false },
      { id: null, versionId: "v3", deduped: true },
    ],
    "one result per burst: publish v1, update v2, update v3, an identical burst deduped",
  );
  const [versions, files] = await Promise.all([versionIds(bg.id), storedFiles(bg.id, "v3")]);
  assert.deepEqual(versions, ["v1", "v2", "v3"], "exactly one version per changed burst");
  assert.equal(sha(files["index.html"]), sha(Buffer.from(bg.finalText)), "v3 is the burst's final content, never a partial write");
});

/**
 * Publish notices go to stderr to preserve the machine-readable result stream
 * (SPEC §19). The watch remains alive and produces a real result before this
 * assertion: a process that exited before watching cannot pass by omission.
 * controls-a20-watch-json restores the old stdout notice.
 */
// The same watch as A20.7s (its background phase runs once, for both cases).
scenario(NAMES.t, { tiers: BOTH, timeoutMs: 600_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const { bg } = await setup(ctx, "s");
  const { docs, stray } = jsonStream(bg.stdout);
  // Its oracle is the text between results: once one result printed, a later cut-off leaves it judged.
  if (docs.length === 0) answered(bg.watch, "publish --watch");
  precondition(docs.length > 0, `publish --watch --json printed its first result (stderr ${JSON.stringify(bg.stderr.slice(0, 300))})`);
  precondition(bg.watching, `publish --watch was still running after its first publish (exit ${JSON.stringify(bg.exited?.code)}: ${bg.stderr.slice(0, 300)})`);
  assert.deepEqual(
    stray,
    [],
    `X-a20-cli-3: publish --watch --json wrote ${JSON.stringify(stray)} outside its JSON results (SPEC §19: notices belong on stderr)`,
  );
});

// --- A20.7u origin ---------------------------------------------------------------------

scenario(NAMES.u, { tiers: LOCAL, needs: ["egress-guard"], timeoutMs: 300_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await setup(ctx, "u");
  ctx.step("a command of each kind that resolves the deployment, then the egress log");
  const runs = await Promise.all([
    cli(ctx, o, ["list", "--limit", "1", "--json"]),
    cli(ctx, o, ["folders", "--json"], { home: cliHome(target) }),
    cli(ctx, null, ["skills", "--json"], { home: cliHome(target), token: null }),
    cli(ctx, null, ["logout", "--json"], { home: cliHome(target), token: null }),
  ]);
  const mine = readEgress(target, { since: EGRESS_SINCE }).filter((row) => row.ppid === process.pid);
  ctx.ev.json("egress-from-this-spec", mine);
  assert.deepEqual(
    mine.map((row) => `${row.kind} ${row.host}:${row.port} from ${row.script}`),
    [],
    "egress: CLI processes this spec started tried to leave the stack (they would have resolved an origin other than BIKESHED_ORIGIN)",
  );
  for (const [i, r] of runs.entries()) okJson(r, `command ${i + 1}`);
  assert.equal(runs[3].json.origin, target.origin, "logout with nothing saved names the stack as its deployment");
  // lastUsedAt is written best-effort after the request (functions/src/lib/tokens.ts), so it is waited for.
  await eventually(async () => Boolean((await tokensOf(o.session)).find((t) => t.tokenId === o.tokens[0].tokenId)?.lastUsedAt), { timeout: 120_000, interval: 500, message: "the stack saw the CLI's token (lastUsedAt set, SPEC §19)" });
});

scenario(NAMES.v, { tiers: BOTH, timeoutMs: 30_000 }, async (ctx) => {
  const home = cliHome(target);
  const result = await cli(ctx, null, ["login", "--json"], { home, token: null, env: { CI: "1", BIKESHED_LOGIN_TIMEOUT_MS: "1000" }, timeoutMs: 5000 });
  refused(result, "login in CI", /error: In CI, set BIKESHED_TOKEN and BIKESHED_ORIGIN\./);
  assert.deepEqual(openedIn(home), [], "CI login opens no browser");
  assert.equal(existsSync(join(home.config, "bikeshed", "config.json")), false, "CI login saves no credential");
});


scenario(NAMES.w, { tiers: LOCAL, timeoutMs: 1_200_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  // A fresh account makes the list exact. Publish real documents rather than
  // changing the server/CLI page size: --all asks for 50, so 51 needs two calls.
  const o = await ready("w", { fresh: true });
  o.home = cliHome(target);
  const docs = [];
  for (let n = 1; n <= 51; n++) {
    const d = await publish(o.session.http, { filename: "index.html", body: page(`Page boundary ${n}`, [`Document ${n}.`]), ownerEmail: o.email, title: `CLI page ${n} ${tag()}`, name: `cli-page-${n}` });
    docs.push({ id: d.docId, at: (await readDoc(target, `docs/${d.docId}`)).createdAt });
  }
  precondition(new Set(docs.map((d) => `${d.at.seconds}:${d.at.nanoseconds}`)).size === 51, "51 distinct server creation times");
  const wanted = docs.sort((a, b) => b.at.seconds - a.at.seconds || b.at.nanoseconds - a.at.nanoseconds).map((d) => d.id);
  const r = await cli(ctx, o, ["list", "--all", "--json"], { timeoutMs: 360_000 });
  const all = okJson(r, "list --all across its 50-document boundary");
  assert.deepEqual(all.documents.map((d) => d.id), wanted, "--all returns all 51 documents in order across the default page boundary");
  assert.equal(new Set(all.documents.map((d) => d.id)).size, 51, "each document is returned once");
  assert.equal(all.nextCursor, null, "the combined list ends at a null cursor");
});

scenario(NAMES.x, { tiers: LOCAL, timeoutMs: 900_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await ready("x", { tokens: 2, docs: [{ body: page("Changes boundary", [Q.j]), title: `CLI changes pages ${tag()}`, name: "cli-change-pages" }] });
  const id = o.docs[0].docId;
  const writer = ctx.mcp({ token: o.tokens[0].token, actor: "page-writer", timeoutMs: REQUEST_MS });
  await writer.initialize();
  // The established local seed copies the first real tool-written thread;
  // all 102 thread/comment events are recorded by the product's own triggers.
  await seedThreads(writer, { docId: id, n: 51, exact: Q.j, body: (i) => `CLI paging comment ${i}` });
  const log = await settleLog(target, id, { "version.published": 1, "thread.opened": 51, "comment.added": 51 }, { timeout: 600_000, message: "all 103 source events before the CLI reads" });
  const watcher = withToken(o, 1);
  const all = okJson(await cli(ctx, watcher, ["changes", id, "--since", "all", "--json"], { timeoutMs: 360_000 }), "changes across its 100-event boundary");
  const event = (e) => [e.type, e.threadId ?? null, e.commentId ?? null, e.at];
  assert.deepEqual(all.events.map(event), log.map((row) => event({ ...row.data, at: eventAt(row) })), "changes returns all 103 events in stored order across the default page boundary");
  assert.equal(new Set(all.events.map((e) => JSON.stringify(event(e)))).size, 103, "each event is returned once");
  assert.equal(all.more, false, "the combined feed has consumed its final page");
  const quiet = okJson(await cli(ctx, watcher, ["changes", id, "--since", all.cursor, "--json"]), "changes after its final combined cursor");
  assert.deepEqual({ events: quiet.events, cursor: quiet.cursor, more: quiet.more }, { events: [], cursor: all.cursor, more: false }, "the printed cursor resumes after every combined event");
});

scenario(NAMES.y, { tiers: LOCAL, needs: [patchCapability("a20-cli-no-retry-delay")], timeoutMs: 300_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const o = await ready("y", { docs: [{ body: page("Interval floor", ["A quiet document."]), title: `CLI floor ${tag()}`, name: "cli-floor" }] });
  o.home = cliHome(target);
  const id = o.docs[0].docId;
  await settleLog(target, id, { "version.published": 1 });
  const probe = ctx.mcp({ token: o.token, actor: "floor-setup", timeoutMs: REQUEST_MS });
  await probe.initialize();
  const head = await probe.ok("get_changes", { id, since: "all" });
  precondition(head.retryAfter === 0, "the local amplifier removes only the server retry delay");
  const r = await cli(ctx, o, ["changes", id, "--since", head.cursor, "--wait", "--interval", "1", "--timeout", "29", "--json"], { traceCalls: true, timeoutMs: 150_000 });
  const starts = r.calls.filter((e) => e.phase === "start" && e.tool === "get_changes");
  const end = r.calls.find((e) => e.phase === "body" && e.id === starts[0]?.id);
  precondition(starts.length > 0 && end, "the CLI's first get_changes has a complete transport trace");
  if (end.ms - starts[0].ms >= 27_000) ctx.inconclusive("the first response left too little of the 29-second deadline to distinguish a one-second regression");
  assert.equal(r.code, 3, "the 30-second floor exceeds this wait's remaining deadline");
  assert.equal(starts.length, 1, "--interval 1 never starts a second check when the 30-second floor cannot fit");
  assert.deepEqual({ events: r.json?.events, cursor: r.json?.cursor, timedOut: r.json?.timedOut }, { events: [], cursor: head.cursor, timedOut: true }, "the immediate timeout preserves its quiet cursor");
  ctx.ev.json("cli-interval-calls.json", r.calls);
});
