#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Idempotent document and version publishing from a bundle directory (SPEC §9).

/**
 * Usage:
 *   publish.mjs --doc <docId> [--dir <bundleDir>] [--entry index.html]
 *               [--owner <email>] [--viewers a@x.com,team:design]
 *               [--label <text>] [--title <text>] [--account <email>]
 *               [--project <id>] [--dry-run]
 *
 * Defaults: --dir is content/<docId>/bundle, and missing title/owner/viewers/
 * entry come from content/<docId>/manifest.json (flags override).
 *
 * IDEMPOTENT by content hash. Re-running with unchanged bytes prints
 * "already published as vN" and writes nothing, which is what makes this safe to
 * put in a loop, in CI, or in front of an agent that cannot remember what it
 * already did.
 *
 * This is an OPERATOR tool: it authenticates with Admin credentials and writes
 * Firestore and Storage directly. The end-user equivalent is the `bikeshed` CLI
 * in cli/, which authenticates with a personal access token over HTTPS. The
 * README says so plainly, because conflating the two is how somebody runs a
 * teardown against production.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import mime from "mime";
import { parse, splitList, fail } from "./lib/args.mjs";
import { assertUsableEmails } from "./lib/email.mjs";
import { hashBundle, hashBundleFiles } from "./lib/hash.mjs";
import { commitOperatorVersion, uploadOperatorBundle } from "./lib/operator-writes.mjs";
import { syncPresenceAccess } from "./lib/presence.mjs";
import {
  REPO_ROOT,
  FieldValue,
  getBucket,
  getBucketName,
  getDb,
  getProjectId,
} from "./lib/firebase.mjs";

const CLIENT = "bikeshed-scripts/0.1.0";

/**
 * Compile Markdown using THE renderer, not a second one.
 *
 * `functions/` is CommonJS and this script is ESM, but Node can import a
 * CommonJS module from ESM, so the CLI uses the exact build the server runs.
 * That is what keeps SPEC §11's "one implementation in one place" true across
 * the publish path — a second renderer here would silently produce different
 * bytes and therefore a different content hash, breaking idempotency between
 * the CLI and the app.
 */
async function loadRenderer() {
  const path = join(REPO_ROOT, "functions", "lib", "lib", "markdown", "render.js");
  if (!existsSync(path)) {
    fail(
      "Markdown support needs the compiled server renderer.\n" +
        "  Run: npm --prefix functions run build",
    );
  }
  return import(path);
}

/**
 * Read an HTML entry's own `<title>` using THE scanner, not a second one.
 *
 * Loaded lazily and only when the title default actually needs it — neither
 * `--title` nor the manifest supplies one, and the entry is HTML — so a
 * `--dry-run` over a manifest that already carries a title, which is every
 * sample bundle, still needs no `functions` build.
 */
async function loadHead() {
  const path = join(REPO_ROOT, "functions", "lib", "lib", "head.js");
  if (!existsSync(path)) {
    fail(
      "Title-from-<title> support needs the compiled server head scanner.\n" +
        "  Run: npm --prefix functions run build",
    );
  }
  return import(path);
}

