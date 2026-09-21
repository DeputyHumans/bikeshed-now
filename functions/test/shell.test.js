// SPDX-License-Identifier: Apache-2.0
// The app shell for a document page, and the head injected into it for crawlers (SPEC §17).

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Readable } = require("node:stream");

const {
  GENERIC,
  decideShell,
  DEFAULT_CARD,
  resolveImage,
  composePage,
  renderShell,
  collectPrefix,
  loadShell,
  resetShellCacheForTests,
  warnIfOriginUnconfigured,
} = require("../lib/lib/shell.js");

const ORIGIN = "https://example.com";
const APP = join(__dirname, "..", "..", "app");
const TEMPLATE = readFileSync(join(APP, "index.html"), "utf8");
const NOW = 1_700_000_000_000;

/** Occurrences of `needle` in `haystack`. */
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/* ------------------------------------------------------------------------ */
/* decideShell                                                               */

const PUBLIC = { visibility: "public", currentVersion: "v3" };
const UNLISTED = { visibility: "unlisted", currentVersion: "v3", linkToken: "tok-0123456789abcdefghij" };

function decide(doc, { k = "", versionId = null, now = NOW } = {}) {
  return decideShell({ doc, k, versionId, now });
}

test("GENERIC is one frozen object", () => {
  assert.ok(Object.isFrozen(GENERIC));
  assert.deepEqual(GENERIC, { kind: "generic" });
});

test("every refusal is GENERIC itself, not a copy", () => {
  const refusals = [
    ["absent document", decide(null)],
    ["private", decide({ visibility: "private", currentVersion: "v1" })],
    ["visibility absent (private by default)", decide({ currentVersion: "v1" })],
    ["unlisted, no k", decide(UNLISTED)],
    ["unlisted, wrong k", decide(UNLISTED, { k: "tok-wrong" })],
    ["unlisted, k is a prefix of the token", decide(UNLISTED, { k: "tok-0123" })],
    ["unlisted, token absent, k empty", decide({ visibility: "unlisted", currentVersion: "v1" })],
    [
      "unlisted, token absent, k is the string 'undefined'",
      decide({ visibility: "unlisted", currentVersion: "v1" }, { k: "undefined" }),
    ],
    [
      "unlisted, token not a string, k matches its String form",
      decide({ visibility: "unlisted", currentVersion: "v1", linkToken: 12345 }, { k: "12345" }),
    ],
    ["public, expired", decide({ ...PUBLIC, expiresAt: NOW - 1 })],
    ["public, expiring this instant", decide({ ...PUBLIC, expiresAt: NOW })],
    ["unlisted, expired, right k", decide({ ...UNLISTED, expiresAt: NOW - 1 }, { k: UNLISTED.linkToken })],
    ["public, currentVersion missing", decide({ visibility: "public" })],
    ["public, currentVersion empty", decide({ visibility: "public", currentVersion: "" })],
    ["public, currentVersion not a string", decide({ visibility: "public", currentVersion: 3 })],
    ["public, pinned version empty", decide(PUBLIC, { versionId: "" })],
  ];
  for (const [name, decision] of refusals) assert.strictEqual(decision, GENERIC, name);
});

test("unlisted with the matching k is a document that crawlers must not index", () => {
  assert.deepEqual(decide(UNLISTED, { k: UNLISTED.linkToken }), {
    kind: "document",
    versionId: "v3",
    maxAge: 300,
    noindex: true,
  });
});

test("public is an indexable document cached for the public window", () => {
  assert.deepEqual(decide(PUBLIC), { kind: "document", versionId: "v3", maxAge: 300, noindex: false });
  // A stray `?k=` on a public link changes nothing: noindex follows visibility, not the query.
  assert.deepEqual(decide(PUBLIC, { k: "anything" }), { kind: "document", versionId: "v3", maxAge: 300, noindex: false });
});

test("maxAge never outlives an expiry", () => {
  assert.equal(decide({ ...PUBLIC, expiresAt: NOW + 100_000 }).maxAge, 100);
  assert.equal(decide({ ...PUBLIC, expiresAt: NOW + 100_999 }).maxAge, 100);
  assert.equal(decide({ ...PUBLIC, expiresAt: NOW + 3_600_000 }).maxAge, 300);
  assert.equal(decide({ ...PUBLIC, expiresAt: NOW + 400 }).maxAge, 0);
  // Firestore hands back a Timestamp, not a number.
  assert.equal(decide({ ...PUBLIC, expiresAt: { toMillis: () => NOW + 100_000 } }).maxAge, 100);
});

