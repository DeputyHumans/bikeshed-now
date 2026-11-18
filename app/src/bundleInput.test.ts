// SPDX-License-Identifier: Apache-2.0
// The browser plans an upload by the deployment's own rules, so what it says is what then happens (SPEC §2).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  combine, describeLeftOut, formatBytes, isLeftOut, pickFromInput, planNew, planVersion, resolveEntry, stripCommonFolder,
  type BaseFiles, type Pick,
} from "./bundleInput";

const RULES = JSON.parse(readFileSync(join(__dirname, "..", "..", "functions", "test", "fixtures", "bundle-rules.json"), "utf8"));
const file = (name: string, size = 1) => new File(["x".repeat(size)], name);
const loose = (...names: string[]): Pick => ({ files: names.map((n) => ({ path: n, file: file(n) })), leftOut: [], folder: null, fromFolder: false });
const folder = (name: string, paths: string[]): Pick => ({ files: paths.map((p) => ({ path: `${name}/${p}`, file: file(p) })), leftOut: [], folder: name, fromFolder: true });
const BASE: BaseFiles = { files: ["index.html", "img/chart.png", "style.css"], entry: "index.html", format: "html" };

describe("the deployment's rules, held to the shared table", () => {
  it("leaves out what the server leaves out", () => {
    for (const rel of RULES.leftOut.kept) expect(isLeftOut(rel), rel).toBe(false);
    for (const rel of RULES.leftOut.out) expect(isLeftOut(rel), rel).toBe(true);
  });

  it("strips one shared folder and opens the page the server opens", () => {
    for (const c of RULES.entries) {
      const stripped = stripCommonFolder(c.files);
      if (c.stripped) expect(stripped, c.files.join(",")).toEqual(c.stripped);
      expect(resolveEntry(stripped), c.files.join(",")).toBe(c.entry);
    }
  });
});

describe("planning a new document", () => {
  it("a folder is one document, opened by its page, sent at the paths inside it", () => {
    const plan = planNew(folder("Q3 review", ["index.html", "img/a.png"]));
    expect(plan).toMatchObject({ action: "bundle", name: "Q3 review", entry: "index.html", problems: [] });
    expect(plan.action === "bundle" && plan.files.map((f) => f.path)).toEqual(["index.html", "img/a.png"]);
  });

  it("a page alone or a zip goes up as it is", () => {
    expect(planNew(loose("notes.md")).action).toBe("page");
    expect(planNew(loose("site.zip")).action).toBe("zip");
  });

  it("refuses, in words, what the deployment would refuse", () => {
    expect(planNew(loose("chart.png")).problems[0]).toMatch(/isn’t a page/);
    expect(planNew(folder("x", ["img/a.png"])).problems[0]).toMatch(/There’s no page to open/);
    const big: Pick = { files: [{ path: "index.html", file: file("index.html", 26 * 1024 * 1024) }, { path: "a.css", file: file("a.css") }], leftOut: [], folder: null, fromFolder: false };
    expect(planNew(big).problems[0]).toMatch(/comes to 26 MB\. A document can be up to 25 MB/);
    const deep = folder("x", ["index.html", `${"d".repeat(260)}.png`]);
    expect(planNew(deep).problems[0]).toMatch(/The path d+… is too long/);
  });
});

describe("planning the next version", () => {
  it("a page replaces the page and keeps the rest; a page of the other kind is refused", () => {
    expect(planVersion(loose("draft.html"), BASE)).toMatchObject({ action: "page", keeps: 2, problems: [] });
    expect(planVersion(loose("draft.md"), BASE).problems[0]).toBe("This document is HTML, so its page has to be HTML too.");
  });

  it("loose files replace the one file of their name, or are added", () => {
    const plan = planVersion(loose("chart.png", "logo.svg", "index.html"), BASE);
    expect(plan.action === "merge" && plan.files.map((p) => [p.sent.path, p.at, p.does])).toEqual([
      ["chart.png", "img/chart.png", "replaces"],
      ["logo.svg", "logo.svg", "adds"],
      ["index.html", "index.html", "replaces the page"],
    ]);
  });

  it("a Markdown document's HTML is made, so it cannot be replaced on its own", () => {
    const md: BaseFiles = { files: ["index.md", "index.html", "a.png"], entry: "index.html", sourceEntry: "index.md", format: "markdown" };
    expect(planVersion(loose("index.html", "a.png"), md).problems[0]).toMatch(/made from the Markdown/);
  });

  it("a folder is the whole next version, and names what it drops", () => {
    const plan = planVersion(folder("site", ["index.html", "style.css"]), BASE);
    expect(plan).toMatchObject({ action: "bundle", drops: ["img/chart.png"] });
  });
});

describe("reading a pick", () => {
  it("a chosen folder keeps paths inside it and reports what it left out once per folder", () => {
    const files = ["site/index.html", "site/.git/config", "site/.git/HEAD", "site/node_modules/a/b.js", "site/img/a.png"].map((p) => {
      const f = file(p.split("/").pop()!);
      Object.defineProperty(f, "webkitRelativePath", { value: p });
      return f;
    });
    const pick = pickFromInput(files);
    expect(pick.fromFolder).toBe(true);
    expect(pick.folder).toBe("site");
    expect(pick.files.map((f) => f.path)).toEqual(["site/index.html", "site/img/a.png"]);
    expect(pick.leftOut.sort()).toEqual(["site/.git/", "site/node_modules/"]);
    expect(describeLeftOut(pick.leftOut)).toBe("Left out: site/.git/ and site/node_modules/. Hidden files and node_modules never go into a document.");
  });

  it("several items dropped together are one pick", () => {
    expect(combine([loose("a.html"), folder("img", ["a.png"])]).files.map((f) => f.path)).toEqual(["a.html", "img/a.png"]);
  });

  it("sizes read as a person reads them", () => {
    expect(formatBytes(12)).toBe("12 bytes");
    expect(formatBytes(204800)).toBe("200 KB");
    expect(formatBytes(41.2 * 1024 * 1024)).toBe("41.2 MB");
  });
});
