// SPDX-License-Identifier: Apache-2.0
// Typed tokens for the concurrent-editing oracles: a checksummed token per run, peer and sequence, and the I2/I4 analysis of where each landed (SPEC §16).

/**
 * SHAPE. `⟦r<run>-<peer>-<seq><check>⟧`, for example `⟦r3x33-p7-017k4⟧`:
 *   run    the last RUN_CHARS [a-z0-9] of the run id (its random suffix);
 *   peer   1–4 of [a-z0-9], chosen by the spec;
 *   seq    the peer's sequence number, zero-padded to SEQ_WIDTH digits;
 *   check  two base-36 characters of a hash of everything between the
 *          brackets, so a span that was split, truncated, doubled or spliced
 *          from two tokens almost never validates (1 in 1296 by chance).
 * Sixteen or seventeen keystrokes with a two- or three-character peer.
 *
 * TYPING. Playwright's `keyboard.type` sends a real keydown/keypress/keyup
 * for every character on its US layout and `Input.insertText` for anything
 * else. The interior is entirely on the layout (`TYPING_ALPHABET`), so it is
 * typed the way a person types it. The brackets U+27E6/U+27E7 are not on it:
 * each is one `insertText` (beforeinput + input with inputType "insertText",
 * no keydown), which a contenteditable inserts like any typed text. Both are
 * in the BMP, so every token character is one UTF-16 unit and an offset into
 * the text is an offset into the token. They are kept because no fixture
 * contains them: a bracket in the analysed text is either a token's or
 * a defect's, which is what makes a stray fragment findable at all. No
 * space (it becomes U+00A0 at the end of a paragraph), no Enter, no Tab, no
 * astral characters.
 *
 * ANALYSIS. `analyseTokens` takes the text the tokens were typed into, as
 * SEGMENTS: disjoint runs of text in document order, each owned by a target
 * id or by nobody (`collectSegments` builds them in the page). Their
 * concatenation is the scope.
 *
 * WHAT EACH INPUT CAN PROVE. The I2 split check and the I4 check both need
 * `collectSegments` over the WHOLE body:
 *   {segments}        element boundaries are in the input, so a token Enter cut
 *                     across two paragraphs is `split` (splitDetection: true);
 *                     over the whole body, an I4 token can be `gone`.
 *   {targets}         flat within each target (one string per id), and only
 *                     the elements named: splitDetection is false, and an I4
 *                     token not found is `inconclusive` (a failure), never
 *                     `gone` — it may have survived in an element not given.
 *   {text, flat:true} flat: textContent joins the two halves of a split
 *                     paragraph, so a split token reads `ok` there. Refused
 *                     without `flat: true`; the result says splitDetection is
 *                     false and so does every `ok` detail. With an `id` it is
 *                     one element, a partial scope like {targets}.
 *
 * For every typed token it reports one status:
 *   ok          exactly one whole occurrence, inside its target, nothing else of it
 *   duplicated  more than one whole occurrence, or one plus a fragment that is
 *               unmistakably its own
 *   outside     exactly one whole occurrence, not in its target
 *   split       every character present in order, but in 2+ pieces: other text
 *               between them (another peer's characters, a zero-width space) or an
 *               element boundary across it (a paragraph split by Enter)
 *               (`tangled` when the only reassembly shares characters with other
 *               split tokens, as when several are interleaved character by character)
 *   garbled     not whole and not reassemblable, but a fragment of it is there
 *   missing     no trace of it
 *   unseen      not found, and its target is not among the elements given (only
 *               when the scope is some elements, {targets} or {text, id}); not a failure
 * and for a token typed into a passage that was then deleted (expect
 * "absent", I4): `gone`, or `survived` with whatever of it is left — or,
 * when the scope is only some elements and nothing of it is there,
 * `inconclusive`, which FAILS `ok`: absence can be shown only over the
 * whole body.
 * Everything token-like that nothing claims is a STRAY (a lone bracket, an
 * orphaned head) and every valid token nobody typed is FOREIGN; both fail
 * `ok`. Per target it gives each peer's tokens in document order next to the
 * order they were typed in.
 *
 * Whole occurrences come first and are CLAIMED, then reassemblies, then
 * fragments, and nothing claimed is used twice: a split token cannot borrow
 * characters from a neighbour that is itself whole. Reassembly starts at an
 * unclaimed `⟦`, takes the longest run of the token that is there, and then
 * repeatedly the longest next run within `maxSpread` characters. Fragments
 * are the unclaimed token-alphabet runs around an unclaimed bracket (or
 * around a token's `-<peer>-<seq>` with both brackets lost), attributed to
 * the token they share the longest common subsequence with — to all tied
 * unmatched tokens when there are a few, to none (a stray) when it could be
 * anyone's.
 */

