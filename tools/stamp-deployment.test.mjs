// SPDX-License-Identifier: Apache-2.0
// The deployment stamp: what it substitutes, and what it refuses to (SPEC §19).

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  TOKEN,
  checkDist,
  deploymentStamp,
  normalizeOrigin,
  packSkills,
  pluginArchive,
  resolveOrigin,
  servedDocuments,
  skillArchives,
  stamp,
  stampDist,
} from "./stamp-deployment.mjs";
import { readStoredZip, storedZip } from "./zip.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A throwaway `dist` holding every document a deployment serves, and the skill
 * archives an unconfigured build packs from them.
 */
function fakeDist(body = `see ${TOKEN}/d/x`) {
  const base = mkdtempSync(join(tmpdir(), "bikeshed-stamp-"));
  const dist = join(base, "dist");
  for (const rel of servedDocuments()) {
    const path = join(dist, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  packSkills(dist);
  return { base, dist };
}

// --- The two configuration shapes reconcile -------------------------------

test("a bare domain and a full origin normalize to the same thing", () => {
  // config/deploy.json holds `example.com`; BIKESHED_PUBLIC_ORIGIN holds the
  // origin. If these disagreed, one of the two sources would emit either
  // `https://https://host` or a scheme-less `host/mcp`.
  assert.equal(normalizeOrigin("example.com"), "https://example.com");
  assert.equal(normalizeOrigin("https://example.com"), "https://example.com");
  assert.equal(normalizeOrigin("https://example.com/"), "https://example.com");
  assert.equal(normalizeOrigin("  https://example.com///  "), "https://example.com");
});

test("an emulator origin keeps its scheme and port", () => {
  assert.equal(normalizeOrigin("http://127.0.0.1:5050"), "http://127.0.0.1:5050");
});

test("nothing configured is not an error", () => {
  assert.equal(normalizeOrigin(""), "");
  assert.equal(normalizeOrigin("   "), "");
  assert.equal(normalizeOrigin(undefined), "");
});

test("the placeholder pasted into the variable is diagnosed as such", () => {
  // Someone copies `https://<deployment>` out of the guide into their shell.
  // Without this the failure surfaces much later, as "a placeholder survived".
  assert.throws(
    () => normalizeOrigin("https://<deployment>"),
    /that is the placeholder/,
  );
});

test("a value that is set but not an origin is refused, not passed through", () => {
  // Each of these would otherwise be spliced in front of `/d/<id>`.
  for (const bad of [
    "https://example.com/app",
    "https://example.com?x=1",
    "https://user:pw@example.com",
    "https://example.com/#frag",
  ]) {
    assert.throws(() => normalizeOrigin(bad), /scheme and a host/, bad);
  }
});

// --- Resolution order ------------------------------------------------------

test("the environment outranks config/deploy.json, which outranks nothing", () => {
  const base = mkdtempSync(join(tmpdir(), "bikeshed-root-"));
  mkdirSync(join(base, "config"));
  writeFileSync(join(base, "config", "deploy.json"), JSON.stringify({ domain: "file.example" }));

  assert.deepEqual(resolveOrigin({ BIKESHED_PUBLIC_ORIGIN: "https://env.example" }, base), {
    origin: "https://env.example",
    source: "BIKESHED_PUBLIC_ORIGIN",
  });
  assert.deepEqual(resolveOrigin({}, base), {
    origin: "https://file.example",
    source: "config/deploy.json",
  });
  rmSync(base, { recursive: true, force: true });

  const empty = mkdtempSync(join(tmpdir(), "bikeshed-root-"));
  assert.deepEqual(resolveOrigin({}, empty), { origin: "", source: "" });
  rmSync(empty, { recursive: true, force: true });
});

// --- Substitution ----------------------------------------------------------

test("every occurrence is replaced, not just the first", () => {
  const text = `a ${TOKEN}/mcp b ${TOKEN}/d/x c ${TOKEN}`;
  assert.equal(
    stamp(text, "https://h.example"),
    "a https://h.example/mcp b https://h.example/d/x c https://h.example",
  );
});

test("no origin leaves the text byte-identical", () => {
  const text = `POST ${TOKEN}/mcp`;
  assert.equal(stamp(text, ""), text);
});

test("a $ sequence in the origin is not expanded", () => {
  // The reason this codebase splices with split/join instead of
  // String.replace: a replacement STRING expands $&, $`, $' and $1 inside it.
  const text = `POST ${TOKEN}/mcp`;
  assert.equal(stamp(text, "https://a$&b.example"), "POST https://a$&b.example/mcp");
  assert.equal(stamp(text, "https://a$'b.example"), "POST https://a$'b.example/mcp");
});

test("a placeholder written without the scheme fails the build", () => {
  assert.throws(
    () => stamp("open <deployment>/d/x", "https://h.example"),
    /survived the stamp/,
  );
});

// --- What gets stamped -----------------------------------------------------

test("every skill in the tree is a document that gets stamped", async () => {
  const { readSkills } = await import("./build-agents.mjs");
  const served = servedDocuments();
  assert.ok(served.includes("llms.txt"));
  for (const skill of readSkills()) {
    assert.ok(
      served.includes(`skills/${skill.name}/SKILL.md`),
      `${skill.name} is served but would never be stamped`,
    );
  }
  assert.ok(served.includes("skills/index.json"));
  assert.ok(served.includes("robots.txt"));
  assert.equal(served.length, readSkills().length + 3);
});

test("every generated file under app/public is one the stamp knows about", () => {
  // The derived list is only as good as its coverage. This compares it against
  // what `build-agents.mjs` actually wrote, so a NEW kind of served document —
  // not just a new skill — cannot appear and go unstamped.
  const publicDir = join(ROOT, "app", "public");
  const generated = ["llms.txt", "robots.txt"];
  const walk = (rel) => {
    for (const entry of readdirSync(join(publicDir, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else generated.push(next);
    }
  };
  walk("skills");
  assert.deepEqual(generated.sort(), [...servedDocuments()].sort());
});

test("the documents a build takes still carry the token", () => {
  // A reword that drops it would make the stamp a no-op with nothing failing.
  const guide = readFileSync(join(ROOT, "docs", "agents", "agent-guide.md"), "utf8");
  const skill = readFileSync(
    join(ROOT, "app", "public", "skills", "bs-publish", "SKILL.md"),
    "utf8",
  );
  assert.ok(guide.split(TOKEN).length - 1 >= 4, "the guide stopped naming <deployment>");
  assert.ok(skill.split(TOKEN).length - 1 >= 3, "the publishing skill stopped naming <deployment>");
});

// --- Writing ---------------------------------------------------------------

test("stamping a dist rewrites every served document, both directions", () => {
  const { base, dist } = fakeDist();
  const { files, total } = stampDist(dist, "https://h.example");

  assert.equal(total, files.length, "one occurrence per fixture file");
  for (const { path } of files) {
    const text = readFileSync(join(dist, path), "utf8");
    assert.equal(text.includes("<deployment>"), false, `${path} still names <deployment>`);
    assert.equal(text.includes("https://h.example"), true, `${path} does not name the origin`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("the tree is never a legal target", () => {
  // `app/public` is tracked. Writing a real host there would put a deployment
  // binding into git, and check-secrets matches by SHAPE — a custom domain has
  // none, so nothing downstream would catch it.
  //
  // Deliberately an EMPTY temp directory called `public`, never the real one:
  // a test whose negative control is "delete the guard" must not be able to
  // damage the tree when somebody runs that control. It did, once.
  const base = mkdtempSync(join(tmpdir(), "bikeshed-stamp-"));
  const pub = join(base, "public");
  mkdirSync(pub);
  assert.throws(
    () => stampDist(pub, "https://h.example"),
    /refusing to stamp outside a build output/,
  );
  rmSync(base, { recursive: true, force: true });
});

test("a dist missing the documents is a build failure, not a skip", () => {
  const base = mkdtempSync(join(tmpdir(), "bikeshed-stamp-"));
  const dist = join(base, "dist");
  mkdirSync(dist);
  assert.throws(() => stampDist(dist, "https://h.example"), /did not copy app\/public/);
  rmSync(base, { recursive: true, force: true });
});

// --- The deploy gate -------------------------------------------------------

test("the check passes a stamped dist and fails an unstamped one", () => {
  const env = { BIKESHED_PUBLIC_ORIGIN: "https://h.example" };

  const stamped = fakeDist();
  stampDist(stamped.dist, "https://h.example");
  assert.equal(checkDist(stamped.dist, env, ROOT).ok, true);
  rmSync(stamped.base, { recursive: true, force: true });

  const raw = fakeDist();
  const result = checkDist(raw.dist, env, ROOT);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unstamped, servedDocuments());
  // Packed from the unstamped text it sits beside, so the archives are not
  // what is wrong here, and are not reported as if they were.
  assert.deepEqual(result.archives, []);
  rmSync(raw.base, { recursive: true, force: true });
});

test("an archive packed before the stamp fails the check", () => {
  // What a packer in a plugin of its own would produce: Rollup runs separate
  // plugins' writeBundle hooks in parallel, so it could zip SKILL.md before the
  // stamp rewrote it. Every served document names the origin, so only the
  // archives can be what the check refuses.
  const env = { BIKESHED_PUBLIC_ORIGIN: "https://h.example" };
  const { base, dist } = fakeDist();
  for (const rel of servedDocuments()) {
    const path = join(dist, rel);
    writeFileSync(path, stamp(readFileSync(path, "utf8"), "https://h.example"));
  }

  const result = checkDist(dist, env, ROOT);
  assert.deepEqual(result.unstamped, []);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.archives,
    [...skillArchives().map((a) => a.path), pluginArchive().path],
  );
  // And the archive really does still hold the placeholder the check caught.
  const [, file] = readStoredZip(readFileSync(join(dist, skillArchives()[0].path)));
  assert.equal(file.data.toString("utf8").includes("<deployment>"), true);

  // Re-stamping re-packs, which is the only route to an archive the check passes.
  stampDist(dist, "https://h.example");
  assert.equal(checkDist(dist, env, ROOT).ok, true);
  rmSync(base, { recursive: true, force: true });
});

test("an archive holding anything but its folder and SKILL.md fails the check", () => {
  const { base, dist } = fakeDist();
  const empty = mkdtempSync(join(tmpdir(), "bikeshed-root-"));
  const [first] = skillArchives();
  writeFileSync(join(dist, first.path), "not a zip");
  assert.deepEqual(checkDist(dist, {}, empty).archives, [first.path]);
  rmSync(base, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test("a deployment with no origin configured deploys its placeholders", () => {
  const raw = fakeDist();
  const empty = mkdtempSync(join(tmpdir(), "bikeshed-root-"));
  assert.equal(checkDist(raw.dist, {}, empty).ok, true);
  rmSync(raw.base, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test("no origin still packs, and a missing zip fails the check", () => {
  // A deployment with no custom domain still offers the downloads; skipping
  // the pack along with the stamp would serve the SPA's HTML at /skills/*.zip.
  const base = mkdtempSync(join(tmpdir(), "bikeshed-stamp-"));
  const dist = join(base, "dist");
  for (const rel of servedDocuments()) {
    mkdirSync(dirname(join(dist, rel)), { recursive: true });
    writeFileSync(join(dist, rel), `see ${TOKEN}/d/x`);
  }
  const empty = mkdtempSync(join(tmpdir(), "bikeshed-root-"));
  const plugin = deploymentStamp({
    env: {},
    root: empty,
    log: { log: () => {}, warn: () => {} },
  });
  plugin.configResolved({ root: base, build: { outDir: "dist" } });
  plugin.writeBundle();

  const archives = skillArchives();
  assert.ok(archives.length > 0, "there are no skills to pack");
  for (const { path } of archives) {
    assert.equal(existsSync(join(dist, path)), true, `${path} was not packed`);
  }
  assert.deepEqual(checkDist(dist, {}, empty), {
    ok: true,
    origin: "",
    source: "",
    unstamped: [],
    archives: [],
  });

  rmSync(join(dist, archives[0].path));
  const result = checkDist(dist, {}, empty);
  assert.equal(result.ok, false);
  assert.deepEqual(result.archives, [archives[0].path]);
  rmSync(base, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test("every archive in index.json exists in dist", () => {
  // The index is what tells a person (and the CLI) where the download is; the
  // pack is what puts one there. Two derivations of one path, held together.
  const index = JSON.parse(readFileSync(join(ROOT, "app", "public", "skills", "index.json"), "utf8"));
  const { base, dist } = fakeDist();
  const listed = index.skills.map((s) => s.archive);
  assert.deepEqual(listed, index.skills.map((s) => `skills/${s.name}.zip`));
  for (const archive of listed) {
    assert.equal(existsSync(join(dist, archive)), true, `index.json lists ${archive}, which is never packed`);
  }
  const packed = readdirSync(join(dist, "skills"))
    .filter((f) => f.endsWith(".zip"))
    .map((f) => `skills/${f}`);
  assert.deepEqual(packed.sort(), [...listed, index.plugin].sort());
  rmSync(base, { recursive: true, force: true });
});

// --- The one download ------------------------------------------------------

/** A stamped dist, and the plugin archive it packed, read back. */
function stampedPlugin() {
  const { base, dist } = fakeDist();
  stampDist(dist, "https://h.example");
  const { path } = pluginArchive();
  return { base, dist, path, entries: readStoredZip(readFileSync(join(dist, path))) };
}

test("the plugin zip holds the manifest and every skill, and nothing else", () => {
  const { base, entries } = stampedPlugin();
  const skills = skillArchives().map((a) => a.name);
  assert.ok(skills.length > 0, "there are no skills");
  assert.deepEqual(entries.map((e) => e.name), [
    ".claude-plugin/",
    ".claude-plugin/plugin.json",
    "skills/",
    ...skills.flatMap((name) => [`skills/${name}/`, `skills/${name}/SKILL.md`]),
  ]);
  rmSync(base, { recursive: true, force: true });
});

test("the plugin zip's manifest is the tracked one, and its skills are the stamped ones", () => {
  const { base, dist, entries } = stampedPlugin();
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  assert.ok(
    byName.get(".claude-plugin/plugin.json").equals(readFileSync(join(ROOT, "claude-plugin", ".claude-plugin", "plugin.json"))),
    "the manifest differs from the tracked one",
  );
  for (const { name } of skillArchives()) {
    const served = readFileSync(join(dist, "skills", name, "SKILL.md"));
    assert.ok(byName.get(`skills/${name}/SKILL.md`).equals(served), `${name} differs from the served file`);
    assert.equal(served.toString("utf8").includes("<deployment>"), false, `${name} was not stamped`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("a repeated build packs the same plugin zip, byte for byte", () => {
  // A rebuild that looks like a change would be read as one.
  const { base, dist, path } = stampedPlugin();
  const first = readFileSync(join(dist, path));
  packSkills(dist);
  assert.ok(readFileSync(join(dist, path)).equals(first));
  rmSync(base, { recursive: true, force: true });
});

/** Rewrite one entry of the packed plugin zip, or drop it when `data` is null. */
function tamper(dist, path, entryName, data) {
  const entries = readStoredZip(readFileSync(join(dist, path)))
    .filter((e) => data !== null || e.name !== entryName)
    .map((e) => (e.name === entryName ? { name: e.name, data } : e.name.endsWith("/") ? { name: e.name } : e));
  writeFileSync(join(dist, path), storedZip(entries));
}

test("the gate refuses a plugin zip missing a skill", () => {
  const env = { BIKESHED_PUBLIC_ORIGIN: "https://h.example" };
  const { base, dist, path } = stampedPlugin();
  assert.deepEqual(checkDist(dist, env, ROOT).archives, []);
  tamper(dist, path, `skills/${skillArchives()[0].name}/SKILL.md`, null);
  assert.deepEqual(checkDist(dist, env, ROOT).archives, [path]);
  rmSync(base, { recursive: true, force: true });
});

test("the gate refuses a plugin zip whose skill differs from the served file by one byte", () => {
  const env = { BIKESHED_PUBLIC_ORIGIN: "https://h.example" };
  const { base, dist, path } = stampedPlugin();
  const name = `skills/${skillArchives()[0].name}/SKILL.md`;
  const held = readStoredZip(readFileSync(join(dist, path))).find((e) => e.name === name).data;
  tamper(dist, path, name, Buffer.concat([held, Buffer.from(" ")]));
  assert.deepEqual(checkDist(dist, env, ROOT).archives, [path]);
  rmSync(base, { recursive: true, force: true });
});

test("the gate refuses a plugin zip whose manifest is not the tracked one", () => {
  const env = { BIKESHED_PUBLIC_ORIGIN: "https://h.example" };
  const { base, dist, path } = stampedPlugin();
  tamper(dist, path, ".claude-plugin/plugin.json", Buffer.from("{}"));
  assert.deepEqual(checkDist(dist, env, ROOT).archives, [path]);
  rmSync(base, { recursive: true, force: true });
});

test("the gate refuses a missing plugin zip", () => {
  const env = { BIKESHED_PUBLIC_ORIGIN: "https://h.example" };
  const { base, dist, path } = stampedPlugin();
  rmSync(join(dist, path));
  assert.deepEqual(checkDist(dist, env, ROOT).archives, [path]);
  rmSync(base, { recursive: true, force: true });
});

test("the plugin zip's name cannot be taken by a skill's", () => {
  assert.equal(skillArchives().some((a) => a.path === pluginArchive().path), false);
});

// --- Wiring ----------------------------------------------------------------

test("the stamp does not import build-agents.mjs", () => {
  // Vite bundles app/vite.config.ts and everything it imports, injecting a
  // preamble at the head of each file. That pushes build-agents.mjs's shebang
  // off line 1 and the app build dies with `Syntax error "!"` — a failure no
  // unit test can see, because it happens in the config loader.
  const source = readFileSync(join(ROOT, "tools", "stamp-deployment.mjs"), "utf8");
  assert.equal(
    /^\s*import .* from "\.\/build-agents\.mjs"/m.test(source),
    false,
    "importing build-agents.mjs here breaks `npm --prefix app run build`",
  );
});

test("the plugin only ever runs during a build", () => {
  // Vitest and the dev server both resolve as "serve", and Vite drops a plugin
  // whose `apply` does not match the command. Without this the hook would fire
  // on every test teardown, against an app/dist that need not exist.
  const plugin = deploymentStamp();
  assert.equal(plugin.name, "bikeshed-stamp-deployment");
  assert.equal(plugin.apply, "build");
  assert.equal(typeof plugin.writeBundle, "function");
});

test("the app build registers the plugin", () => {
  const config = readFileSync(join(ROOT, "app", "vite.config.ts"), "utf8");
  assert.match(config, /from "\.\.\/tools\/stamp-deployment\.mjs"/);
  assert.match(config, /plugins:\s*\[[^\]]*deploymentStamp\(\)/);
});

test("driving the plugin stamps the output directory", () => {
  const { base, dist } = fakeDist();
  const lines = [];
  const plugin = deploymentStamp({
    env: { BIKESHED_PUBLIC_ORIGIN: "https://driven.example" },
    root: ROOT,
    log: { log: (m) => lines.push(m), warn: (m) => lines.push(m) },
  });
  plugin.configResolved({ root: base, build: { outDir: "dist" } });
  plugin.writeBundle();

  assert.equal(readFileSync(join(dist, "llms.txt"), "utf8").includes("https://driven.example"), true);
  // The log names both the origin and where it came from: an operator staring
  // at the wrong address needs to know which of two files to edit.
  assert.match(lines[0], /https:\/\/driven\.example/);
  assert.match(lines[0], /BIKESHED_PUBLIC_ORIGIN/);
  rmSync(base, { recursive: true, force: true });
});

test("an unconfigured build warns and stamps nothing", () => {
  const { base, dist } = fakeDist();
  const before = readFileSync(join(dist, "llms.txt"), "utf8");
  const empty = mkdtempSync(join(tmpdir(), "bikeshed-root-"));
  const lines = [];
  const plugin = deploymentStamp({
    env: {},
    root: empty,
    log: { log: (m) => lines.push(["log", m]), warn: (m) => lines.push(["warn", m]) },
  });
  plugin.configResolved({ root: base, build: { outDir: "dist" } });
  plugin.writeBundle();

  assert.equal(readFileSync(join(dist, "llms.txt"), "utf8"), before);
  assert.equal(lines[0][0], "warn");
  // Names both remedies, because the reader has configured neither.
  assert.match(lines[0][1], /config\/deploy\.json/);
  assert.match(lines[0][1], /BIKESHED_PUBLIC_ORIGIN/);
  rmSync(base, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});