test("a pinned version passes through; otherwise the current one is used", () => {
  assert.equal(decide(PUBLIC, { versionId: "v1" }).versionId, "v1");
  assert.equal(decide(PUBLIC).versionId, "v3");
});

/* ------------------------------------------------------------------------ */
/* resolveImage                                                              */

const CTX = {
  origin: ORIGIN,
  docId: "d",
  versionId: "v1",
  entry: "deck/index.html",
  files: ["deck/index.html", "deck/img.png", "deck/img two.png", "x.png"],
  k: null,
};
const DEFAULT = { url: `${ORIGIN}/brand/og-default.png`, isDefault: true };

test("DEFAULT_CARD is the brand card at its real size", () => {
  assert.ok(Object.isFrozen(DEFAULT_CARD));
  assert.deepEqual(DEFAULT_CARD, { path: "/brand/og-default.png", width: 1200, height: 630 });
});

test("a relative image resolves against the entry inside the version", () => {
  const expected = { url: `${ORIGIN}/content/d/v1/deck/img.png`, isDefault: false };
  assert.deepEqual(resolveImage("img.png", CTX), expected);
  assert.deepEqual(resolveImage("./img.png", CTX), expected);
  assert.deepEqual(resolveImage("img.png?v=2#top", CTX), expected);
  assert.deepEqual(resolveImage(`${ORIGIN}/content/d/v1/deck/img.png`, CTX), expected);
});

test("a parent reference that stays inside the version is accepted", () => {
  assert.deepEqual(resolveImage("../x.png", CTX), { url: `${ORIGIN}/content/d/v1/x.png`, isDefault: false });
});

test("a parent reference that escapes the version is the default card", () => {
  assert.deepEqual(resolveImage("../../x.png", CTX), DEFAULT);
  assert.deepEqual(resolveImage("/content/d/v2/x.png", CTX), DEFAULT);
  assert.deepEqual(resolveImage("/content/dd/v1/x.png", CTX), DEFAULT);
});

test("a same-origin path is matched against the version's files, decoded", () => {
  assert.deepEqual(resolveImage("img%20two.png", CTX), {
    url: `${ORIGIN}/content/d/v1/deck/img%20two.png`,
    isDefault: false,
  });
  assert.deepEqual(resolveImage("missing.png", CTX), DEFAULT);
  assert.deepEqual(resolveImage("index.html", CTX), { url: `${ORIGIN}/content/d/v1/deck/index.html`, isDefault: false });
  assert.deepEqual(resolveImage(`${ORIGIN}/brand/favicon.svg`, CTX), DEFAULT);
  // A malformed escape cannot be decoded, so it cannot be in the list.
  assert.deepEqual(resolveImage("img%E0%A4%A.png", CTX), DEFAULT);
});

test("javascript:, data: and unparseable references are the default card", () => {
  assert.deepEqual(resolveImage("javascript:alert(1)", CTX), DEFAULT);
  assert.deepEqual(resolveImage("data:image/png;base64,iVBORw0KGgo=", CTX), DEFAULT);
  assert.deepEqual(resolveImage("ftp://example.org/a.png", CTX), DEFAULT);
  assert.deepEqual(resolveImage("http://[", CTX), DEFAULT);
});

test("a protocol-relative reference is an absolute cross-origin URL", () => {
  assert.deepEqual(resolveImage("//cdn.example.org/a.png", CTX), {
    url: "https://cdn.example.org/a.png",
    isDefault: false,
  });
});

test("an absolute cross-origin http(s) URL passes through as the URL parser writes it", () => {
  assert.deepEqual(resolveImage("HTTPS://Other.example/a.png", CTX), {
    url: "https://other.example/a.png",
    isDefault: false,
  });
  assert.deepEqual(resolveImage("http://other.example/a.png?size=large", CTX), {
    url: "http://other.example/a.png?size=large",
    isDefault: false,
  });
});

