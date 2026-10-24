// SPDX-License-Identifier: Apache-2.0
// Render image exports from an inert, undecorated copy at the reader's viewport (SPEC §20).

import { stripDecoration } from "../annotation/highlighter";
import { scrubActiveContent } from "./pdf";

function pathTo(root: Node, node: Node): number[] {
  const path: number[] = [];
  for (let next = node; next !== root;) {
    const parent = next.parentNode;
    if (!parent) throw new Error("The image is no longer in the document.");
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, next));
    next = parent;
  }
  return path;
}

function atPath(root: Node, path: number[]): Node {
  return path.reduce((node, index) => node.childNodes[index], root);
}

/** Preserve the full style/ancestor context, but never a reader's decoration. */
export function imageSnapshot(node: HTMLElement | SVGElement): {
  html: string;
  path: number[];
  canvases: { source: HTMLCanvasElement; path: number[] }[];
} {
  const doc = node.ownerDocument;
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  const selected = atPath(root, pathTo(doc.documentElement, node));
  const canvases = Array.from(doc.querySelectorAll("canvas"), (source) => ({
    source, copy: atPath(root, pathTo(doc.documentElement, source)),
  }));
  stripDecoration(root);
  root.querySelectorAll("script").forEach((script) => script.remove());
  scrubActiveContent(root);
  const head = root.querySelector("head") ?? root;
  const base = doc.createElement("base");
  base.href = doc.baseURI;
  head.insertBefore(base, head.firstChild);
  return {
    html: `<!DOCTYPE html>${root.outerHTML}`,
    path: pathTo(root, selected),
    // Canvas pixels are runtime state, not HTML. Keep authored drawings when
    // moving to the clean frame; canvas inside an app overlay is discarded.
    canvases: canvases.filter(({ copy }) => root.contains(copy))
      .map(({ source, copy }) => ({ source, path: pathTo(root, copy) })),
  };
}

/** Recompute styles after stripping; styles copied from a highlighted node still carry its paint. */
export async function withCleanImageNode<T>(
  node: HTMLElement | SVGElement,
  render: (clean: HTMLElement | SVGElement) => Promise<T>,
): Promise<T> {
  const snapshot = imageSnapshot(node);
  const view = node.ownerDocument.defaultView;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;top:0;left:0;width:${view?.innerWidth ?? 1024}px;height:${view?.innerHeight ?? 768}px;opacity:0;pointer-events:none;z-index:-1;border:0`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      timer = setTimeout(() => reject(new Error("The image export could not load its document.")), 15_000);
    });
    frame.srcdoc = snapshot.html;
    document.body.appendChild(frame);
    await loaded;
    clearTimeout(timer);
    const doc = frame.contentDocument;
    if (!doc) throw new Error("The image export could not open its document.");
    for (const { source, path } of snapshot.canvases) {
      const canvas = atPath(doc.documentElement, path) as HTMLCanvasElement;
      canvas.getContext("2d")?.drawImage(source, 0, 0);
    }
    if (doc.fonts) await Promise.race([
      doc.fonts.ready,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 4_000); }),
    ]);
    const clean = atPath(doc.documentElement, snapshot.path) as HTMLElement | SVGElement;
    return await render(clean);
  } finally {
    clearTimeout(timer);
    frame.remove();
  }
}