export const OPEN = "\u27e6";
export const CLOSE = "\u27e7";
export const RUN_CHARS = 4;
export const SEQ_WIDTH = 3;
/** Every character of a token except the two brackets: all on Playwright's US layout. */
export const TYPING_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-";

const CHECK_CHARS = 2;
const CHECK_SPACE = 36 ** CHECK_CHARS;
const PEER_RE = /^[a-z0-9]{1,4}$/;
const SHAPE_RE = /^\u27e6r([a-z0-9]{1,8})-([a-z0-9]{1,4})-(\d{3,})([a-z0-9]{2})\u27e7$/;
const CLOSED_SPAN_RE = /\u27e6[^\u27e6\u27e7]{0,48}\u27e7/g;
const OPEN_CODE = 0x27e6;
const CLOSE_CODE = 0x27e7;
const MAX_AMBIGUOUS = 4;
const CONTEXT = 12;

/** FNV-1a over UTF-16 units, finished with murmur3's fmix32 so the low bits mix too. */
function checksum(body) {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return ((h >>> 0) % CHECK_SPACE).toString(36).padStart(CHECK_CHARS, "0");
}

/** The run part of a token: the last RUN_CHARS lowercase alphanumerics of a run id (or of a runTag, which ends the same). */
export function runPart(run) {
  const compact = String(run ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!compact) throw new Error(`tokens: run ${JSON.stringify(run)} has no [a-z0-9] characters`);
  return compact.slice(-RUN_CHARS);
}

/** The token for (run, peer, seq). Deterministic: the same arguments give the same token. */
export function makeToken(run, peer, seq) {
  if (!PEER_RE.test(String(peer))) throw new Error(`tokens: peer ${JSON.stringify(peer)} must be 1-4 of [a-z0-9]`);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(`tokens: seq ${JSON.stringify(seq)} must be a non-negative integer`);
  const body = `r${runPart(run)}-${peer}-${String(seq).padStart(SEQ_WIDTH, "0")}`;
  return `${OPEN}${body}${checksum(body)}${CLOSE}`;
}

/**
 * Parse anything token-shaped. Null when the shape is wrong; otherwise
 * {token, run, peer, seq, check, valid}, where `valid` means the checksum
 * matches and the sequence is in its canonical zero-padded form.
 */
export function parseToken(text) {
  const s = String(text);
  const m = SHAPE_RE.exec(s);
  if (!m) return null;
  const [, run, peer, seqText, check] = m;
  const seq = Number(seqText);
  const canonical = Number.isSafeInteger(seq) && seqText === String(seq).padStart(SEQ_WIDTH, "0");
  return { token: s, run, peer, seq, check, valid: canonical && checksum(`r${run}-${peer}-${seqText}`) === check };
}

/** True when `text` is exactly one valid token. */
export function isToken(text) {
  return parseToken(text)?.valid === true;
}

/**
 * A run's record of what was typed where. `next(peer, target)` returns the
 * peer's next token and records it; `expectAbsent(target)` marks everything
 * typed into a target that was then deleted (I4); `typed` is the list
 * `analyseTokens` takes.
 */
export function tokenLog(run) {
  const part = runPart(run);
  const last = new Map();
  const entries = [];
  return {
    run: part,
    next(peer, target = null) {
      const seq = (last.get(peer) ?? 0) + 1;
      const token = makeToken(part, peer, seq);
      last.set(peer, seq);
      entries.push({ token, peer, seq, target, expect: "present" });
      return token;
    },
    expectAbsent(target) {
      let n = 0;
      for (const e of entries) if (e.target === target) { e.expect = "absent"; n += 1; }
      return n;
    },
    get typed() {
      return entries.map((e) => ({ ...e }));
    },
  };
}