test("k is appended on the same-origin branch only, and only when given", () => {
  const withK = { ...CTX, k: "a b&c" };
  assert.equal(resolveImage("img.png", withK).url, `${ORIGIN}/content/d/v1/deck/img.png?k=a%20b%26c`);
  assert.equal(resolveImage("//cdn.example.org/a.png", withK).url, "https://cdn.example.org/a.png");
  assert.equal(resolveImage("img.png", CTX).url, `${ORIGIN}/content/d/v1/deck/img.png`);
  assert.equal(resolveImage("img.png", { ...CTX, k: "" }).url, `${ORIGIN}/content/d/v1/deck/img.png`);
  assert.deepEqual(resolveImage("missing.png", withK), DEFAULT);
});

test("no image at all is the default card", () => {
  assert.deepEqual(resolveImage(null, CTX), DEFAULT);
});

/* ------------------------------------------------------------------------ */
/* composePage                                                               */

const DOCUMENT = { kind: "document", versionId: "v1", maxAge: 300, noindex: false };
const NO_HEAD = { title: null, description: null, keywords: null, image: null };

function compose(over = {}) {
  return composePage({
    origin: ORIGIN,
    docId: "plan",
    requestedVersion: null,
    decision: DOCUMENT,
    docTitle: "Stored title",
    head: NO_HEAD,
    entry: "index.html",
    files: ["index.html", "cover.png"],
    k: "",
    ...over,
  });
}

test("the title is the document's own, else the stored one", () => {
  assert.equal(compose().title, "Stored title");
  assert.equal(compose({ head: { ...NO_HEAD, title: "Own title" } }).title, "Own title");
});

test("the head's description and keywords are carried as they are", () => {
  const page = compose({ head: { ...NO_HEAD, description: "What it says.", keywords: "a, b" } });
  assert.equal(page.description, "What it says.");
  assert.equal(page.keywords, "a, b");
  assert.equal(compose().description, null);
  assert.equal(compose().keywords, null);
});

test("the url names the document, and the version only when the request pinned one", () => {
  assert.equal(compose().url, `${ORIGIN}/d/plan`);
  assert.equal(compose({ requestedVersion: "v1" }).url, `${ORIGIN}/d/plan/v1`);
});

test("k is in the url only for an unlisted document", () => {
  const unlisted = { ...DOCUMENT, noindex: true };
  assert.equal(compose({ decision: unlisted, k: "t k" }).url, `${ORIGIN}/d/plan?k=t%20k`);
  assert.equal(compose({ decision: unlisted, k: "t", requestedVersion: "v1" }).url, `${ORIGIN}/d/plan/v1?k=t`);
  assert.equal(compose({ decision: unlisted, k: "" }).url, `${ORIGIN}/d/plan`);
  assert.equal(compose({ k: "t" }).url, `${ORIGIN}/d/plan`);
  assert.equal(compose({ decision: unlisted, k: "t" }).noindex, true);
  assert.equal(compose({ k: "t" }).noindex, false);
});

test("the image is resolved inside the version, with k only for an unlisted document", () => {
  const head = { ...NO_HEAD, image: "cover.png" };
  assert.deepEqual(
    [compose({ head }).image, compose({ head }).imageIsDefault],
    [`${ORIGIN}/content/plan/v1/cover.png`, false],
  );
  assert.equal(compose({ head, k: "t" }).image, `${ORIGIN}/content/plan/v1/cover.png`);
  assert.equal(
    compose({ head, k: "t", decision: { ...DOCUMENT, noindex: true } }).image,
    `${ORIGIN}/content/plan/v1/cover.png?k=t`,
  );
  // The image lives in the version the decision resolved, whatever the request said.
  assert.equal(
    compose({ head, decision: { ...DOCUMENT, versionId: "v7" }, requestedVersion: null }).image,
    `${ORIGIN}/content/plan/v7/cover.png`,
  );
  assert.deepEqual([compose().image, compose().imageIsDefault], [`${ORIGIN}/brand/og-default.png`, true]);
});

/* ------------------------------------------------------------------------ */
/* renderShell                                                               */

function page(over = {}) {
  return {
    title: "A title",
    description: "A description.",
    keywords: null,
    url: `${ORIGIN}/d/plan`,
    image: `${ORIGIN}/brand/og-default.png`,
    imageIsDefault: true,
    noindex: false,
    ...over,
  };
}

test("the template's description meta spans lines, which is what the matcher must cope with", () => {
  assert.match(TEMPLATE, /<meta\n\s+name="description"\n\s+content="[^"]+"\n\s+\/>/);
});

