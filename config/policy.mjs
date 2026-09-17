// SPDX-License-Identifier: Apache-2.0
// Owns the identity gate: email shape, the optional domain allowlist, and the
// pure renderers that project both into the four generated artifacts (SPEC §1).

/**
 * Why this module is pure
 * -----------------------
 * `.rules` files cannot import and the Firebase toolchain has no preprocessor,
 * so the identity gate would otherwise be hand-copied into four places that can
 * silently drift — exactly the class of bug that lets a security boundary rot.
 *
 * Every function here is pure: it takes a policy object and returns a string.
 * That is what lets the rules tests render allowlist mode IN MEMORY and hand the
 * result straight to `initializeTestEnvironment`, with no temp file and no
 * second committed fixture that could itself drift.
 */

/** The shipped default: no allowlist, i.e. any verified account may sign in. */
export const DEFAULT_POLICY = Object.freeze({ allowedEmailDomains: [] });

/** Lowercase + trim. Every stored email is normalized through here. */
export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

const FORBIDDEN_CHARS = /[\s$#[\]/\\,;:"'<>()]/;
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]");
const LOCAL_OK = /^[a-z0-9!%&'*+=?^_`{|}~.-]+$/;
const DOMAIN_OK = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Structural validity, independent of policy. This is NOT an RFC 5322 parser;
 * it is the set of shapes this system can store and key on.
 *
 * The `$ # [ ] /` rejection is load-bearing rather than fussy: the presence
 * mirror (SPEC §16) keys an RTDB node by email, and those five characters are
 * illegal in an RTDB key. Rejecting them here is what guarantees every email the
 * system stores is representable as a key, so presence can never half-work for
 * an address the ACL happily accepted.
 */
export function isEmailShapeValid(email) {
  const e = normalizeEmail(email);
  if (e.length === 0 || e.length > 254) return false;
  if (FORBIDDEN_CHARS.test(e)) return false;
  if (CONTROL_CHARS.test(e)) return false;
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@")) return false;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length === 0 || local.length > 64) return false;
  if (e.includes("..")) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false;
  if (!LOCAL_OK.test(local)) return false;
  return DOMAIN_OK.test(domain);
}

/** Escape a literal for embedding in a regular expression. */
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Anchored regex SOURCE matching one allowlist entry.
 *
 * Anchoring is the whole point: an unanchored `example[.]com` would match
 * `attacker@evil.example.com.attacker.net`. A leading dot (`.example.com`) is
 * the explicit opt-in to subdomains; without it, only the exact domain matches.
 */
export function domainPattern(entry) {
  const raw = String(entry ?? "").trim().toLowerCase();
  const bare = raw.startsWith(".") ? raw.slice(1) : raw;
  const base = reEscape(bare).replace(/\\\./g, "[.]");
  return raw.startsWith(".")
    ? `^[^@]+@([^@]+[.])?${base}$`
    : `^[^@]+@${base}$`;
}

/** True when the policy imposes no restriction (the shipped default). */
export function isOpenPolicy(policy) {
  const list = policy?.allowedEmailDomains;
  return !Array.isArray(list) || list.length === 0;
}

/**
 * Policy check. Shape is validated separately and always applies; this only
 * answers "is this address permitted by the deployment's allowlist", which for
 * an open policy is unconditionally yes.
 */
export function isAllowedEmail(email, policy = DEFAULT_POLICY) {
  const e = normalizeEmail(email);
  if (!isEmailShapeValid(e)) return false;
  if (isOpenPolicy(policy)) return true;
  return policy.allowedEmailDomains.some((d) => new RegExp(domainPattern(d)).test(e));
}

// --- Renderers -------------------------------------------------------------
// Each takes the policy and returns the exact bytes of one generated artifact.

/**
 * Literal substitution. Deliberately split/join rather than String.replace:
 * every rendered pattern here contains `$`, and replace() would read `$\'` in a
 * replacement string as "the text after the match" and silently truncate the
 * output. That failure is invisible in an open-policy build, where the affected
 * clause is empty — it would surface only on the first deployment that actually
 * configures an allowlist, i.e. the one where getting the gate right matters.
 */
function subst(text, pairs) {
  let out = text;
  for (const [needle, value] of Object.entries(pairs)) {
    out = out.split(needle).join(value);
  }
  return out;
}

const BANNER_LINES = [
  "GENERATED — DO NOT EDIT.",
  "Rendered by tools/build-policy.mjs from config/access-policy.json.",
  "Edit the source and run `npm run build:policy`; CI byte-compares this file.",
];

function banner(prefix, sourceHash) {
  return [...BANNER_LINES, `source sha256: ${sourceHash}`]
    .map((l) => `${prefix}${l}`)
    .join("\n");
}

/** The extra conjunct isVerifiedUser() carries when an allowlist is configured. */
export function firestoreGateClauses(policy) {
  if (isOpenPolicy(policy)) return "";
  const checks = policy.allowedEmailDomains
    .map((d) => `          || request.auth.token.email.lower().matches('${domainPattern(d)}')`)
    .join("\n");
  return ["", "        && (", "          false", checks, "        )"].join("\n");
}

export function renderFirestoreRules(policy, template, sourceHash) {
  return subst(template, {
    "@@BANNER@@": banner("// ", sourceHash),
    "@@GATE_CLAUSES@@": firestoreGateClauses(policy),
  });
}

/** The RTDB-rules expression fragment for the policy half of the gate. */
export function databaseGateClause(policy) {
  if (isOpenPolicy(policy)) return "true";
  const checks = policy.allowedEmailDomains
    .map((d) => `auth.token.email.toLowerCase().matches(/${domainPattern(d)}/)`)
    .join(" || ");
  return `(${checks})`;
}

/**
 * Strip whole-line `//` comments. The Realtime Database rules format accepts
 * them and they carry most of the reasoning in that file, so the output keeps
 * them; this copy exists only so the renderer can JSON.parse and reject a
 * malformed result before it reaches a deploy.
 */
function stripLineComments(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

export function renderDatabaseRules(policy, template, sourceHash) {
  const rendered = subst(template, {
    "@@BANNER@@": banner("// ", sourceHash),
    "@@POLICY@@": databaseGateClause(policy),
  });
  // Validate rather than reformat: a broken database.rules.json fails at deploy
  // time, which is far too late to find out.
  JSON.parse(stripLineComments(rendered));
  return rendered.endsWith("\n") ? rendered : rendered + "\n";
}

/**
 * The server-side mirror. Functions needs its own copy under `functions/src/`
 * because Cloud Functions uploads only that directory and tsconfig pins
 * `rootDir: "src"` — a shared module one level up is simply not deployed.
 */
/**
 * Emit `isEmailShapeValid` from THIS module's own implementation rather than
 * retyping it, so the three runtimes cannot disagree about which addresses
 * exist. The body is stringified, not re-authored.
 */
function emitShapeValidator() {
  const body = subst(isEmailShapeValid.toString(), {
    "function isEmailShapeValid(email) {":
      "export function isEmailShapeValid(email: string): boolean {",
    "const e = normalizeEmail(email);": "const e = email.trim().toLowerCase();",
  });
  return [
    `const FORBIDDEN_CHARS = ${FORBIDDEN_CHARS.toString()};`,
    `const CONTROL_CHARS = new RegExp(${JSON.stringify(CONTROL_CHARS.source)});`,
    `const LOCAL_OK = ${LOCAL_OK.toString()};`,
    `const DOMAIN_OK = ${DOMAIN_OK.toString()};`,
    "",
    "/** Structural validity: the shapes this system can store and key on (SPEC §1.3). */",
    body,
  ].join("\n");
}

export function renderFunctionsPolicy(policy, sourceHash) {
  const list = isOpenPolicy(policy) ? [] : policy.allowedEmailDomains.map(String);
  const matchers =
    list.length === 0
      ? ""
      : `\n${list.map((d) => `  /${domainPattern(d)}/,`).join("\n")}\n`;
  return `// SPDX-License-Identifier: Apache-2.0
${banner("// ", sourceHash)}
// The deployment's identity policy, server side (SPEC §1).

export const ALLOWED_EMAIL_DOMAINS: readonly string[] = ${JSON.stringify(list)};

export const POLICY_IS_OPEN = ${list.length === 0};

${emitShapeValidator()}

/** Anchored per-entry matchers, precompiled once. */
const MATCHERS: readonly RegExp[] = [${matchers}];

/**
 * True iff this deployment accepts the address.
 *
 * Shape is checked FIRST and always: an open policy accepts any address the
 * system can actually store, not any string. Without that conjunct
 * \`isAllowedEmail("not an email")\` would be true on the default configuration,
 * and the value would flow straight into an ACL array.
 */
export function isAllowedEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!isEmailShapeValid(e)) return false;
  if (POLICY_IS_OPEN) return true;
  return MATCHERS.some((re) => re.test(e));
}
`;
}

/**
 * The client mirror. It carries the SHAPE rules and a single boolean — never the
 * domain list. Vite inlines everything it imports into the public bundle, so a
 * list here would publish the deployment's membership policy to every anonymous
 * visitor. The client learns policy outcomes from POST /session instead.
 */
export function renderAppPolicy(policy, sourceHash) {
  return `// SPDX-License-Identifier: Apache-2.0
${banner("// ", sourceHash)}
// The client's half of the identity policy (SPEC §1.2).
//
// Deliberately list-free: Vite inlines this module into the public bundle, so
// the allowlist itself must never appear here. The client gets the shape rules
// (so a sign-up form can validate before a round trip) and one boolean. It
// learns policy OUTCOMES from POST /session, which returns a typed status
// rather than an explanation.

export const POLICY_IS_OPEN = ${isOpenPolicy(policy)};

${emitShapeValidator()}
`;
}
