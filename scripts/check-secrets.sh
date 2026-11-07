#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Five tiers of guard against a secret or a deployment binding reaching the tree (SPEC §12).
set -uo pipefail

# Everything here matches by SHAPE, never by name.
#
# The predecessor of this file kept a list of literal strings that must not
# appear. A list like that has to be committed to be useful, and committing it
# publishes the very words it exists to suppress — it is its own first leak. It
# also cannot catch anything nobody thought to add.
#
# A shape has neither problem. `AIza…` is an API key whoever minted it, and a
# project rename cannot quietly reintroduce a binding that is matched on its
# form rather than its spelling.
#
# Why `git grep` and not `grep -r`:
#   - it searches TRACKED files only, so gitignored build output and untracked
#     scratch cannot fail CI, and a string in app/dist is irrelevant because
#     app/dist is never committed;
#   - `-I` skips binaries, which tier 5 then handles deliberately rather than by
#     accident;
#   - it is present on every runner that has git, which is all of them.

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then RED=""; GREEN=""; DIM=""; OFF=""; fi

failures=0
# This file necessarily contains every pattern it looks for, so it is the one
# path excluded from the content scans. It is also the one path nobody else
# reviews for them, which is why it holds patterns and never examples.
SELF=':!scripts/check-secrets.sh'
TMP="$(mktemp)"; TMP2="$(mktemp)"
trap 'rm -f "$TMP" "$TMP2"' EXIT

fail() {
  failures=$((failures + 1))
  printf '%scheck-secrets: %s%s\n' "$RED" "$1" "$OFF"
}

note() { printf '%s  %s%s\n' "$DIM" "$1" "$OFF"; }

# `allow` is a second pattern whose matches are forgiven. It exists so a tier
# can be PRECISE rather than excluding whole files: an emulator-only `demo-`
# host is fine, a real one is not, and excluding app/.env.example wholesale
# would have hidden both.
check_shape() {
  local label="$1" pattern="$2" allow="${3:-}"
  if git grep -I -n -E -- "$pattern" -- "$SELF" >"$TMP" 2>/dev/null; then
    if [ -n "$allow" ]; then
      grep -v -E -- "$allow" "$TMP" >"$TMP2" || true
      mv "$TMP2" "$TMP"
    fi
    if [ -s "$TMP" ]; then
      fail "$label"
      head -5 "$TMP" | while IFS= read -r line; do note "$line"; done
    fi
  fi
}

check_filename() {
  local label="$1" pattern="$2" allow="${3:-^$}"
  if git ls-files | grep -E -- "$pattern" | grep -v -E -- "$allow" >"$TMP" 2>/dev/null; then
    if [ -s "$TMP" ]; then
      fail "$label"
      head -5 "$TMP" | while IFS= read -r line; do note "$line"; done
    fi
  fi
}

# ---------------------------------------------------------------------------
# 1. DEPLOYMENT BINDINGS.
#
#    The code here is deployment-agnostic. What must never be committed is the
#    binding between this source and one particular Firebase project, and every
#    form of that binding has a recognizable shape.
# ---------------------------------------------------------------------------
# A Firebase host. `demo-` prefixed ids are emulator-only — Firebase refuses to
# point one at a real backend — so they are the one safe form.
check_shape "a Firebase Hosting or Storage hostname" \
  '[a-z0-9-]+\.(web\.app|firebaseapp\.com|firebasestorage\.app|appspot\.com)' \
  'demo-[a-z0-9-]+\.(web\.app|firebaseapp\.com|firebasestorage\.app|appspot\.com)'

# A literal bucket name. A template (gs://${bucket}, gs://<name>) is how the
# scripts and the documentation legitimately talk about one.
check_shape "a literal gs:// bucket name" \
  'gs://[a-z0-9][a-z0-9._-]*' \
  'gs://(\$|<|\{|demo-)'

check_shape "a Google API key" 'AIza[0-9A-Za-z_-]{20,}' ''

check_shape "a Firebase app id" '[0-9]{9,}:web:[0-9a-f]{8,}' '[0]{9,}:web:[0]{8,}'

check_shape "an Analytics measurement id" 'G-[A-Z0-9]{8,}' ''