test("the title replaces the template's, once", () => {
  const out = renderShell(TEMPLATE, page());
  assert.ok(out.includes("<title>A title</title>"));
  assert.equal(out.includes("<title>Bikeshed</title>"), false);
  assert.equal(count(out, "<title"), 1);
  assert.equal(count(out, "</title>"), 1);
});

test("a script-closing title is escaped and adds no script element", () => {
  const out = renderShell(TEMPLATE, page({ title: "</title><script>alert(1)</script>" }));
  assert.ok(out.includes("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>"));
  assert.equal(count(TEMPLATE, "<script"), 1);
  assert.equal(count(out, "<script"), count(TEMPLATE, "<script"));
  assert.ok(out.includes('<script type="module" src="/src/main.tsx"></script>'));
});

test("attribute-breaking descriptions are neutralised", () => {
  const single = renderShell(TEMPLATE, page({ description: "' onerror='alert(1)" }));
  assert.equal(single.includes("' onerror='"), false);
  assert.ok(single.includes('<meta name="description" content="&#39; onerror=&#39;alert(1)" />'));
  assert.ok(single.includes('<meta property="og:description" content="&#39; onerror=&#39;alert(1)" />'));

  const double = renderShell(TEMPLATE, page({ description: '" onmouseover="alert(1)' }));
  assert.equal(double.includes('" onmouseover="'), false);
  assert.ok(double.includes('<meta name="description" content="&quot; onmouseover=&quot;alert(1)" />'));
  assert.ok(double.includes('<meta property="og:description" content="&quot; onmouseover=&quot;alert(1)" />'));
});

test("every injected value is escaped, not only the title and description", () => {
  const out = renderShell(
    TEMPLATE,
    page({ url: `${ORIGIN}/d/plan?k=a"b`, image: `${ORIGIN}/x.png?a=1&b="2`, keywords: `<k>, "q"` }),
  );
  assert.ok(out.includes('<meta property="og:url" content="https://example.com/d/plan?k=a&quot;b" />'));
  assert.ok(out.includes('<meta property="og:image" content="https://example.com/x.png?a=1&amp;b=&quot;2" />'));
  assert.ok(out.includes('<meta name="keywords" content="&lt;k&gt;, &quot;q&quot;" />'));
});

test("replacement patterns in a title are literal", () => {
  const out = renderShell(TEMPLATE, page({ title: "$&$'$1" }));
  assert.ok(out.includes("<title>$&amp;$'$1</title>"));
  assert.equal(count(out, "<title"), 1);
  assert.equal(count(out, "<html"), 1);
});

test("replacement patterns in a description are literal", () => {
  const out = renderShell(TEMPLATE, page({ description: "$&$`$'" }));
  assert.ok(out.includes('<meta name="description" content="$&amp;$`$&#39;" />'));
  assert.equal(count(out, "<html"), 1);
});

