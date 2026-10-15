// SPDX-License-Identifier: Apache-2.0
// Downloaded SVGs exclude private reader decoration while preserving the authored diagram (SPEC §20).

import { afterEach, expect, it, vi } from "vitest";
import { exportSvg } from "./image";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("serializes the clean SVG clone and leaves its highlighted source unchanged", () => {
  vi.useFakeTimers();
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" id="figure"><text data-bshd="author"><tspan class="bshd-hl" data-bshd-ann="private-thread">Diagram label</tspan></text><g data-bshd="peers"><text>private peer</text></g></svg>`, "image/svg+xml");
  const svg = doc.documentElement as unknown as SVGSVGElement;
  const before = svg.outerHTML;
  const serialized = vi.spyOn(XMLSerializer.prototype, "serializeToString");
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
  exportSvg(svg, "Diagram", { enabled: true, label: "OWNER", footer: "" });
  const text = serialized.mock.results[0].value as string;
  expect(text).not.toContain("private-thread");
  expect(text).not.toContain("bshd-hl");
  expect(text).not.toContain("private peer");
  expect(text).toContain('data-bshd="author"');
  expect(text).toContain("Diagram label");
  expect(text).toContain("OWNER");
  expect(svg.outerHTML).toBe(before);
});