async function main() {
const USAGE = `publish.mjs — publish a bundle directory as a new version

  node scripts/publish.mjs --doc <docId> [options]

  --doc <docId>        required
  --dir <path>         bundle directory (default: content/<docId>/bundle)
  --entry <file>       entry file (default: manifest, else index.html/index.md)
  --title <text>       document title (default: manifest)
  --owner <email>      owning account (default: manifest)
  --viewers <list>     comma-separated emails and team:<id> grants
  --label <text>       version label
  --account <email>    console identity, required for a real run
  --project <id>       Firebase project id (default: .firebaserc)
  --bucket <name>      content bucket (default: config/deploy.json)
  --dry-run            print what would be written, write nothing, need no
                       credentials
  --help

IDEMPOTENT by content hash: re-running with unchanged bytes prints
"already published as vN" and writes nothing, which is what makes this safe in a
loop, in CI, or in front of an agent that cannot remember what it already did.

This is an OPERATOR tool. The end-user equivalent is \`bikeshed publish\`.`;

  const { values } = parse({
    doc: { type: "string" },
    dir: { type: "string" },
    entry: { type: "string" },
    owner: { type: "string" },
    viewers: { type: "string" },
    label: { type: "string" },
    title: { type: "string" },
    account: { type: "string" },
    project: { type: "string" },
    bucket: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  }, { usage: USAGE });

  const dry = values["dry-run"];
  const docId = values.doc;
  if (!docId) fail("--doc <docId> is required");

  // Seeds the project-id cache from .firebaserc. Needs no credentials.
  getProjectId(values.project);

  const manifestPath = join(REPO_ROOT, "content", docId, "manifest.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : {};

  const dirArg = values.dir ?? join("content", docId, "bundle");
  const bundleDir = isAbsolute(dirArg) ? dirArg : join(REPO_ROOT, dirArg);

  const slug = manifest.slug ?? docId;
  const ownerRaw = values.owner ?? manifest.owner;
  if (!ownerRaw) fail("no owner: pass --owner or set `owner` in the manifest");
  const viewersRaw =
    values.viewers != null ? splitList(values.viewers) : (manifest.viewers ?? []);
  const editorsRaw = manifest.editors ?? [];

  // Validate before touching anything: a mistyped address should fail here, not
  // after the bytes are uploaded — and before the bundle is even read.
  const [ownerEmail] = assertUsableEmails([ownerRaw]);
  const viewers = [...new Set(viewersRaw.map(String))];
  const editors = [...new Set(editorsRaw.map(String))];
  for (const list of [viewers, editors]) {
    assertUsableEmails(list.filter((p) => !p.startsWith("team:")));
  }

  // Hash the authored bundle exactly as it sits on disk. The entry is resolved
  // here, before the title, because an HTML default title needs to know which
  // file to read.
  const authored = hashBundle(bundleDir);
  const entry = values.entry ?? manifest.entry ?? guessEntry(authored.files);

  // The default title is the explicit flag, else the manifest, else — for an
  // HTML entry — the document's own <title>, else the doc id.
  let title = values.title ?? manifest.title;
  if (title === undefined) {
    if (/\.(md|markdown)$/i.test(entry)) {
      title = docId;
    } else {
      const { titleFromHtml } = await loadHead();
      const entryFile = authored.files.find((f) => f.rel === entry);
      const html = entryFile ? readFileSync(entryFile.abs, "utf8") : "";
      title = titleFromHtml(html) ?? docId;
    }
  }

  // A Markdown bundle gains its compiled entry BEFORE hashing, so the stored
  // artifact and its hash describe the same thing the reader will see.
  let files = authored.files.map((f) => ({ rel: f.rel, data: readFileSync(f.abs) }));
  let storedEntry = entry;
  let sourceEntry;
  let format = "html";
  let rendererVersion;
  if (/\.(md|markdown)$/i.test(entry)) {
    const { renderMarkdown, titleFromMarkdown } = await loadRenderer();
    const source = files.find((f) => f.rel === entry);
    if (!source) fail(`entry not found in the bundle: ${entry}`);
    const markdown = source.data.toString("utf8");
    const rendered = renderMarkdown(markdown, {
      title: values.title ?? manifest.title ?? titleFromMarkdown(markdown, docId),
    });
    storedEntry = entry.replace(/\.(md|markdown)$/i, ".html");
    if (storedEntry === entry) storedEntry = "index.html";
    sourceEntry = entry;
    format = "markdown";
    rendererVersion = rendered.rendererVersion;
    files = files.filter((f) => f.rel !== storedEntry);
    files.push({ rel: storedEntry, data: Buffer.from(rendered.html, "utf8") });
  }

  const { contentHash, fileCount, bytes } = hashBundleFiles(files);
  const bucketName = getBucketName(values.project, values.bucket);

  console.log(`publish: doc=${docId} dir=${bundleDir}`);
  console.log(`  title=${title}`);
  console.log(`  entry=${storedEntry} format=${format} owner=${ownerEmail}`);
  console.log(`  viewers=[${viewers.join(", ")}] editors=[${editors.join(", ")}]`);
  console.log(`  files=${fileCount} bytes=${bytes} contentHash=${contentHash}`);

  if (dry) {
    console.log("  --dry-run: no Firestore or Storage writes.");
    console.log(`  would query docs/${docId}/versions for this contentHash; NO-OP if found.`);
    console.log("  otherwise would upload to a unique immutable bundle, then select version v{maxN+1} transactionally:");
    for (const f of files) {
      console.log(
        `    gs://${bucketName}/docs/${docId}/bundles/{attempt}/${f.rel}  (${mime.getType(f.rel) || "application/octet-stream"})`,
      );
    }
    console.log(`  would upsert docs/${docId} and move currentVersion.`);
    return;
  }

  const db = getDb(values.project);
  const bucket = getBucket(values.project, values.bucket);
  const docRef = db.collection("docs").doc(docId);
  const versionsRef = docRef.collection("versions");

  const dup = await versionsRef.where("contentHash", "==", contentHash).limit(1).get();
  if (!dup.empty) {
    console.log(`  already published as ${dup.docs[0].id} (contentHash match) — NO-OP.`);
    return;
  }

  // An operator publishes past pending suggestions: Admin credentials bypass
  // every endpoint and rule anyway, so a refusal here would be advice, not a
  // boundary. It is said out loud instead, because each one stays behind,
  // undecided, on a version nobody will read again (SPEC §6a, §9).
  const before = await docRef.get();
  const behind = before.exists ? before.data()?.currentVersion : null;
  if (typeof behind === "string" && behind) {
    const pending = await versionsRef
      .doc(behind)
      .collection("annotations")
      .where("suggestion.state", "==", "pending")
      .count()
      .get();
    const n = pending.data().count;
    if (n > 0) {
      console.warn(
        `  warning: ${n} pending suggestion(s) on ${behind} stay behind on it, undecided.`,
      );
    }
  }

  console.log(`  uploading ${fileCount} file(s) into an immutable attempt bundle ...`);
  const storagePrefix = await uploadOperatorBundle(bucket, docId, files);

  const actor = {
    uid: null,
    email: values.account ?? before.data()?.ownerEmail ?? ownerEmail,
    channel: "cli",
    client: CLIENT,
  };
  const result = await commitOperatorVersion(db, docRef, {
    existed: before.exists,
    baseVersion: before.data()?.currentVersion ?? null,
    ownerEmail, title, slug, viewers, editors,
    label: values.label ?? manifest.label,
    version: {
      entry: storedEntry, format,
      ...(sourceEntry ? { sourceEntry } : {}),
      ...(rendererVersion ? { rendererVersion } : {}),
      storagePrefix, fileCount, bytes, contentHash, files: files.map((f) => f.rel),
      publishedVia: "cli", publishedByEmail: actor.email, publishedBy: actor,
    },
  }, FieldValue.serverTimestamp());
  if (result.duplicate) {
    console.log(`  already published as ${result.versionId} (contentHash match) — NO-OP.`);
    return;
  }
  await syncPresenceAccess(docId, result.membership.members, result.membership.editorMembers, values.project);
  console.log(`  published ${docId} ${result.versionId} (currentVersion=${result.versionId}, ${result.existed ? "updated" : "created"}).`);

}

/** Pick the entry when neither a flag nor the manifest names one. */
function guessEntry(files) {
  const names = files.map((f) => f.rel);
  if (names.includes("index.html")) return "index.html";
  if (names.includes("index.md")) return "index.md";
  const html = names.filter((n) => /\.html?$/i.test(n));
  if (html.length === 1) return html[0];
  const md = names.filter((n) => /\.(md|markdown)$/i.test(n));
  if (md.length === 1) return md[0];
  return "index.html";
}

main().catch((err) => fail(err.message || String(err)));