test("the og lines are in order and immediately before </head>", () => {
  const out = renderShell(TEMPLATE, page({ keywords: "a, b" }));
  const expected = [
    '<meta property="og:site_name" content="Bikeshed" />',
    '<meta property="og:type" content="article" />',
    '<meta property="og:title" content="A title" />',
    '<meta property="og:description" content="A description." />',
    `<meta property="og:url" content="${ORIGIN}/d/plan" />`,
    `<meta property="og:image" content="${ORIGIN}/brand/og-default.png" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    '<meta name="keywords" content="a, b" />',
  ];
  let at = -1;
  for (const line of expected) {
    const next = out.indexOf(line);
    assert.ok(next > at, `${line} present, after the previous line`);
    at = next;
  }
  const headEnd = out.indexOf("</head>");
  assert.ok(at < headEnd, "the block precedes </head>");
  assert.match(out.slice(at, headEnd), /^<meta name="keywords" content="a, b" \/>\s*$/, "nothing between the block and </head>");
  assert.equal(count(out, "</head>"), 1);
});

test("the robots meta is present only for noindex", () => {
  const robots = '<meta name="robots" content="noindex" />';
  assert.equal(renderShell(TEMPLATE, page()).includes(robots), false);
  assert.ok(renderShell(TEMPLATE, page({ noindex: true })).includes(robots));
  assert.equal(count(renderShell(TEMPLATE, page({ noindex: true })), "noindex"), 1);
});

test("width and height are declared only for the default card", () => {
  const own = renderShell(TEMPLATE, page({ image: `${ORIGIN}/content/plan/v1/cover.png`, imageIsDefault: false }));
  assert.equal(own.includes("og:image:width"), false);
  assert.equal(own.includes("og:image:height"), false);
  assert.ok(own.includes(`<meta property="og:image" content="${ORIGIN}/content/plan/v1/cover.png" />`));
  const card = renderShell(TEMPLATE, page());
  assert.ok(card.includes('<meta property="og:image:width" content="1200" />'));
  assert.ok(card.includes('<meta property="og:image:height" content="630" />'));
});

test("a null description leaves no description meta at all", () => {
  const out = renderShell(TEMPLATE, page({ description: null }));
  assert.equal(/name="description"/i.test(out), false);
  assert.equal(out.includes("og:description"), false);
  assert.equal(out.includes('content=""'), false);
  assert.ok(out.includes('<meta property="og:title" content="A title" />'));
});

test("keywords are present only when the document declares them", () => {
  assert.equal(renderShell(TEMPLATE, page()).includes('name="keywords"'), false);
  assert.ok(renderShell(TEMPLATE, page({ keywords: "a, b" })).includes('<meta name="keywords" content="a, b" />'));
});

test("title and description matching is case-insensitive and tolerates attributes and order", () => {
  const template =
    '<!doctype html><html><head><TITLE lang="en"\n>Old</TITLE ><META content="old" NAME="description"></head><body><div id="root"></div></body></html>';
  const out = renderShell(template, page());
  assert.ok(out.includes("<title>A title</title>"));
  assert.equal(out.includes("Old"), false);
  assert.equal(out.includes('content="old"'), false);
  assert.ok(out.includes('<meta name="description" content="A description." />'));
});

test("only the first title and the first description meta are touched", () => {
  const template =
    '<html><head><title>One</title><meta name="description" content="one"><meta name="description" content="two"></head><body><svg><title>Two</title></svg></body></html>';
  const out = renderShell(template, page());
  assert.ok(out.includes("<title>A title</title>"));
  assert.ok(out.includes("<svg><title>Two</title></svg>"));
  assert.ok(out.includes('<meta name="description" content="two">'));
  assert.equal(out.includes('content="one"'), false);
});

test("a template missing what the page needs throws instead of half-rendering", () => {
  assert.throws(() => renderShell(TEMPLATE.replace("</head>", ""), page()), /<\/head>/);
  assert.throws(() => renderShell(TEMPLATE.replace("<title>Bikeshed</title>", ""), page()), /<title>/);
  assert.throws(
    () => renderShell(TEMPLATE.replace(/<meta\n\s+name="description"[\s\S]*?\/>/, ""), page()),
    /description/,
  );
});

test("the built shell renders with the document's head", () => {
  const dist = join(APP, "dist", "index.html");
  const template = readFileSync(existsSync(dist) ? dist : join(APP, "index.html"), "utf8");
  const out = renderShell(template, page());
  assert.ok(out.includes('property="og:title"'));
  assert.ok(out.includes("<title>A title</title>"));
});

/* ------------------------------------------------------------------------ */
/* collectPrefix                                                             */

/** A stream of `chunks` × 100 bytes, each filled with its ordinal, handed over one `read()` at a time. */
function counted(chunks) {
  let pulls = 0;
  const stream = new Readable({
    highWaterMark: 100,
    read() {
      pulls += 1;
      this.push(pulls <= chunks ? Buffer.alloc(100, pulls) : null);
    },
  });
  return { stream, pulls: () => pulls };
}

test("collectPrefix stops at the cap and destroys the stream", async () => {
  // Ten chunks on offer, so the stream cannot have ended on its own by the
  // time the cap is reached: `destroyed` is true only because it was destroyed.
  const { stream, pulls } = counted(10);
  const bytes = await collectPrefix(stream, 250);
  assert.equal(bytes.length, 250);
  assert.equal(bytes[0], 1);
  assert.equal(bytes[199], 2);
  assert.equal(bytes[200], 3);
  assert.equal(bytes[249], 3);
  assert.equal(stream.destroyed, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(pulls() < 10, `the producer was not drained (pulled ${pulls()} of 10)`);
});

test("collectPrefix returns everything when the cap is not reached", async () => {
  const stream = Readable.from([Buffer.alloc(100, 1), Buffer.alloc(100, 2), Buffer.alloc(100, 3)]);
  const bytes = await collectPrefix(stream, 1000);
  assert.equal(bytes.length, 300);
  assert.equal(bytes[299], 3);
});

test("collectPrefix resolves with exactly the cap when the cap falls on a chunk boundary", async () => {
  const { stream } = counted(10);
  const bytes = await collectPrefix(stream, 200);
  assert.equal(bytes.length, 200);
  assert.equal(bytes[199], 2);
  assert.equal(stream.destroyed, true);
});

test("collectPrefix rejects when the stream errors", async () => {
  const stream = new Readable({
    read() {
      this.destroy(new Error("boom"));
    },
  });
  await assert.rejects(collectPrefix(stream, 100), /boom/);
});

/* ------------------------------------------------------------------------ */
/* loadShell                                                                 */

const SHELL =
  '<!doctype html><html><head><title>Bikeshed</title><script type="module" src="/assets/index-abc123.js"></script></head>' +
  '<body><div id="root"></div></body></html>';
const NOT_FOUND_PAGE =
  "<!doctype html><html><head><title>Site Not Found</title></head><body><h1>Site Not Found</h1></body></html>";

/** A fetch whose answers are scripted, recording every call. */
function scripted(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new Error("scripted fetch ran out of answers");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

function source(fetchImpl, log = () => {}) {
  return { origin: ORIGIN, fetchImpl, log };
}

test("a shell with both markers is adopted, then revalidated by ETag", async () => {
  resetShellCacheForTests();
  const { fetchImpl, calls } = scripted([html(SHELL, 200, { etag: '"v1"' }), new Response(null, { status: 304 })]);
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await loadShell(source(fetchImpl, log)), SHELL);
  assert.equal(await loadShell(source(fetchImpl, log)), SHELL);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${ORIGIN}/`);
  assert.equal(calls[1].url, `${ORIGIN}/`);
  assert.equal(new Headers(calls[0].init.headers).get("accept"), "text/html");
  assert.equal(new Headers(calls[0].init.headers).get("if-none-match"), null);
  assert.equal(new Headers(calls[1].init.headers).get("if-none-match"), '"v1"');
  assert.ok(calls[0].init.signal instanceof AbortSignal, "the request has a timeout signal");
  assert.deepEqual(lines, [`shell origin: ${ORIGIN}`], "the origin is logged once, not per call");
});