# A trusted identity issuer (ADR 0026). Its URL ends in an id that names one
# organisation, so it lives in BIKESHED_ID_JAG_ISSUERS and never in the tree.
# Documentation writes the id as a placeholder, which this does not match.
check_shape "an organisation's identity issuer id" 'issuers/iss_[a-z0-9]{12,}' ''

# .firebaserc is the file Firebase writes unprompted on `firebase use`, and it
# is the binding in its purest form. It is gitignored; this catches a --force.
check_filename "a tracked .firebaserc binds this source to one project" \
  '(^|/)\.firebaserc$'

# ---------------------------------------------------------------------------
# 2. CREDENTIALS.
#
#    Not one of these belongs in any repository, so unlike tier 1 there is no
#    legitimate form to allow through.
# ---------------------------------------------------------------------------
check_shape "an OpenAI-shaped API key"  '(^|[^A-Za-z0-9])sk-[A-Za-z0-9]{20,}' ''
check_shape "a GitHub token"            '(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}' ''
check_shape "a Slack token"             'xox[baprs]-[A-Za-z0-9-]{10,}' ''
check_shape "an AWS access key id"      '(^|[^A-Z0-9])AKIA[0-9A-Z]{16}([^0-9A-Z]|$)' ''
check_shape "a private key block"       'BEGIN( [A-Z]+)? PRIVATE KEY' ''
check_shape "a service-account key"     '"(private_key|private_key_id)"[[:space:]]*:' ''
check_shape "a service-account marker"  '"type"[[:space:]]*:[[:space:]]*"service_account"' ''

# A dotenv file is where a real credential lands first. They are gitignored;
# only the .example variants may be tracked. This catches a --force.
check_filename "a tracked dotenv file" \
  '(^|/)\.env($|\.)' \
  '\.example$'

check_filename "a tracked key or service-account file" \
  '(^|/)(service-account[^/]*\.json|[^/]*\.(pem|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519))$'

# ---------------------------------------------------------------------------
# 3. ABSOLUTE LOCAL PATHS. This is what keeps the working directory's own name
#    out of tracked content, sourcemaps and documentation.
# ---------------------------------------------------------------------------
check_shape "an absolute local path" '/(Users|home)/[a-z][a-z0-9_-]*/' ''

# ---------------------------------------------------------------------------
# 4. ATTRIBUTION TRAILERS. Nothing about how this was written belongs in the
#    permanent record of what it is, and an author field cannot be corrected
#    without rewriting history.
# ---------------------------------------------------------------------------
if git rev-parse HEAD >/dev/null 2>&1; then
  if git log --all --format='%b' | grep -i -E '^(co-authored-by|claude-session|generated-by):' >/dev/null 2>&1; then
    fail "an attribution trailer is present in git history"
  fi
fi

# ---------------------------------------------------------------------------
# 5. BINARY ALLOWLIST. Tiers 1-3 skip binaries with -I, so a key pasted into
#    PNG metadata would be invisible to every other tier. Rather than trying to
#    parse every format, the set of tracked binaries is pinned: a new one has to
#    be added here consciously, by somebody who has looked at it.
# ---------------------------------------------------------------------------
EXPECTED_BINARIES="app/public/brand/apple-touch-icon.png
app/public/brand/icon-192.png
app/public/brand/icon-512.png
app/public/brand/og-default.png
app/public/fonts/bikeshed-sans-var.woff2
claude-plugin/.claude-plugin/icon.png"

ACTUAL_BINARIES="$(git ls-files | while IFS= read -r f; do
  case "$f" in *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.woff|*.woff2|*.ttf|*.otf|*.pdf|*.zip) printf '%s\n' "$f" ;; esac
done | sort)"

if [ "$ACTUAL_BINARIES" != "$(printf '%s\n' "$EXPECTED_BINARIES" | sort)" ]; then
  fail "the tracked binary set changed"
  note "expected:"; printf '%s\n' "$EXPECTED_BINARIES" | while IFS= read -r l; do note "    $l"; done
  note "found:"; printf '%s\n' "$ACTUAL_BINARIES" | while IFS= read -r l; do note "    $l"; done
  note "update EXPECTED_BINARIES in this script once you have checked the new file."
fi

if [ "$failures" -eq 0 ]; then
  printf '%scheck-secrets: clean%s\n' "$GREEN" "$OFF"
  exit 0
fi

printf '%scheck-secrets: %d failure(s)%s\n' "$RED" "$failures" "$OFF"
exit 1
