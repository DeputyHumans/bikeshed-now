// SPDX-License-Identifier: Apache-2.0
// Reading text out of HTML without a parser: entities, whitespace, case (SPEC §8).

/**
 * Shared by the head scanner, which reads a document's title and excerpt, and
 * the quote locator, which finds an agent's quoted text in a version. Neither
 * may load an HTML parser — `functions/` has none, by budget — so both read
 * HTML as a browser's tokenizer would read text, as far as these three things
 * go, and one copy of each keeps them agreeing.
 */

// Every lookup keyed by text from the document is a Map, never a plain
// object: `&constructor;` or `name="__proto__"` must find nothing, not a
// member of Object.prototype.
export const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
  ["mdash", "\u2014"],
  ["ndash", "\u2013"],
  ["hellip", "\u2026"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["ldquo", "\u201c"],
  ["rdquo", "\u201d"],
  ["copy", "\u00a9"],
]);

/** The longest entity body this decoder accepts between `&` and `;`. */
export const ENTITY_CHARS = 32;

/** Numeric references and the named table; anything else is left as written. */
export function decodeEntities(text: string): string {
  let amp = text.indexOf("&");
  if (amp === -1) return text;
  const out: string[] = [];
  let from = 0;
  let semi = -1;
  while (amp !== -1) {
    if (semi < amp) semi = text.indexOf(";", amp + 1);
    if (semi === -1) break;
    const decoded = semi - amp - 1 <= ENTITY_CHARS ? decodeEntity(text.slice(amp + 1, semi)) : null;
    if (decoded === null) {
      amp = text.indexOf("&", amp + 1);
      continue;
    }
    out.push(text.slice(from, amp), decoded);
    from = semi + 1;
    amp = text.indexOf("&", from);
  }
  out.push(text.slice(from));
  return out.join("");
}

export function decodeEntity(body: string): string | null {
  if (body.charCodeAt(0) !== 0x23) return NAMED_ENTITIES.get(body) ?? null;
  const hex = body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58;
  const digits = body.slice(hex ? 2 : 1);
  if (digits.length === 0 || !(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
  const code = parseInt(digits, hex ? 16 : 10);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(code);
}

/** Runs of whitespace (as `\s` defines it, so a decoded `&nbsp;` too) become one space; ends are trimmed. */
export function collapseWhitespace(text: string): string {
  const out: string[] = [];
  let pending = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isAnySpace(c)) {
      pending = out.length > 0;
      continue;
    }
    if (pending) {
      out.push(" ");
      pending = false;
    }
    out.push(text[i]);
  }
  return out.join("");
}

export function isAnySpace(c: number): boolean {
  return (
    c <= 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** ASCII lowercase, index-aligned with its input; `toLowerCase` is not (U+0130 becomes two code units). */
export function asciiLower(text: string): string {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) {
      out.push(text.slice(from, i), String.fromCharCode(c | 0x20));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out.join("");
}
