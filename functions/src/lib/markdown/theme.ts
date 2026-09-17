// SPDX-License-Identifier: Apache-2.0
// The standalone stylesheet embedded in every compiled Markdown document (SPEC §11).

/**
 * This sheet is DELIBERATELY independent of the app's design tokens, and must
 * stay that way.
 *
 * The invariant is that chrome never restyles document content: a document is an
 * artifact that must render identically when downloaded, printed, or opened by
 * someone who has never seen this product. Importing a token here would couple
 * the appearance of every published document to a future palette change, and
 * would make an exported file depend on a stylesheet it does not carry.
 *
 * So: literal values, no custom properties from outside, no external URLs, and a
 * font stack that resolves on any machine. The `id` is what the Markdown
 * serializer removes before converting back, so this never round-trips into the
 * author's source.
 */

export const MARKDOWN_THEME_ID = "bshd-md-theme";

export const MARKDOWN_THEME_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 48px 24px 96px;
  font: 400 17px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI",
        Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #1a1a26;
  background: #ffffff;
}
main { max-width: 46rem; margin: 0 auto; }
section { margin: 0 0 2rem; }
section:last-child { margin-bottom: 0; }
h1, h2, h3, h4, h5, h6 {
  margin: 2.2em 0 0.6em;
  line-height: 1.25;
  font-weight: 650;
  letter-spacing: -0.011em;
  text-wrap: balance;
}
section > :first-child { margin-top: 0; }
h1 { font-size: 2.1rem; letter-spacing: -0.021em; }
h2 { font-size: 1.55rem; }
h3 { font-size: 1.25rem; }
h4, h5, h6 { font-size: 1.05rem; }
p, ul, ol, blockquote, pre, table, hr { margin: 0 0 1.15em; }
a { color: #3c30b0; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
strong { font-weight: 650; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.3em 0; }
li > ul, li > ol { margin: 0.3em 0; }
li.task-list-item { list-style: none; margin-left: -1.4em; }
li.task-list-item input { margin-right: 0.5em; }
blockquote {
  padding: 0.1em 0 0.1em 1.1em;
  border-left: 3px solid rgba(26, 26, 38, 0.18);
  color: #55526b;
}
blockquote > :last-child { margin-bottom: 0; }
code, kbd, samp, pre {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
               "Liberation Mono", monospace;
  font-size: 0.88em;
}
:not(pre) > code {
  padding: 0.15em 0.38em;
  border-radius: 4px;
  background: #f4f3f8;
  border: 1px solid rgba(26, 26, 38, 0.1);
}
pre {
  padding: 14px 16px;
  overflow-x: auto;
  border-radius: 8px;
  background: #f4f3f8;
  border: 1px solid rgba(26, 26, 38, 0.1);
  line-height: 1.5;
}
pre code { background: none; border: 0; padding: 0; }
hr { border: 0; border-top: 1px solid rgba(26, 26, 38, 0.14); margin: 2.2em 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
th, td {
  padding: 0.5em 0.7em;
  border: 1px solid rgba(26, 26, 38, 0.14);
  text-align: left;
  vertical-align: top;
}
th { background: #f4f3f8; font-weight: 650; }
img { max-width: 100%; height: auto; }
del { color: #55526b; }

/* Print: the document is an artifact, so it has to survive Ctrl-P. */
@media print {
  body { padding: 0; font-size: 11pt; }
  a { color: inherit; }
  pre, blockquote, table, section { break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
}

@media (max-width: 600px) {
  body { padding: 28px 18px 64px; font-size: 16px; }
  h1 { font-size: 1.7rem; }
  h2 { font-size: 1.35rem; }
}
`.trim();
