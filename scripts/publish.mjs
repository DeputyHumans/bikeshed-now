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
import { computeMembership, loadFolderMembership, loadTeamIndex } from "./lib/membership.mjs";
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

async function main() {
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
  });

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

  const title = values.title ?? manifest.title ?? docId;
  const slug = manifest.slug ?? docId;
  const ownerRaw = values.owner ?? manifest.owner;
  if (!ownerRaw) fail("no owner: pass --owner or set `owner` in the manifest");
  const viewersRaw =
    values.viewers != null ? splitList(values.viewers) : (manifest.viewers ?? []);
  const editorsRaw = manifest.editors ?? [];

  // Validate before touching anything: a mistyped address should fail here, not
  // after the bytes are uploaded.
  const [ownerEmail] = assertUsableEmails([ownerRaw]);
  const viewers = [...new Set(viewersRaw.map(String))];
  const editors = [...new Set(editorsRaw.map(String))];
  for (const list of [viewers, editors]) {
    assertUsableEmails(list.filter((p) => !p.startsWith("team:")));
  }

  // Hash the authored bundle exactly as it sits on disk.
  const authored = hashBundle(bundleDir);
  const entry = values.entry ?? manifest.entry ?? guessEntry(authored.files);

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
  console.log(`  entry=${storedEntry} format=${format} owner=${ownerEmail}`);
  console.log(`  viewers=[${viewers.join(", ")}] editors=[${editors.join(", ")}]`);
  console.log(`  files=${fileCount} bytes=${bytes} contentHash=${contentHash}`);

  if (dry) {
    console.log("  --dry-run: no Firestore or Storage writes.");
    console.log(`  would query docs/${docId}/versions for this contentHash; NO-OP if found.`);
    console.log("  otherwise would upload (target version v{maxN+1}):");
    for (const f of files) {
      console.log(
        `    gs://${bucketName}/docs/${docId}/v{N}/${f.rel}  (${mime.getType(f.rel) || "application/octet-stream"})`,
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

  const allVersions = await versionsRef.get();
  let maxN = 0;
  for (const d of allVersions.docs) {
    const m = /^v(\d+)$/.exec(d.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const versionId = `v${maxN + 1}`;
  const storagePrefix = `docs/${docId}/${versionId}`;

  console.log(`  uploading ${fileCount} file(s) to gs://${bucketName}/${storagePrefix}/ ...`);
  for (const f of files) {
    const destination = `${storagePrefix}/${f.rel}`;
    const contentType = mime.getType(f.rel) || "application/octet-stream";
    await bucket.file(destination).save(f.data, { contentType, resumable: false });
    console.log(`    + ${destination} (${contentType})`);
  }

  const snap = await docRef.get();
  const existing = snap.exists ? (snap.data() ?? {}) : {};
  const mergedViewers = [...new Set([...(existing.viewers ?? []), ...viewers])].sort();
  const mergedEditors = [...new Set([...(existing.editors ?? []), ...editors])].sort();
  const ownerForMembers = existing.ownerEmail ?? ownerEmail;
  const folderId = existing.folderId ?? null;

  // Effective membership, computed through the SAME function the server uses.
  // The original of this design recomputed members here without the parent
  // folder's, so publishing into a shared folder silently revoked every
  // inherited reader.
  const parent = await loadFolderMembership(db, folderId);
  const teams = await loadTeamIndex(db, mergedViewers, mergedEditors);
  const membership = computeMembership(
    ownerForMembers,
    mergedViewers,
    mergedEditors,
    parent,
    teams,
  );

  const actor = {
    // Null because an operator script authenticates with Admin credentials, not
    // as an account. `channel: "cli"` with no tokenId is what identifies it.
    uid: null,
    email: values.account ?? ownerForMembers,
    channel: "cli",
    client: CLIENT,
  };

  const batch = db.batch();
  batch.set(
    docRef,
    {
      docId,
      title,
      slug,
      ...(snap.exists ? {} : { ownerUid: null, ownerEmail, createdAt: FieldValue.serverTimestamp() }),
      ...(snap.exists ? {} : { visibility: "private", publicEdit: false, folderId: null }),
      viewers: mergedViewers,
      editors: mergedEditors,
      members: membership.members,
      editorMembers: membership.editorMembers,
      currentVersion: versionId,
      // CLI provenance: the publisher is authenticated and deliberate, so the
      // bundle's own scripts run un-sandboxed. Browser uploads are the opposite
      // case and are created trusted:false (SPEC §6c).
      trusted: true,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  batch.set(versionsRef.doc(versionId), {
    versionId,
    label: values.label ?? manifest.label ?? versionId,
    entry: storedEntry,
    format,
    ...(sourceEntry ? { sourceEntry } : {}),
    ...(rendererVersion ? { rendererVersion } : {}),
    storagePrefix,
    fileCount,
    bytes,
    contentHash,
    files: files.map((f) => f.rel),
    parentVersion: maxN > 0 ? `v${maxN}` : null,
    publishedVia: "cli",
    publishedByEmail: actor.email,
    publishedBy: actor,
    publishedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  // Presence reads are gated by a mirror of `members` in RTDB, so every path
  // that recomputes membership has to refresh it — including this one.
  await syncPresenceAccess(docId, membership.members, values.project);

  console.log(
    `  published ${docId} ${versionId} (currentVersion=${versionId}, ${snap.exists ? "updated" : "created"}).`,
  );
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