test("a 404 is not the shell, whatever it carries", async () => {
  resetShellCacheForTests();
  const { fetchImpl } = scripted([html(SHELL, 404)]);
  await assert.rejects(loadShell(source(fetchImpl)));
});

test("a page without the app's markers is not the shell", async () => {
  // Hosting's own page before the site is deployed, and a stranger's site.
  resetShellCacheForTests();
  await assert.rejects(loadShell(source(scripted([html(NOT_FOUND_PAGE)]).fetchImpl)));
  resetShellCacheForTests();
  await assert.rejects(loadShell(source(scripted([html('<div id="root"></div>')]).fetchImpl)));
  resetShellCacheForTests();
  await assert.rejects(loadShell(source(scripted([html('<script src="/assets/a.js"></script>')]).fetchImpl)));
});

test("a body that is not text/html is not the shell", async () => {
  resetShellCacheForTests();
  const { fetchImpl } = scripted([html(SHELL, 200, { "content-type": "text/plain" })]);
  await assert.rejects(loadShell(source(fetchImpl)));
});

test("a fetch that rejects, with nothing cached, rejects", async () => {
  resetShellCacheForTests();
  await assert.rejects(loadShell(source(scripted([new Error("ECONNREFUSED")]).fetchImpl)), /ECONNREFUSED/);
});

test("a 304 with nothing cached is not a shell either", async () => {
  // Nothing was sent to validate against, so a 304 is an origin misbehaving.
  resetShellCacheForTests();
  const { fetchImpl, calls } = scripted([new Response(null, { status: 304 })]);
  await assert.rejects(loadShell(source(fetchImpl)));
  assert.equal(new Headers(calls[0].init.headers).get("if-none-match"), null);
});

test("once a shell is adopted, every later failure serves it", async () => {
  resetShellCacheForTests();
  const { fetchImpl, calls } = scripted([
    html(SHELL, 200, { etag: '"v1"' }),
    html(NOT_FOUND_PAGE, 404),
    html(NOT_FOUND_PAGE),
    new Error("ECONNREFUSED"),
    html(SHELL, 200, { "content-type": "text/plain" }),
    new Response(null, { status: 503 }),
  ]);
  for (let i = 0; i < 6; i++) assert.equal(await loadShell(source(fetchImpl)), SHELL, `call ${i + 1}`);
  assert.equal(calls.length, 6, "every call fetches; nothing is served without asking the origin");
  for (const call of calls.slice(1)) assert.equal(new Headers(call.init.headers).get("if-none-match"), '"v1"');
});

