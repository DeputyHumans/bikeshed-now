#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Eight tiers of guard against a forbidden string reaching the tree (SPEC §12).
set -uo pipefail

# Why `git grep` and not `grep -r`:
#   - it searches TRACKED files only, so gitignored build output and untracked
#     scratch cannot fail CI, and a string in app/dist is irrelevant because
#     app/dist is never committed;
#   - `-I` skips binaries, which tier 6 then handles deliberately rather than by
#     accident;
#   - it is present on every runner that has git, which is all of them.

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then RED=""; GREEN=""; DIM=""; OFF=""; fi

failures=0

fail() {
  failures=$((failures + 1))
  printf '%sbrand-guard: %s%s\n' "$RED" "$1" "$OFF"
}

note() { printf '%s  %s%s\n' "$DIM" "$1" "$OFF"; }

# ---------------------------------------------------------------------------
# 1. Core terms, in tracked content. Lockfiles INCLUDED: a dependency named
#    after the thing we are avoiding is exactly the case worth catching.
# ---------------------------------------------------------------------------
while IFS= read -r term; do
  case "$term" in ''|\#*) continue ;; esac
  if git grep -I -n -i -E -- "$term" -- ':!scripts/forbidden-terms.txt' >/tmp/bg.$$ 2>/dev/null; then
    fail "tier 1: forbidden term '$term' in tracked content"
    head -5 /tmp/bg.$$ | while IFS= read -r line; do note "$line"; done
  fi
done < scripts/forbidden-terms.txt
rm -f /tmp/bg.$$

# ---------------------------------------------------------------------------
# 2. Hostname-shaped "forge". Lockfiles are excluded HERE ONLY, because
#    node-forge is a legitimate transitive dependency of the firebase-admin
#    tree and matches any naive pattern.
# ---------------------------------------------------------------------------
if git grep -I -n -i -E -- '(^|[^a-z-])forge\.[a-z]' -- ':!*package-lock.json' >/tmp/bg.$$ 2>/dev/null; then
  fail "tier 2: a forge-shaped hostname appears in tracked content"
  head -5 /tmp/bg.$$ | while IFS= read -r line; do note "$line"; done
fi
rm -f /tmp/bg.$$

# ---------------------------------------------------------------------------
# 3. FILENAMES. `git grep` never sees a path, so a file called
#    a wordmark named after the company would pass every content scan ever written.
# ---------------------------------------------------------------------------
while IFS= read -r term; do
  case "$term" in ''|\#*) continue ;; esac
  if git ls-files | grep -i -E -- "$term" >/tmp/bg.$$ 2>/dev/null; then
    fail "tier 3: forbidden term '$term' in a tracked FILENAME"
    head -5 /tmp/bg.$$ | while IFS= read -r line; do note "$line"; done
  fi
done < scripts/forbidden-terms.txt
rm -f /tmp/bg.$$

# ---------------------------------------------------------------------------
# 4. Git HISTORY, including author and committer IDENTITIES — not just messages.
#    This is why the repo-local git config is set before the first commit: an
#    author field cannot be corrected without rewriting history.
# ---------------------------------------------------------------------------
if git rev-parse HEAD >/dev/null 2>&1; then
  while IFS= read -r term; do
    case "$term" in ''|\#*) continue ;; esac
    if git log --all --format='%H %an <%ae> %cn <%ce> %s%n%b' | grep -i -E -- "$term" >/tmp/bg.$$ 2>/dev/null; then
      fail "tier 4: forbidden term '$term' in git history (message or identity)"
      head -3 /tmp/bg.$$ | while IFS= read -r line; do note "$line"; done
    fi
  done < scripts/forbidden-terms.txt
  rm -f /tmp/bg.$$
fi

# ---------------------------------------------------------------------------
# 5. Attribution trailers. Nothing about how this was written belongs in the
#    permanent record of what it is.
# ---------------------------------------------------------------------------
if git rev-parse HEAD >/dev/null 2>&1; then
  if git log --all --format='%b' | grep -i -E '^(co-authored-by|claude-session|generated-by):' >/dev/null 2>&1; then
    fail "tier 5: an attribution trailer is present in git history"
  fi
fi

