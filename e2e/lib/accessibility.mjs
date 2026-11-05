// SPDX-License-Identifier: Apache-2.0
// Inspect app UI contrast, names, target geometry, phone layout and focus paint in real Chrome, without touching authored frames (SPEC §7, §10).

/** Interactive targets, including native controls whose label can supply the hit area. */
export const TARGET_SELECTOR = 'button, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], a[href], input:not([type="hidden"]), select, textarea, summary';

/** Runs in the main document only. No traversal into the author's iframe. */
export function inspectUiInPage({ tap = 44 } = {}) {
  const issues = { contrast: [], names: [], focusPaint: [], small: [], horizontal: [], overlap: [], clipped: [], mark: [], inputFont: [], cutText: [] };
  const checked = { text: 0, targets: 0 };
  const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
  const scope = modal ?? document.body;
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className?.baseVal ?? el.className).trim().replace(/\s+/g, '.')}`;
  const hidden = (el, visual = true) => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return true;
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility !== 'visible' || Number(cs.opacity) === 0) return true;
      if (visual && (cs.clipPath !== 'none' || (cs.clip && cs.clip !== 'auto'))) return true;
    }
    return el.getBoundingClientRect().width === 0 || el.getBoundingClientRect().height === 0;
  };
  const rgba = (s) => {
    const srgb = s.match(/^color\(srgb ([^)]+)\)$/);
    if (srgb) { const n = srgb[1].replace('/', ' ').trim().split(/\s+/).map(Number); return [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1]; }
    const m = s.match(/^rgba?\(([^)]+)\)$/);
    if (!m) throw new Error(`unsupported computed colour ${s}`);
    const n = m[1].replace('/', ' ').split(/[\s,]+/).filter(Boolean).map(Number);
    return [n[0], n[1], n[2], n[3] ?? 1];
  };
  const over = (a, b) => { const alpha = a[3] + b[3] * (1 - a[3]); return [...a.slice(0, 3).map((v, i) => alpha ? (v * a[3] + b[i] * b[3] * (1 - a[3])) / alpha : 0), alpha]; };
  const lum = (a) => a.slice(0, 3).map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const contrast = (el, text, style = getComputedStyle(el), pseudo = false) => {
    if (!text.trim() || hidden(el) || el.closest(':disabled, [aria-disabled="true"]')) return;
    const ancestors = [];
    for (let p = el; p; p = p.parentElement) ancestors.unshift(p);
    let image = null;
    for (const p of ancestors) {
      const cs = getComputedStyle(p);
      if (rgba(cs.backgroundColor)[3] === 1) image = null;
      if (cs.backgroundImage !== 'none') image = label(p);
    }
    // Composite both the ink pixel and its background through every ancestor's
    // translucent surface and group opacity, finishing on Chrome's white canvas.
    let ink = rgba(style.color);
    if (pseudo) ink[3] *= Number(style.opacity || 1);
    let background = [0, 0, 0, 0];
    for (const p of ancestors.reverse()) {
      const cs = getComputedStyle(p);
      const bg = rgba(cs.backgroundColor);
      ink = over(ink, bg);
      background = over(background, bg);
      ink[3] *= Number(cs.opacity);
      background[3] *= Number(cs.opacity);
    }
    ink = over(ink, [255, 255, 255, 1]);
    background = over(background, [255, 255, 255, 1]);
    checked.text += 1;
    const minimum = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.666 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    const value = ratio(ink, background);
    // Fail closed on backgrounds this explicit inspector cannot measure. App UI
    // must supply an opaque surface behind its text; authored artwork is excluded.
    if (image || value + 0.005 < minimum) issues.contrast.push({ element: label(el), text: text.trim().slice(0, 80), ratio: +value.toFixed(3), minimum, ...(image ? { unmeasuredBackgroundImage: image } : {}) });
  };
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement && !n.parentElement.closest('script, style, noscript, option')) contrast(n.parentElement, n.data);
  }
  for (const el of scope.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea')) {
    if (el.value) contrast(el, el.value);
    else if (el.placeholder) contrast(el, el.placeholder, getComputedStyle(el, '::placeholder'), true);
  }
  for (const el of scope.querySelectorAll('select')) contrast(el, el.selectedOptions?.[0]?.textContent ?? '');
  for (const img of scope.querySelectorAll('img:not([alt])')) if (!hidden(img)) issues.names.push({ element: label(img), problem: 'image missing alt (use empty alt only for decoration)' });
  const probe = document.createElement('span');
  probe.style.color = 'var(--color-focus)';
  document.body.appendChild(probe);
  const focusColor = getComputedStyle(probe).color;
  probe.remove();
  for (const el of [scope, ...scope.querySelectorAll('*')]) {
    if (hidden(el)) continue;
    const cs = getComputedStyle(el);
    const paints = [];
    if (cs.color === focusColor && [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim())) paints.push('text');
    if (cs.backgroundColor === focusColor) paints.push('background');
    if (el instanceof SVGElement && (cs.fill === focusColor || (cs.stroke === focusColor && parseFloat(cs.strokeWidth) > 0))) paints.push('svg');
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(cs[`border${side}Width`]) > 0 && !['none', 'hidden'].includes(cs[`border${side}Style`]) && cs[`border${side}Color`] === focusColor) paints.push(`border${side}`);
    if (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none' && cs.outlineColor === focusColor && !el.matches(':focus-visible, iframe.doc-frame[data-frame-focus]')) paints.push('outline');
    if (paints.length) issues.focusPaint.push({ element: label(el), paints });
    const r = el.getBoundingClientRect();
    // Check nested scrollports and fixed overlays, not just the page's scrollWidth.
    if ((['auto', 'scroll'].includes(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (cs.position === 'fixed' && (r.left < -1 || r.right > document.documentElement.clientWidth + 1) && !el.matches('.skip-link'))) issues.horizontal.push({ element: label(el), width: el.clientWidth, scrollWidth: el.scrollWidth, left: r.left, right: r.right });
  }
  const selector = 'button, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], a[href], input:not([type="hidden"]), select, textarea, summary';
  for (const el of scope.querySelectorAll(selector)) {
    if (hidden(el)) continue;
    // WCAG's inline-text exception applies to prose, not navigation list items.
    if (el.matches('a') && el.closest('p, .legal li, .field-hint, .caption')) continue;
    if (el.matches('.skip-link') && !el.matches(':focus')) continue;
    let hit = el;
    if (el.matches('input[type="checkbox"], input[type="radio"]')) hit = [...(el.labels ?? [])].find((l) => !hidden(l)) ?? el;
    const r = hit.getBoundingClientRect();
    checked.targets += 1;
    if (r.width < tap - 0.5 || r.height < tap - 0.5) issues.small.push({ element: label(el), width: r.width, height: r.height, hitArea: label(hit) });
  }

  // --- Phone layout. Each of these has shipped: a wordmark over the links beside
  // it, an action off the edge of the screen, a logo flexed to zero width, the
  // zoom iOS applies to a small input, and a word cut with no ellipsis.
  const vw = document.documentElement.clientWidth;
  // A control floating in its own layer (a menu, a drawer, the consent card) may
  // cover the page: that is what a layer is for. Two controls in ONE layer may not.
  const layerOf = (el) => {
    for (let p = el; p; p = p.parentElement) {
      if (['fixed', 'absolute', 'sticky'].includes(getComputedStyle(p).position)) return p;
    }
    return null;
  };
  // What can be seen of a control: a field scrolled out of a dialog's body is not
  // under the dialog's footer, however its box reads.
  const seenBox = (el) => {
    const r = el.getBoundingClientRect();
    const box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    for (let p = el; p.parentElement && getComputedStyle(p).position !== 'fixed'; p = p.parentElement) {
      const cs = getComputedStyle(p.parentElement);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const c = p.parentElement.getBoundingClientRect();
      box.left = Math.max(box.left, c.left);
      box.right = Math.min(box.right, c.right);
      box.top = Math.max(box.top, c.top);
      box.bottom = Math.min(box.bottom, c.bottom);
    }
    return box;
  };
  const targets = [...scope.querySelectorAll(selector)].filter((el) => !hidden(el) && !(el.matches('.skip-link') && !el.matches(':focus')));
  const boxes = targets.map((el) => ({ el, r: el.getBoundingClientRect(), seen: seenBox(el), layer: layerOf(el) }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // A link running on in a sentence: its box spans lines it does not fill.
      if ([a.el, b.el].some((el) => el.matches('a') && el.closest('p, .legal li, .field-hint, .caption'))) continue;
      const w = Math.min(a.seen.right, b.seen.right) - Math.max(a.seen.left, b.seen.left);
      const h = Math.min(a.seen.bottom, b.seen.bottom) - Math.max(a.seen.top, b.seen.top);
      if (w > 1 && h > 1) issues.overlap.push({ a: label(a.el), b: label(b.el), width: Math.round(w), height: Math.round(h) });
    }
  }
  for (const { el, r } of boxes) {
    let scrolls = false;
    let cut = null;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY)) { scrolls = true; break; }
      if (['hidden', 'clip'].includes(cs.overflowX) || ['hidden', 'clip'].includes(cs.overflowY)) {
        const c = p.getBoundingClientRect();
        if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1) { cut = label(p); break; }
      }
    }
    if (cut) issues.clipped.push({ element: label(el), by: cut, left: Math.round(r.left), right: Math.round(r.right) });
    else if (!scrolls && (r.left < -1 || r.right > vw + 1)) issues.clipped.push({ element: label(el), by: 'the viewport', left: Math.round(r.left), right: Math.round(r.right), viewport: vw });
  }
  for (const svg of scope.querySelectorAll('svg[width]')) {
    const declared = parseFloat(svg.getAttribute('width'));
    // Asked of its parent: hidden() counts a zero-width box as hidden, and a logo
    // flexed to zero width is the very thing this looks for.
    if (!Number.isFinite(declared) || hidden(svg.parentElement, false)) continue;
    const r = svg.getBoundingClientRect();
    if (r.width < declared - 0.5) issues.mark.push({ element: label(svg), declared, width: r.width, in: label(svg.parentElement) });
  }
  // Below 16px iOS zooms the page when the field takes focus, and stays zoomed.
  if (matchMedia('(pointer: coarse)').matches) {
    const textEntry = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea';
    for (const el of scope.querySelectorAll(textEntry)) {
      if (hidden(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16 - 0.01) issues.inputFont.push({ element: label(el), fontSize: size });
    }
  }
  // Words that overflow a box that clips them read as a typo unless an ellipsis
  // says so, and a flex or grid box never draws one, whatever text-overflow says.
  for (const el of [scope, ...scope.querySelectorAll('*')]) {
    if (hidden(el) || !['hidden', 'clip'].includes(getComputedStyle(el).overflowX)) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim()) || el.scrollWidth <= el.clientWidth + 1) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== 'ellipsis' || /flex|grid/.test(cs.display)) issues.cutText.push({ element: label(el), text: el.textContent.trim().slice(0, 40), display: cs.display, textOverflow: cs.textOverflow });
  }
  return { issues, checked };
}

/** Chrome's real accessibility tree supplies computed names; DOM checks handle paint. */
export async function inspectUi(page) {
  const result = await page.evaluate(inspectUiInPage);
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: frameTree.frame.id });
    const namedRoles = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'slider', 'spinbutton', 'image']);
    const named = nodes.filter((n) => !n.ignored && namedRoles.has(n.role?.value));
    result.checked.accessibleNames = named.length;
    result.issues.names.push(...named.filter((n) => !String(n.name?.value ?? '').trim()).map((n) => ({ role: n.role.value, problem: 'empty computed accessible name' })));
  } finally { await cdp.detach(); }
  return result;
}

/** Text exposed to assistive technology, retaining clipped screen-reader words. */
export async function spokenText(locator) {
  return locator.evaluate((el) => {
    const walk = (n) => {
      if (n.nodeType === 1 && (n.getAttribute("aria-hidden") === "true" || n.hidden || getComputedStyle(n).display === "none" || getComputedStyle(n).visibility !== "visible")) return "";
      if (n.nodeType === 3) return n.data;
      return [...n.childNodes].map(walk).join("");
    };
    return walk(el).replace(/\s+/g, " ").trim();
  });
}