test("a newer shell replaces the adopted one and its ETag", async () => {
  resetShellCacheForTests();
  const NEWER = SHELL.replace("index-abc123", "index-def456");
  const { fetchImpl, calls } = scripted([
    html(SHELL, 200, { etag: '"v1"' }),
    html(NEWER, 200, { etag: '"v2"' }),
    new Response(null, { status: 304 }),
  ]);
  assert.equal(await loadShell(source(fetchImpl)), SHELL);
  assert.equal(await loadShell(source(fetchImpl)), NEWER);
  assert.equal(await loadShell(source(fetchImpl)), NEWER);
  assert.equal(new Headers(calls[2].init.headers).get("if-none-match"), '"v2"');
});

test("a shell without an ETag is adopted and refetched in full", async () => {
  resetShellCacheForTests();
  const { fetchImpl, calls } = scripted([html(SHELL), html(SHELL)]);
  assert.equal(await loadShell(source(fetchImpl)), SHELL);
  assert.equal(await loadShell(source(fetchImpl)), SHELL);
  assert.equal(new Headers(calls[1].init.headers).get("if-none-match"), null);
});

test("resetShellCacheForTests forgets the adopted shell", async () => {
  resetShellCacheForTests();
  assert.equal(await loadShell(source(scripted([html(SHELL)]).fetchImpl)), SHELL);
  resetShellCacheForTests();
  await assert.rejects(loadShell(source(scripted([html(NOT_FOUND_PAGE)]).fetchImpl)));
});

/* ------------------------------------------------------------------------ */
/* warnIfOriginUnconfigured                                                  */

test("warnIfOriginUnconfigured speaks only in the emulator with no origin", () => {
  const lines = [];
  const log = (line) => lines.push(line);
  warnIfOriginUnconfigured({}, true, log);
  warnIfOriginUnconfigured({ BIKESHED_PUBLIC_ORIGIN: "" }, true, log);
  assert.deepEqual(lines, [
    "docShell: BIKESHED_PUBLIC_ORIGIN is unset — /d/** will answer 503; set BIKESHED_PUBLIC_ORIGIN=http://127.0.0.1:5050 in functions/.env.local",
    "docShell: BIKESHED_PUBLIC_ORIGIN is unset — /d/** will answer 503; set BIKESHED_PUBLIC_ORIGIN=http://127.0.0.1:5050 in functions/.env.local",
  ]);

  const silent = [];
  warnIfOriginUnconfigured({ BIKESHED_PUBLIC_ORIGIN: "http://127.0.0.1:5050" }, true, (l) => silent.push(l));
  warnIfOriginUnconfigured({}, false, (l) => silent.push(l));
  warnIfOriginUnconfigured({ BIKESHED_PUBLIC_ORIGIN: "http://127.0.0.1:5050" }, false, (l) => silent.push(l));
  assert.deepEqual(silent, []);
});

/* ------------------------------------------------------------------------ */
/* The handler                                                               */

test("docShell sets the public cache header only after the page is built", () => {
  /**
   * The handler needs Firestore and Storage, so it is not unit-tested end to
   * end: `wiring.test.js` pins `noStore(res)` first, and the emulator
   * walkthrough exercises it. This pins the other half of the discipline.
   *
   * `public, max-age=<n>` is set only once `renderShell` has returned. Set
   * earlier, a throw between the two — a version that vanished, a stream that
   * failed, a template missing its `</head>` — would fall back to the generic
   * shell with the public header already on it, and that broken page would be
   * cached at a public URL for the whole window.
   */
  const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
  const start = src.indexOf("export const docShell = onRequest(");
  assert.ok(start > 0, "docShell not found");
  const end = src.indexOf("\n});", start);
  const body = src.slice(start, end);

  const rendered = body.indexOf("renderShell(");
  const cached = body.indexOf('Cache-Control", `public');
  assert.ok(rendered > 0, "docShell must render the shell");
  assert.ok(cached > 0, "docShell must set a public Cache-Control for a document");
  assert.ok(rendered < cached, "docShell sets the public cache header before the page is built");
});