# ---------------------------------------------------------------------------
# 6. BINARY ALLOWLIST. Tiers 1-2 skip binaries with -I, so a forbidden string in
#    PNG metadata would be invisible to every other tier. Rather than trying to
#    parse every format, the set of tracked binaries is pinned and each one is
#    byte-scanned.
# ---------------------------------------------------------------------------
EXPECTED_BINARIES="app/public/brand/apple-touch-icon.png
app/public/brand/icon-192.png
app/public/brand/icon-512.png
app/public/fonts/bikeshed-sans-var.woff2"

ACTUAL_BINARIES="$(git ls-files | while IFS= read -r f; do
  case "$f" in *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.woff|*.woff2|*.ttf|*.otf|*.pdf|*.zip) printf '%s\n' "$f" ;; esac
done | sort)"

if [ "$ACTUAL_BINARIES" != "$(printf '%s\n' "$EXPECTED_BINARIES" | sort)" ]; then
  fail "tier 6: the tracked binary set changed"
  note "expected:"; printf '%s\n' "$EXPECTED_BINARIES" | while IFS= read -r l; do note "    $l"; done
  note "found:"; printf '%s\n' "$ACTUAL_BINARIES" | while IFS= read -r l; do note "    $l"; done
  note "update EXPECTED_BINARIES in this script once you have checked the new file."
fi

printf '%s\n' "$ACTUAL_BINARIES" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  while IFS= read -r term; do
    case "$term" in ''|\#*) continue ;; esac
    if LC_ALL=C strings -a "$f" 2>/dev/null | grep -i -q -E -- "$term"; then
      printf '%sbrand-guard: tier 6: forbidden term %s inside binary %s%s\n' "$RED" "$term" "$f" "$OFF"
      exit 1
    fi
  done < scripts/forbidden-terms.txt
done || failures=$((failures + 1))

# ---------------------------------------------------------------------------
# 7. Absolute local paths. This is what keeps the working directory's own name
#    out of tracked content, sourcemaps and documentation.
# ---------------------------------------------------------------------------
if git grep -I -n -E -- '/(Users|home)/[a-z][a-z0-9_-]*/' -- ':!scripts/check-brand.sh' >/tmp/bg.$$ 2>/dev/null; then
  fail "tier 7: an absolute local path appears in tracked content"
  head -5 /tmp/bg.$$ | while IFS= read -r line; do note "$line"; done
fi
rm -f /tmp/bg.$$

# ---------------------------------------------------------------------------
# 8. DEPLOYMENT BINDINGS, by SHAPE.
#
#    The project slug is a legitimate package name, so a literal match would
#    fire on it. What must never be committed is the binding between this source
#    and one deployment, and every form of that binding has a recognizable
#    shape. Matching the shape means a future project rename cannot quietly
#    reintroduce the leak.
# ---------------------------------------------------------------------------
# `allow` is a second pattern whose matches are forgiven. It exists so the
# guard can be PRECISE rather than excluding whole files: an emulator-only
# `demo-` host is fine, a real one is not, and excluding app/.env.example
# wholesale would have hidden both.
check_shape() {
  local label="$1" pattern="$2" allow="${3:-}"
  shift 3 2>/dev/null || shift $(( $# ))
  if git grep -I -n -E -- "$pattern" -- ':!scripts/check-brand.sh' >/tmp/bg.$$ 2>/dev/null; then
    if [ -n "$allow" ]; then
      grep -v -E -- "$allow" /tmp/bg.$$ > /tmp/bg2.$$ || true
      mv /tmp/bg2.$$ /tmp/bg.$$
    fi
    if [ -s /tmp/bg.$$ ]; then
      fail "tier 8: $label"
      head -5 /tmp/bg.$$ | while IFS= read -r line; do note "$line"; done
    fi
  fi
  rm -f /tmp/bg.$$
}

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

# .firebaserc is the file Firebase writes unprompted on `firebase use`, and it
# is the binding in its purest form. It is gitignored; this catches a --force.
if git ls-files | grep -q '^\.firebaserc$'; then
  fail "tier 8: .firebaserc is tracked; it binds this source to one project"
fi

if [ "$failures" -eq 0 ]; then
  printf '%sbrand-guard: clean%s\n' "$GREEN" "$OFF"
  exit 0
fi

printf '%sbrand-guard: %d failure(s)%s\n' "$RED" "$failures" "$OFF"
exit 1