/** Every closed `⟦…⟧` span in a text: the valid tokens, the invalid spans, and how many brackets there are. */
export function scanTokens(text) {
  const s = String(text);
  const tokens = [];
  const invalid = [];
  for (const m of s.matchAll(CLOSED_SPAN_RE)) {
    const p = parseToken(m[0]);
    if (p?.valid) tokens.push({ token: m[0], at: m.index, run: p.run, peer: p.peer, seq: p.seq });
    else invalid.push({ text: m[0], at: m.index });
  }
  let open = 0;
  let close = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === OPEN_CODE) open += 1;
    else if (c === CLOSE_CODE) close += 1;
  }
  return { tokens, invalid, brackets: { open, close } };
}

/**
 * In the page: the text under a root as segments in document order. A new
 * segment starts whenever the owning target (the nearest ancestor whose id is
 * in `ids`, by element identity, so two halves of a paragraph that Enter
 * split and Chrome gave the same id stay apart) or the nearest block element
 * changes, and at every <br>. Concatenated, the texts are `root.textContent`.
 * Self-contained so Playwright can serialise it:
 *   frame.evaluate(collectSegments, { ids: ["e2e-1", "e2e-2"] })
 *   page.evaluate(collectSegments, { ids, html })    // parse HTML (a draft) with DOMParser first
 */
export function collectSegments({ ids = [], html = null, root = null } = {}) {
  const BLOCK = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CAPTION", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP",
    "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH",
    "THEAD", "TR", "UL",
  ]);
  const want = new Set(ids);
  const top = root ?? (html != null ? new DOMParser().parseFromString(html, "text/html").body : document.body);
  const label = (el) => (el ? `${String(el.tagName).toLowerCase()}${el.id ? `#${el.id}` : ""}` : "");
  const segments = [];
  let current = null;
  let broken = true;
  const walk = (node, target, block) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        if (broken || !current || current.target !== target || current.block !== block) {
          current = { target, block, seg: { id: target ? target.id : null, where: label(target ?? block), text: "" } };
          segments.push(current.seg);
          broken = false;
        }
        current.seg.text += child.nodeValue;
      } else if (child.nodeType === 1) {
        const tag = String(child.tagName).toUpperCase();
        if (tag === "BR") {
          broken = true;
          continue;
        }
        const t = child.id && want.has(child.id) ? child : target;
        const b = BLOCK.has(tag) ? child : block;
        walk(child, t, b);
        if (t !== target || b !== block) broken = true;
      }
    }
  };
  walk(top, top.id && want.has(top.id) ? top : null, top);
  return segments;
}

// --- analysis ---------------------------------------------------------------

function normaliseScope(input) {
  let segs;
  let wildcard = false;
  if (Array.isArray(input.segments)) {
    segs = input.segments.map((s) => ({ id: s.id ?? null, where: s.where || (s.id ? `#${s.id}` : "(outside)"), text: String(s.text ?? "") }));
  } else if (input.targets && typeof input.targets === "object") {
    segs = Object.entries(input.targets).map(([id, text]) => ({ id, where: `#${id}`, text: String(text ?? "") }));
  } else if (typeof input.text === "string") {
    if (input.flat !== true) {
      throw new TypeError("analyseTokens: {text} is flat — textContent joins the halves of a paragraph Enter split, so a token cut across them would read ok. Give {segments} from collectSegments over the whole body, or pass flat: true to accept that the result cannot detect such a split");
    }
    segs = [{ id: input.id ?? null, where: input.id ? `#${input.id}` : "(text)", text: input.text }];
    wildcard = input.id == null;
  } else {
    throw new TypeError("analyseTokens: give {segments}, {targets} or {text, flat: true}");
  }
  // {targets} and {text, id} hold only the elements named; {segments} and a bare {text} hold the whole body.
  const partial = !Array.isArray(input.segments) && !wildcard;
  // Only segments carry element boundaries; every other form is flat text.
  const splitDetection = Array.isArray(input.segments);
  let start = 0;
  for (const s of segs) {
    s.start = start;
    start += s.text.length;
    s.end = start;
  }
  return { segs, wildcard, partial, splitDetection, text: segs.map((s) => s.text).join("") };
}

