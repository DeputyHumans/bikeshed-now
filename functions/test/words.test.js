// SPDX-License-Identifier: Apache-2.0
// How long a document is: the words a person reads in its body, for its reading time (SPEC §4).

const test = require("node:test");
const assert = require("node:assert/strict");
const { countWords } = require("../lib/lib/head.js");

const page = (body, head = "<title>Five words in the title</title>") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test("counts the words of the body, not the title or anything the browser does not show as text", () => {
  assert.equal(countWords(page("<h1>Quarterly plan</h1><p>We ship the payments work first.</p>")), 8);
  assert.equal(
    countWords(page(`<p>one two</p><script>var a = "three four five";</script><style>p{color:red}</style><svg><title>six</title></svg><!-- seven --><template>eight</template><nav>nine ten</nav>`)),
    2,
  );
});

test("an inline tag inside a word does not split it, and a block boundary separates words", () => {
  assert.equal(countWords(page("<p>bi<b>g</b> deal</p>")), 2);
  assert.equal(countWords(page("<p>end</p><p>start</p>")), 2, "no space written between blocks, still two words");
  assert.equal(countWords(page("<li>alpha</li><li>beta</li>")), 2);
});

test("entities are text, and punctuation and numbers count as the segmenter counts them", () => {
  assert.equal(countWords(page("<p>fish&nbsp;&amp;&nbsp;chips</p>")), 2);
  assert.equal(countWords(page("<p>It costs 25 dollars — really.</p>")), 5);
});

test("a language written without spaces counts its words, not one long one", () => {
  assert.ok(countWords(page("<p>私は東京に住んでいます。</p>")) > 1);
});

test("an empty or bodiless document counts what it has", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords(page("")), 0);
  assert.equal(countWords("<title>Only a title</title><p>and a line</p>"), 3, "after the title when there is no <body>");
});
