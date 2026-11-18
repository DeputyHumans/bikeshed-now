# 0032 — A reading separates text that touches, and a quote may carry the space

**Status** Accepted · **Spec** §19, §22 · **Amends** [0030](0030-agents-read-a-markdown-reading.md) §4

## Context

A Markdown reading (ADR 0030) sees no CSS. A dashboard-like page keeps its words apart with a stylesheet alone: `<span class="readout">256</span><span class="metric-label">Applications out</span>`, a funnel's row of cells, a job title's link with the company's name in a span after it. The reading ran them together, `256Applications out`, `Kept by the prefilter493072%`, which an agent reads as a different number. Its lists came out as turndown's default `-   ` marker, and an item whose author typed a `•` read `-   • Applied`. A funnel the author had drawn from boxes and described in an `aria-label` read as its cells, not its description.

ADR 0030 §4 promises that a reading's words are the words `add_comment` and `suggest_edit` look for (`lib/quote.ts`), so an agent can quote what it read. The page's text really is `256Applications out`: the quote matcher joins spans with nothing between them, as `textContent` does. Separating them in the reading alone would make every quote copied across that space a refusal.

## Decision

1. **Where a `span` or `a` touches another, the reading puts a space.** The nearest previous sibling with text must be a `span` or `a`, with no whitespace on either side. Empty ones between, like a bar drawn with CSS, are passed over. Never after a text node, which may be part of the same word, never inside `pre` or `code`, and never between two single characters, which is a word split letter by letter for an animation.
2. **A quote may carry that space.** `scanBody` marks a touching boundary wherever only tags stand between two characters and, among them, a `span` or `a` closes and another opens. `locateQuote` searches each block both as written and with a space at each such boundary that has no whitespace. Context is checked the same two ways, and a place found both ways is one place. These boundaries are a superset of where the reading inserts spaces, which is the safe direction: the matcher accepts a space in a few places the reading never shows one, and never refuses one the reading does.
3. **The anchor holds the page's own text.** `exact`, `prefix` and `suffix` are slices of the block, never the quote as sent. So the browser's strict resolver (`annotation/exact.ts`), `lib/apply.ts` and every stored anchor are unchanged. The shared golden cases say so with `expect.exact`.
4. **A `role="img"` with an `aria-label` reads as `[figure: <label>]`**, as a screen reader reads it, with its cells left out and the label up to 1,000 characters, because it is the figure's content and not a caption. Without a label, its contents read as before.
5. **Lists read as `- ` and `N. `,** honouring `start`. Continuation lines line up under the item's text, and a bullet item's leading `•`, `◦`, `▪` (and their kin) is dropped, never a hyphen or a dash. Each item's place is counted once per list, so a long list costs its length, not its square.

## Consequences

- A quote that crosses a touching boundary lands on the page's text there. A quote of `the rapist` still refuses `the<em>rapist</em>`, because emphasis is not a touching element. It can anchor `<span>the</span><span>rapist</span>`, which the page shows as one word and the reading shows as two. In that case the words the agent saw are the words it anchored.
- `reading.test.js` checks both directions. Every block of a sample's text is in its reading once whitespace is ignored, and every plain line of its reading is found by `locateQuote`. A fixture shaped like the page that prompted this pins each rule, and each rule has a negative control.
- A reading of an existing document changes the next time it is made, and that mints no version (ADR 0030 §1).

## What would change this

- Agents quoting across a boundary the matcher does not accept, seen as refusals of words that were in a reading. Then the reading's rule and the matcher's boundaries have drifted, and the matcher widens to meet the reading.
- A common page shape that splits one word across sibling spans of more than one character each. Then the reading's rule needs that shape named and excluded, as split letters are.