function lcs(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = ca === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** JSON.stringify, with the characters an editor might slip in unseen spelled as escapes. */
function quote(text) {
  return JSON.stringify(text).replace(/[\u007f-\u00a0\u00ad\u034f\u061c\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\ufeff\ufff9-\ufffb]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const isTokenChar = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;

/**
 * Where every typed token landed. `input` (see "WHAT EACH INPUT CAN PROVE"):
 *   {segments: [{id, where?, text}], typed}  segments in document order (collectSegments);
 *                                            the only form that detects a split across elements
 *   {targets: {id: text}, typed}             each target's text, nothing else (flat, partial)
 *   {text, flat: true, id?, typed}           one element's text, or (no id) the whole body:
 *                                            then targets are ignored and "inside" means anywhere.
 *                                            Flat: refused without `flat: true`
 * The result: {ok, failures, counts, tokens, targets, foreign, strays,
 * splitDetection, partialScope}.
 * `typed`: [{token, target, expect?: "present"|"absent"}] (tokenLog().typed).
 * Options: maxSpread (chars a split token may spread over, default 24 × its
 * length), maxPieces (default its length), requireOrder (an out-of-order peer
 * fails `ok`), allowForeign (an untyped valid token does not).
 */
export function analyseTokens(input, options = {}) {
  const { segs, wildcard, partial: partialScope, splitDetection, text: S } = normaliseScope(input);
  const typed = input.typed ?? [];
  const { maxSpread: spreadOpt, maxPieces: piecesOpt, requireOrder = false, allowForeign = false } = options;

  const segOf = new Int32Array(S.length);
  segs.forEach((s, i) => segOf.fill(i, s.start, s.end));
  const claimed = new Uint8Array(S.length);
  const claim = (a, b) => claimed.fill(1, a, b);
  const free = (a, b) => {
    if (segOf[a] !== segOf[b - 1]) return false;
    for (let k = a; k < b; k += 1) if (claimed[k]) return false;
    return true;
  };
  const inTarget = (segIndex, target) => wildcard || target == null || segs[segIndex].id === target;
  const locate = (start, end) => {
    const seg = segs[segOf[start]];
    return {
      segment: seg.id,
      where: seg.where,
      at: start - seg.start,
      offset: start,
      context: S.slice(Math.max(seg.start, start - CONTEXT), Math.min(seg.end, end + CONTEXT)),
    };
  };

  // Typed tokens.
  const seen = new Set();
  const entries = typed.map((t, index) => {
    const token = typeof t === "string" ? t : t?.token;
    const p = parseToken(token);
    if (!p?.valid) throw new Error(`analyseTokens: typed[${index}] ${JSON.stringify(token)} is not a valid token`);
    if (seen.has(token)) throw new Error(`analyseTokens: typed[${index}] ${token} is listed twice`);
    seen.add(token);
    return {
      index, token, run: p.run, peer: p.peer, seq: p.seq,
      target: (typeof t === "string" ? null : t.target) ?? null,
      expect: typeof t !== "string" && t.expect === "absent" ? "absent" : "present",
      whole: [], pieces: null, fragments: [],
    };
  });
  const byToken = new Map(entries.map((e) => [e.token, e]));

  // 1. Whole occurrences: closed spans inside one segment.
  const wholeAll = [];
  const foreign = [];
  for (const m of S.matchAll(CLOSED_SPAN_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (segOf[start] !== segOf[end - 1]) continue;
    const e = byToken.get(m[0]);
    if (e) {
      e.whole.push({ start, end, seg: segOf[start] });
      wholeAll.push({ start, end, entry: e, token: m[0] });
      claim(start, end);
      continue;
    }
    const p = parseToken(m[0]);
    if (p?.valid) {
      foreign.push({ token: m[0], run: p.run, peer: p.peer, seq: p.seq, ...locate(start, end) });
      wholeAll.push({ start, end, entry: null, token: m[0], peer: p.peer, seq: p.seq });
      claim(start, end);
    }
  }
  wholeAll.sort((a, b) => a.start - b.start);

  // 2. Reassembly of the tokens with no whole occurrence.
  const opens = [];
  for (let i = 0; i < S.length; i += 1) if (S.charCodeAt(i) === OPEN_CODE && !claimed[i]) opens.push(i);

  const decompose = (T, s, maxSpread, maxPieces) => {
    const limit = Math.min(S.length, s + maxSpread);
    const W = S.slice(s, limit);
    let l = 0;
    while (l < T.length && s + l < limit && !claimed[s + l] && segOf[s + l] === segOf[s] && S[s + l] === T[l]) l += 1;
    if (l === 0) return null;
    const pieces = [{ start: s, end: s + l }];
    let i = l;
    let pos = s + l;
    while (i < T.length) {
      if (pieces.length >= maxPieces) return null;
      let found = null;
      for (let len = T.length - i; len >= 1 && !found; len -= 1) {
        const sub = T.slice(i, i + len);
        let p = W.indexOf(sub, pos - s);
        while (p !== -1) {
          if (free(s + p, s + p + len)) {
            found = { start: s + p, end: s + p + len };
            break;
          }
          p = W.indexOf(sub, p + 1);
        }
      }
      if (!found) return null;
      pieces.push(found);
      i += found.end - found.start;
      pos = found.end;
    }
    return pieces;
  };

  const reassembly = (e, startOk = (s) => !claimed[s]) => {
    const T = e.token;
    const maxSpread = spreadOpt ?? 24 * T.length;
    const maxPieces = piecesOpt ?? T.length;
    let best = null;
    for (const group of [opens.filter((s) => inTarget(segOf[s], e.target)), opens.filter((s) => !inTarget(segOf[s], e.target))]) {
      for (const s of group) {
        if (!startOk(s)) continue;
        const pieces = decompose(T, s, maxSpread, maxPieces);
        if (!pieces || pieces.length < 2) continue;
        const spread = pieces.at(-1).end - pieces[0].start;
        if (!best || pieces.length < best.pieces.length || (pieces.length === best.pieces.length && spread < best.spread)) best = { pieces, spread };
      }
      if (best) break;
    }
    return best?.pieces ?? null;
  };
  const wholeOnly = claimed.slice();
  for (const e of entries) {
    if (e.whole.length) continue;
    e.pieces = reassembly(e);
    if (e.pieces) for (const p of e.pieces) claim(p.start, p.end);
  }
  // Greedy, so a token reassembled early can take a character a later one
  // needed (tokens interleaved character by character). A token left over
  // is tried again from a leftover `⟦` against the whole tokens' claims
  // alone: if it is all there, in order, it is split and TANGLED with the
  // others, not lost.
  const claimedSplit = claimed.slice();
  claimed.set(wholeOnly);
  for (const e of entries) {
    if (e.whole.length || e.pieces) continue;
    e.pieces = reassembly(e, (s) => !claimedSplit[s]);
    e.tangled = Boolean(e.pieces);
    if (e.pieces) for (const p of e.pieces) claimedSplit.fill(1, p.start, p.end);
  }
  claimed.set(claimedSplit);

  // 3. Fragments: unclaimed token-alphabet runs around unclaimed brackets, and around a lost token's core.
  const CAP = 2 * Math.max(24, ...entries.map((e) => e.token.length));
  const covered = new Uint8Array(S.length);
  const residues = [];
  const extend = (a, b) => {
    let lo = a;
    let hi = b;
    while (lo > 0 && a - lo < CAP && !claimed[lo - 1] && !covered[lo - 1] && segOf[lo - 1] === segOf[a] && isTokenChar(S.charCodeAt(lo - 1))) lo -= 1;
    while (hi < S.length && hi - b < CAP && !claimed[hi] && !covered[hi] && segOf[hi] === segOf[a] && isTokenChar(S.charCodeAt(hi))) hi += 1;
    return [lo, hi];
  };
  for (let i = 0; i < S.length; i += 1) {
    if (claimed[i] || covered[i]) continue;
    const c = S.charCodeAt(i);
    if (c === OPEN_CODE) {
      let j = i + 1;
      while (j < S.length && j - i < CAP && !claimed[j] && segOf[j] === segOf[i] && isTokenChar(S.charCodeAt(j))) j += 1;
      if (j < S.length && !claimed[j] && segOf[j] === segOf[i] && S.charCodeAt(j) === CLOSE_CODE) j += 1;
      covered.fill(1, i, j);
      residues.push({ start: i, end: j });
    } else if (c === CLOSE_CODE) {
      let k = i;
      while (k > 0 && i - k < CAP && !claimed[k - 1] && !covered[k - 1] && segOf[k - 1] === segOf[i] && isTokenChar(S.charCodeAt(k - 1))) k -= 1;
      covered.fill(1, k, i + 1);
      residues.push({ start: k, end: i + 1 });
    }
  }
  for (const e of entries) {
    if (e.whole.length || e.pieces) continue;
    const core = `-${e.peer}-${String(e.seq).padStart(SEQ_WIDTH, "0")}`;
    for (let p = S.indexOf(core); p !== -1; p = S.indexOf(core, p + 1)) {
      if (!free(p, p + core.length) || covered.subarray(p, p + core.length).some((x) => x)) continue;
      const [lo, hi] = extend(p, p + core.length);
      covered.fill(1, lo, hi);
      residues.push({ start: lo, end: hi });
    }
  }
  residues.sort((a, b) => a.start - b.start);

  const unmatched = (e) => !e.whole.length && !e.pieces;
  const strays = [];
  for (const r of residues) {
    const R = S.slice(r.start, r.end);
    let best = 0;
    let tied = [];
    for (const e of entries) {
      const score = lcs(e.token, R);
      if (score > best) {
        best = score;
        tied = [e];
      } else if (score === best && score > 0) {
        tied.push(e);
      }
    }
    const explained = best >= 2 && best * 2 >= R.length;
    const lost = tied.filter(unmatched);
    const frag = { text: R, ...locate(r.start, r.end) };
    if (explained && lost.length >= 1 && lost.length <= MAX_AMBIGUOUS) {
      for (const e of lost) e.fragments.push({ ...frag, ambiguous: lost.length > 1, alsoResembles: tied.filter((x) => x !== e).slice(0, MAX_AMBIGUOUS).map((x) => x.token) });
    } else if (explained && lost.length === 0 && tied.length === 1) {
      tied[0].fragments.push({ ...frag, ambiguous: false, alsoResembles: [], partial: true });
    } else {
      strays.push({ ...frag, resembles: explained ? tied.slice(0, 5).map((e) => e.token) : [], resemblesCount: explained ? tied.length : 0 });
    }
  }

  // 4. Per-token verdicts.
  const counts = { ok: 0, duplicated: 0, outside: 0, split: 0, garbled: 0, missing: 0, unseen: 0, gone: 0, survived: 0, inconclusive: 0 };
  const hasSegment = (target) => wildcard || target == null || segs.some((s) => s.id === target);
  const failures = [];
  const scopeNames = [...new Set(segs.filter((s) => s.id != null).map((s) => `#${s.id}`))];
  const name = (e) => `${e.token} (peer ${e.peer}${e.target != null ? `, ${e.expect === "absent" ? "deleted with" : "in"} #${e.target}` : ""})`;
  const tokens = entries.map((e) => {
    const where = e.whole.map((w) => ({ ...locate(w.start, w.end), inTarget: inTarget(w.seg, e.target) }));
    const count = { target: where.filter((w) => w.inTarget).length, elsewhere: where.filter((w) => !w.inTarget).length };
    const pieces = e.pieces ? e.pieces.map((p) => ({ text: S.slice(p.start, p.end), ...locate(p.start, p.end), inTarget: inTarget(segOf[p.start], e.target) })) : null;
    const between = e.pieces
      ? e.pieces.slice(1).map((p, k) => {
        const a = e.pieces[k].end;
        const b = p.start;
        return {
          text: S.slice(a, b),
          tokens: wholeAll.filter((w) => w.start >= a && w.end <= b).map((w) => w.token),
          crossesElement: segOf[a - 1] !== segOf[b],
        };
      })
      : [];
    const partial = e.fragments.filter((f) => f.partial);
    let status;
    if (e.expect === "absent") {
      // Absence is provable only over the whole body: in some elements, "not
      // here" says nothing about the rest of the document.
      status = where.length || pieces || e.fragments.length ? "survived" : partialScope ? "inconclusive" : "gone";
    } else if (where.length > 1 || (where.length === 1 && partial.length)) {
      status = "duplicated";
    } else if (count.target === 1) {
      status = "ok";
    } else if (count.elsewhere === 1) {
      status = "outside";
    } else if (pieces) {
      status = "split";
    } else if (e.fragments.length) {
      status = "garbled";
    } else if (partialScope && !hasSegment(e.target)) {
      status = "unseen";
    } else {
      status = "missing";
    }
    counts[status] += 1;
    const frags = e.fragments.map((f) => `${quote(f.text)} in ${f.where} at ${f.at}${f.alsoResembles.length ? ` (also like ${f.alsoResembles.join(", ")})` : ""}`).join("; ");
    const places = where.map((w) => `${w.where} at ${w.at}`).join(", ");
    const splitText = pieces
      ? `${pieces.length} pieces ${pieces.map((p) => `${quote(p.text)} in ${p.where}`).join(" | ")}${pieces.every((p) => p.inTarget) ? "" : " (not all in its target)"}; between: ${between.map((b) => `${quote(b.text.length > 60 ? `${b.text.slice(0, 60)}…` : b.text)}${b.crossesElement ? " (element boundary)" : ""}`).join(", ")}`
      : "";
    const detail = {
      ok: `once, whole, in ${places}${splitDetection ? "" : " (flat text: a split across an element boundary would not show)"}`,
      duplicated: `duplicated: ${count.target} whole in target, ${count.elsewhere} elsewhere (${places})${partial.length ? `, and again in part: ${frags}` : ""}`,
      outside: `outside its target: whole in ${places}`,
      split: `split into ${splitText}${e.tangled ? " (tangled: shares characters with other split tokens)" : ""}`,
      garbled: `garbled: ${frags}`,
      missing: hasSegment(e.target) ? "missing" : `missing, and the text has no #${e.target}`,
      unseen: `not looked for: #${e.target} is not in the text given`,
      gone: "gone",
      inconclusive: `inconclusive: nothing of it in the elements given (${scopeNames.join(", ") || "none"}), but only the whole body can show it is gone — give collectSegments over the whole body`,
      survived: `survived: ${[places && `whole in ${places}`, pieces && `split into ${splitText}`, frags && `fragments ${frags}`].filter(Boolean).join("; ")}`,
    }[status];
    if (status !== "ok" && status !== "gone" && status !== "unseen") failures.push(`${name(e)}: ${detail}`);
    return { token: e.token, peer: e.peer, seq: e.seq, target: e.target, expect: e.expect, status, count, where, pieces, tangled: Boolean(e.tangled), between, fragments: e.fragments, detail };
  });

  for (const s of strays) {
    const like = s.resemblesCount ? `, like ${s.resembles.join(", ")}${s.resemblesCount > s.resembles.length ? ` and ${s.resemblesCount - s.resembles.length} more` : ""}` : "";
    failures.push(`stray fragment ${quote(s.text)} in ${s.where} at ${s.at}${like}`);
  }
  if (!allowForeign) for (const f of foreign) failures.push(`foreign token ${f.token} (nobody typed it) in ${f.where} at ${f.at}`);

  // 5. Per target: what is in it, and each peer's tokens in document order.
  const targets = {};
  const targetIds = new Set([...entries.map((e) => e.target ?? "*"), ...segs.filter((s) => s.id != null).map((s) => s.id)]);
  for (const id of targetIds) {
    const t = id === "*" ? null : id;
    const here = wholeAll.filter((w) => inTarget(segOf[w.start], t) && (!wildcard || t == null || w.entry?.target === t));
    const sequence = here.map((w) => w.token);
    const peers = {};
    const peerOf = (w) => w.entry?.peer ?? w.peer;
    const seqOf = (w) => w.entry?.seq ?? w.seq;
    const names = new Set([...entries.filter((e) => (e.target ?? "*") === id).map((e) => e.peer), ...here.map(peerOf)]);
    for (const p of names) {
      const order = here.filter((w) => peerOf(w) === p).map(seqOf);
      const typedSeqs = entries.filter((e) => (e.target ?? "*") === id && e.peer === p && e.expect === "present").map((e) => e.seq);
      const found = order.filter((q) => typedSeqs.includes(q));
      const expectedOrder = typedSeqs.filter((q) => found.includes(q));
      let runs = 0;
      let prev = null;
      for (const w of here) {
        const isP = peerOf(w) === p;
        if (isP && prev !== true) runs += 1;
        prev = isP;
      }
      peers[p] = {
        order,
        typed: typedSeqs,
        inOrder: found.length === expectedOrder.length && found.every((q, k) => q === expectedOrder[k]),
        complete: order.length === typedSeqs.length && order.every((q, k) => q === typedSeqs[k]),
        runs,
      };
      if (requireOrder && !peers[p].inOrder) failures.push(`peer ${p} in ${t == null ? "the text" : `#${t}`}: tokens out of order, found ${order.join(",")} typed ${typedSeqs.join(",")}`);
    }
    targets[id] = { present: hasSegment(t), sequence, peers };
  }

  return { ok: failures.length === 0, failures, counts, tokens, targets, foreign, strays, splitDetection, partialScope };
}
