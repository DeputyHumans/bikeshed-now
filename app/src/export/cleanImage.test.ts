// SPDX-License-Identifier: Apache-2.0
// Image snapshots remove decoration before layout without changing the reader's document (SPEC §20).

import { expect, it } from "vitest";
import { imageSnapshot } from "./cleanImage";

it("keeps authored style and ancestors but removes reader marks before computing image styles", () => {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><head>
    <style>.paper section { color: green; width: 420px } mark.bshd-hl { color: red }</style>
    </head><body><main class="paper"><section id="chosen"><p data-bshd="author">
    Before <mark class="bshd-hl" data-bshd-ann="private-thread"><b>the passage</b></mark> after
    </p><div data-bshd="peers">private peer</div><script>unsafe()</script><a onclick="unsafe()" href="javascript:unsafe()">safe text</a></section></main></body></html>`, "text/html");
  const before = doc.documentElement.outerHTML;
  const snapshot = imageSnapshot(doc.querySelector("section")!);
  const clean = new DOMParser().parseFromString(snapshot.html, "text/html");
  const selected = snapshot.path.reduce<Node>((node, index) => node.childNodes[index], clean.documentElement) as Element;
  expect(selected.id).toBe("chosen");
  expect(selected.parentElement?.className).toBe("paper");
  expect(clean.querySelector("style")?.textContent).toContain("width: 420px");
  expect(clean.querySelector(".bshd-hl")).toBeNull();
  expect(clean.querySelector("[data-bshd-ann]")).toBeNull();
  expect(clean.querySelector('[data-bshd="peers"]')).toBeNull();
  expect(clean.querySelector('[data-bshd="author"] b')?.textContent).toBe("the passage");
  expect(clean.querySelectorAll("script,[onclick],[href^='javascript:']")).toHaveLength(0);
  expect(doc.documentElement.outerHTML).toBe(before);
});
