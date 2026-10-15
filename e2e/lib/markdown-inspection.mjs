// SPDX-License-Identifier: Apache-2.0
// Inspect rendered Markdown section hierarchy and every supported external-resource channel in a browser parser (SPEC §11).

export function inspectMarkdownRendering(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = "https://markdown-inspection.invalid/";
  const external = [];
  const add = (el, attribute, value) => {
    const raw = value.trim();
    if (!raw || /^(?:data:|blob:|#)/i.test(raw)) return;
    try {
      if (new URL(raw, base).origin !== new URL(base).origin) external.push({ tag: el.localName, attribute, value: raw });
    } catch { external.push({ tag: el.localName, attribute, value: raw }); }
  };
  for (const el of doc.querySelectorAll("*")) {
    for (const name of ["src", "href", "action", "formaction", "poster", "data", "codebase", "background", "xlink:href"]) {
      if (el.hasAttribute(name)) add(el, name, el.getAttribute(name));
    }
    for (const name of ["srcset", "imagesrcset", "archive"]) {
      if (el.hasAttribute(name)) for (const candidate of el.getAttribute(name).split(/\s*,\s*/)) add(el, name, candidate.trim().split(/\s+/)[0]);
    }
    if (el.localName === "meta" && el.getAttribute("http-equiv")?.toLowerCase() === "refresh") {
      const redirect = el.getAttribute("content")?.match(/(?:^|;)\s*url\s*=\s*["']?([^"']+)/i)?.[1];
      if (redirect) add(el, "refresh", redirect);
    }
    const css = [el.getAttribute("style") ?? "", el.localName === "style" ? el.textContent : ""].join("\n");
    if (/@import\b/i.test(css)) external.push({ tag: el.localName, attribute: "css-import", value: css });
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(el, "css-url", match[1]);
  }
  return {
    sections: [...doc.querySelectorAll("section[id]")].map((section) => ({
      id: section.id,
      parent: section.parentElement?.closest("section[id]")?.id ?? null,
      firstTag: section.firstElementChild?.localName ?? null,
      firstText: section.firstElementChild?.textContent ?? null,
    })),
    styleIds: [...doc.querySelectorAll("style[id]")].map((style) => style.id),
    external,
  };
}
