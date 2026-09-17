// SPDX-License-Identifier: Apache-2.0
// Downloads go through the gated paths, with sane filenames (SPEC §2, §11).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadEntry, downloadSource, downloadZip } from "./html";

function anchors(): HTMLAnchorElement[] {
  return clicked;
}

let clicked: HTMLAnchorElement[] = [];

describe("downloads", () => {
  beforeEach(() => {
    clicked = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => {},
    });
    // Capture the anchor instead of letting jsdom try to navigate, which it
    // cannot do and would log as an unimplemented feature on every test.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the entry through the gated content path", async () => {
    const fetchMock = vi.fn(async () => new Response("<p>x</p>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await downloadEntry("d1", "v2", "index.html", "Q3 Memo");
    expect(fetchMock).toHaveBeenCalledWith("/content/d1/v2/index.html", {
      credentials: "same-origin",
    });
    expect(anchors()[0].download).toBe("Q3-Memo.html");
  });

  it("names the Markdown source by its own extension", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# x", { status: 200 })));
    await downloadSource("d1", "v2", "index.md", "Q3 Memo");
    expect(anchors()[0].download).toBe("Q3-Memo.md");
  });

  it("sanitizes a hostile title into a filename", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200 })));
    await downloadEntry("d1", "v2", "index.html", "../../etc/passwd");
    // No separators survive, and no leading dots: a file called "..-..-etc"
    // is hidden on Unix and tells the reader nothing.
    expect(anchors()[0].download).toBe("etc-passwd.html");
    expect(anchors()[0].download).not.toContain("/");
  });

  it("falls back to a usable name when the title sanitizes away entirely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200 })));
    await downloadEntry("d1", "v2", "index.html", "///");
    expect(anchors()[0].download).toBe("document.html");
  });

  it("explains an expired session rather than failing silently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    await expect(downloadEntry("d1", "v2", "index.html", "x")).rejects.toThrow(
      /session expired/i,
    );
  });

  it("sends a multi-file bundle through the server, not the browser", () => {
    // Assembling a zip client-side would mean a zip library, and the app ships
    // with none by design.
    downloadZip("d1", "v2");
    expect(anchors()[0].getAttribute("href")).toBe("/download/d1/v2");
    expect(anchors()[0].rel).toBe("noopener");
  });
});

describe("download failures", () => {
  beforeEach(() => {
    clicked = [];
  });

  it("reports the status when the fetch fails for another reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(downloadEntry("d1", "v2", "index.html", "x")).rejects.toThrow(/500/);
  });
});
