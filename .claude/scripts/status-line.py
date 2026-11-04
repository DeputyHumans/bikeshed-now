#!/usr/bin/env python3
# mission-control-version: 1.4.0
"""ACF Mission Control - Status Line HUD

Two-line "Mission Control" status line for Claude Code.

Line 1 (identity):  model · badges · directory · git branch · PR · acf-whip run
Line 2 (telemetry): context trend · cost · prompt cache · rate limits · spend · duration · lines

Driven by the JSON Claude Code sends on stdin (https://code.claude.com/docs/en/statusline), the
options you set for this plugin in /config, and a self-computed cost figure. Claude Code only
prices models it ships rates for, so anything behind a proxy (`nebius/zai-org/GLM-5.2`, ...) reads
as ~$0.00. When the LiteLLM price map resolves the live model id, the HUD prices the session
itself from transcript token usage, subagent and workflow transcripts included, and marks the
figure `≈`. A trailing `?` marks a total the table could not price exactly.

The context gauge measures against the point where Claude Code auto-compacts, not the full
window: `used_percentage` keeps measuring the whole window even when compaction runs earlier.

Extra modes (not the HUD):
  --subagents               render the agent panel's rows (the subagentStatusLine command)
  --preview                 render sample HUDs in every glyph theme at the current COLUMNS
  --refresh-prices          fetch + distill the LiteLLM price map into the cache
  --price-check <model-id>  show which price entry a model id maps onto

Requirements: Python 3.6+, standard library only. Network is optional: with no cached price map
the HUD falls back to Claude Code's own cost figure.
"""

import json
import math
import os
import re
import subprocess
import sys
import time
import unicodedata

# --------------------------------------------------------------------------- #
# Defaults. Set your own in /config (the plugin's options): they are read on   #
# every render and survive upgrades. Edits here are replaced by the next       #
# upgrade, except `price_map: False`, which the installer carries forward.     #
# --------------------------------------------------------------------------- #
CONFIG = {
    # Segments (model, directory and the context gauge always show)
    "cost": True,          # session cost
    "rate_limits": True,   # 5h / 7d usage and gateway spend limit (hidden when absent)
    "git": True,           # branch, ahead/behind, modified / staged / untracked counts
    "cache": True,         # prompt-cache countdown and the cost of letting it go cold
    "duration": True,      # session wall-clock
    "lines": True,         # +added/-removed
    "badges": True,        # fast mode, effort, output style, agent
    "pr": True,            # open pull request, clickable
    "acf_status": True,    # acf-whip autopilot round and a live /go run

    # Presentation
    "glyphs": "sleek",     # icon theme: sleek | emoji | nerd | text
    "color": True,         # master color switch (also honors NO_COLOR env var)
    "layout": "auto",      # auto (two lines at 100+ columns) | two-line | one-line
    "spark_width": 8,      # prompts shown in the context trend

    # Thresholds
    "ctx_warn": 70,        # % of the auto-compact point: yellow at/above
    "ctx_crit": 90,        # % of the auto-compact point: red at/above
    "cost_warn": 5.0,      # $: yellow at/above
    "cost_crit": 20.0,     # $: red at/above
    "compact_at": "auto",  # auto, or a token count such as 500k when you launch with --autocompact

    # Cost accuracy — price the session from the LiteLLM map instead of trusting
    # Claude Code's figure, which is ~$0.00 for any model it has no rates for.
    "price_map": True,     # False -> always show Claude Code's own cost, never fetch
    "price_ttl": 86400,    # seconds before the cached price map is refreshed
    "price_aliases": {},   # {"nebius/zai-org/GLM-5.2": "zai/glm-5.2"} — pin a mapping
}

PLUGIN_ID = "acf-mission-control"

# Upstream rate table. Keys are `provider/model` or bare model names; the leading
# segments are routing, not identity, so `nebius/zai-org/GLM-5.2` prices as GLM-5.2.
PRICE_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/"
    "model_prices_and_context_window.json"
)
PRICE_FORMAT = 2       # bump when distill_prices keeps new fields; older caches refresh
FETCH_TIMEOUT = 8      # seconds; the refresher runs detached, never the HUD
LOCK_TTL = 600         # seconds a refresh may hold the fetch before others retry
DEDUP_WINDOW = 20000   # cap on remembered requestIds; a bound, not a working set
GIT_TTL = 5            # seconds a git probe is reused (Claude Code's own recommendation)
LONG_CONTEXT = 200000  # input tokens above which some rate entries bill a higher tier
DEFAULT_1M_COMPACT = 967000  # native-1M models compact "at about 967K tokens by default"
GO_LOCK_FRESH = 1800   # seconds; /go treats a run lock younger than 30 min as live
WIDTH_MARGIN = 4       # columns Claude Code's own row spacing takes from COLUMNS

# --------------------------------------------------------------------------- #
# ANSI palette                                                                 #
# --------------------------------------------------------------------------- #
RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
RED = "\033[91m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
MAGENTA = "\033[95m"
CYAN = "\033[96m"

# Distinct color per model family — match family name only, never version digits.
MODEL_COLORS = {
    "opus": MAGENTA + BOLD,   # premium / expensive
    "sonnet": CYAN,
    "haiku": GREEN,
    "fable": BLUE,
}

# --------------------------------------------------------------------------- #
# Glyph themes — every segment's icon resolves through here so the look is one #
# switch (the `glyphs` option). Glyphs inherit their segment's ANSI color; an  #
# empty string means "no icon" (the spacing helper drops the would-be space).  #
#                                                                              #
#   sleek  monochrome geometric — default; standard Unicode, no special font   #
#   emoji  the original pictographs (regression-preserving)                    #
#   nerd   Nerd Font private-use glyphs — REQUIRES a Nerd Font installed       #
#   text   no pictographs at all; color + labels carry the meaning             #
# --------------------------------------------------------------------------- #
_COMMON = {
    "modified": "✎", "staged": "⊕", "untracked": "?", "conflict": "!",
    "ahead": "↑", "behind": "↓", "reset": "↻",
}
GLYPHS = {
    "sleek": dict(_COMMON, **{
        "model": "◆", "dir": "▸", "branch": "⎇",
        "cost": "", "dur": "",
        "warm": "●", "cooling": "◐", "cold": "○",
        "fast": "ϟ", "auto": "⟳", "paused": "‖", "go": "▶",
    }),
    "emoji": dict(_COMMON, **{
        "model": "🚀", "dir": "📁", "branch": "🌿",
        "cost": "💰", "dur": "⏱",
        "warm": "🔥", "cooling": "🔥", "cold": "❄",
        "fast": "⚡", "auto": "🔁", "paused": "⏸", "go": "🏁",
    }),
    "nerd": dict(_COMMON, **{
        # FontAwesome glyphs from any Nerd Font; render as boxes without one.
        # Escaped: private-use characters do not survive every editor and pipe.
        "model": "\uf135", "dir": "\uf07b", "branch": "\uf126",
        "cost": "\uf155", "dur": "\uf017",
        "warm": "\uf06d", "cooling": "\uf06d", "cold": "\uf2dc",
        "fast": "\uf0e7", "auto": "\uf021", "paused": "\uf04c", "go": "\uf04b",
    }),
    "text": dict(_COMMON, **{
        "model": "", "dir": "", "branch": "",
        "cost": "", "dur": "",
        "warm": "", "cooling": "", "cold": "",
        "fast": "", "auto": "", "paused": "", "go": "",
    }),
}

SPARK = "▁▂▃▄▅▆▇█"

# Render-wide style, set once per run by apply_style() from the loaded config.
STYLE = {"color": True, "glyph": GLYPHS["sleek"], "anchor": True}


def apply_style(cfg):
    STYLE["color"] = bool(cfg.get("color")) and not os.environ.get("NO_COLOR")
    STYLE["glyph"] = GLYPHS.get(cfg.get("glyphs"), GLYPHS["sleek"])
    # Structural anchor colors give each line-1 leading glyph a stable identity hue
    # (model = its family color, dir = blue, branch = cyan). Scoped to the line-art
    # themes: emoji glyphs keep their own built-in color, text has no glyph to paint.
    STYLE["anchor"] = cfg.get("glyphs") in ("sleek", "nerd")


def G(name):
    return STYLE["glyph"].get(name, "")


def lead(glyph):
    """Prefix an icon with a trailing space — or emit nothing for empty icons."""
    return (glyph + " ") if glyph else ""


def anchor(glyph, color):
    """Leading icon in its structural color (line-art themes), with a space."""
    if not glyph:
        return ""
    return (paint(glyph, color) if STYLE["anchor"] else glyph) + " "


def paint(text, color):
    """Wrap text in an ANSI color (no-op when color is disabled or empty)."""
    if not STYLE["color"] or not color:
        return text
    return "{}{}{}".format(color, text, RESET)


def link(text, url):
    """OSC 8 hyperlink (Cmd/Ctrl+click in terminals that support it)."""
    if not url:
        return text
    return "\033]8;;{}\a{}\033]8;;\a".format(url, text)


def zone_color(value, warn, crit):
    """Green/yellow/red by health zone."""
    if value >= crit:
        return RED
    if value >= warn:
        return YELLOW
    return GREEN


def g(data, path, default=None):
    """Safe dotted lookup: g(data, 'a.b.c'). Returns default on any miss/None."""
    cur = data
    for key in path.split("."):
        if not isinstance(cur, dict) or cur.get(key) is None:
            return default
        cur = cur[key]
    return cur


def num(value):
    """A real, finite number, or None (rejects bools, strings, NaN and infinities)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def gs(data, path, default=""):
    """g() for a string field: a number or a list where text belongs reads as the default."""
    value = g(data, path)
    return value if isinstance(value, str) else default


def safe(build, *args):
    """One malformed field costs its own segment, never the whole HUD."""
    try:
        return build(*args)
    except Exception:  # noqa: BLE001 - a status line must always print something
        return None


def now_ts():
    """Wall clock, overridable for tests and the preview (MC_NOW, epoch seconds)."""
    try:
        return float(os.environ["MC_NOW"])
    except (KeyError, ValueError):
        return time.time()


def model_family(name):
    low = (name or "").lower()
    for family in MODEL_COLORS:
        if family in low:
            return family
    return None


def model_color(name):
    return MODEL_COLORS.get(model_family(name), CYAN)


def fmt_tok(n):
    """142300 -> '142k', 967000 -> '967k', 999500 -> '1M', 1000000 -> '1M'."""
    n = int(n or 0)
    if n >= 999500:
        return "{:g}M".format(round(n / 1e6, 2))
    if n >= 1000:
        return "{}k".format(int(round(n / 1000.0)))
    return str(n)


def fmt_duration(ms):
    secs = max(0, int(ms)) // 1000
    mins, _ = divmod(secs, 60)
    hours, mins = divmod(mins, 60)
    if hours:
        return "{}h{:02d}m".format(hours, mins)
    return "{}m".format(mins)


def fmt_span(seconds):
    """A countdown: '<1m', '52m', '1h40m', '3d4h', '12d'."""
    s = max(0, int(seconds))
    if s < 60:
        return "<1m"
    m = s // 60
    if m < 60:
        return "{}m".format(m)
    h, m = divmod(m, 60)
    if h < 24:
        return "{}h{:02d}m".format(h, m) if m else "{}h".format(h)
    d, h = divmod(h, 24)
    if d < 10 and h:
        return "{}d{}h".format(d, h)
    return "{}d".format(d)


def fmt_clock(epoch, now):
    """Local wall-clock time of an event, with the weekday when it is not today-ish."""
    fmt = "%a %H:%M" if epoch - now > 20 * 3600 else "%H:%M"
    return time.strftime(fmt, time.localtime(epoch))


# --------------------------------------------------------------------------- #
# Options — /config writes them to pluginConfigs in user (or managed)          #
# settings. The status line is not a hook, so CLAUDE_PLUGIN_OPTION_* never     #
# reaches it: it reads the settings files itself, on every render.             #
# --------------------------------------------------------------------------- #
def claude_config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def managed_settings_path():
    override = os.environ.get("MC_MANAGED_SETTINGS")
    if override is not None:
        return override
    if sys.platform == "darwin":
        return "/Library/Application Support/ClaudeCode/managed-settings.json"
    if os.name == "nt":
        base = os.environ.get("ProgramFiles") or r"C:\Program Files"
        return os.path.join(base, "ClaudeCode", "managed-settings.json")
    return "/etc/claude-code/managed-settings.json"


def read_json(path):
    if not path:
        return None
    try:
        with open(path) as fh:
            value = json.load(fh)
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def plugin_options(settings):
    """This plugin's /config answers in one settings file, under any marketplace name."""
    out = {}
    configs = (settings or {}).get("pluginConfigs")
    if not isinstance(configs, dict):
        return out
    for key, entry in configs.items():
        if not isinstance(key, str) or key.split("@", 1)[0] != PLUGIN_ID:
            continue
        options = entry.get("options") if isinstance(entry, dict) else None
        if isinstance(options, dict):
            out.update(options)
    return out


def parse_aliases(value):
    """`model=key, model2=key2` (the /config form) or a dict -> {model: key}."""
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items()}
    items = value if isinstance(value, list) else str(value or "").split(",")
    out = {}
    for item in items:
        model, sep, key = str(item).partition("=")
        if sep and model.strip() and key.strip():
            out[model.strip()] = key.strip()
    return out


def coerce(default, value):
    """Fit a settings value to the type of its default; an unusable one keeps the default."""
    if isinstance(default, bool):
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ("true", "1", "yes", "on"):
            return True
        if text in ("false", "0", "no", "off"):
            return False
        return default
    if isinstance(default, (int, float)):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return default
        if math.isnan(number) or math.isinf(number):
            return default
        return int(number) if isinstance(default, int) else number
    if isinstance(default, dict):
        return parse_aliases(value)
    return str(value).strip() if value is not None else default


def load_config(user_settings=None):
    """Defaults, then the user's pluginConfigs, then managed ones: managed settings win, as
    they do everywhere in Claude Code (an organization's `price_map: false` must hold)."""
    cfg = dict(CONFIG)
    if user_settings is None:
        user_settings = read_json(os.path.join(claude_config_dir(), "settings.json"))
    for settings in (user_settings, read_json(managed_settings_path())):
        for key, value in plugin_options(settings).items():
            if key in CONFIG:
                cfg[key] = coerce(CONFIG[key], value)
    return cfg


# --------------------------------------------------------------------------- #
# Width — Claude Code passes the terminal size in COLUMNS/LINES; tput can't     #
# see it from inside the captured process.                                     #
# --------------------------------------------------------------------------- #
ESCAPES = re.compile(r"\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)")


def visible_width(text):
    width = 0
    for ch in ESCAPES.sub("", text):
        code = ord(ch)
        if unicodedata.combining(ch) or code in (0xFE0F, 0x200D):
            continue
        if unicodedata.east_asian_width(ch) in ("W", "F") or 0x1F300 <= code <= 0x1FAFF:
            width += 2
        else:
            width += 1
    return width


def truncate(text, width):
    """Plain text cut to a visible width, ending in an ellipsis when it had to cut."""
    if visible_width(text) <= width:
        return text
    out, used = [], 0
    for ch in text:
        w = visible_width(ch)
        if used + w > width - 1:
            break
        out.append(ch)
        used += w
    return "".join(out) + "…"


def columns():
    try:
        cols = int(os.environ.get("COLUMNS") or 0)
    except ValueError:
        cols = 0
    return cols if cols > 0 else 120


SEP_PLAIN = " · "


def fit(segments, width):
    """Drop the lowest-priority segments until the line fits. Never cuts one mid-way.

    `segments` is a list of (priority, text) in display order; ties drop the later one.
    """
    segs = [s for s in segments if s and s[1]]
    while len(segs) > 1:
        total = sum(visible_width(t) for _, t in segs) + len(SEP_PLAIN) * (len(segs) - 1)
        if total <= width:
            break
        lowest = min(range(len(segs)), key=lambda i: (segs[i][0], -i))
        del segs[lowest]
    return [t for _, t in segs]


# --------------------------------------------------------------------------- #
# State — per session, in the user's own cache directory (mode 0700), never a  #
# predictable name in a shared /tmp.                                           #
# --------------------------------------------------------------------------- #
def price_cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache"
    )
    return os.path.join(base, "acf-mission-control")


def state_dir():
    path = os.path.join(price_cache_dir(), "state")
    try:
        os.makedirs(path, mode=0o700, exist_ok=True)
    except OSError:
        pass
    return path


def state_path(session_id, kind):
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id or "nosess")[:80]
    return os.path.join(state_dir(), "{}.{}".format(sid, kind))


def write_json(path, blob):
    """Atomic replace; a failed write leaves the previous state in place."""
    tmp = "{}.{}.tmp".format(path, os.getpid())
    try:
        with open(tmp, "w") as fh:
            json.dump(blob, fh, separators=(",", ":"))
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Git — one `git status --porcelain=v2 --branch`, cached per session for 5s.   #
# GIT_OPTIONAL_LOCKS=0 keeps it from taking index.lock away from a real writer.#
# --------------------------------------------------------------------------- #
GIT_EMPTY = {"branch": "", "ahead": 0, "behind": 0, "staged": 0, "modified": 0,
             "untracked": 0, "conflicts": 0}


def parse_porcelain(text):
    info = dict(GIT_EMPTY)
    oid = ""
    for line in text.split("\n"):
        if line.startswith("# branch.head "):
            info["branch"] = line[len("# branch.head "):].strip()
        elif line.startswith("# branch.oid "):
            oid = line[len("# branch.oid "):].strip()
        elif line.startswith("# branch.ab "):
            for part in line[len("# branch.ab "):].split():
                try:
                    if part.startswith("+"):
                        info["ahead"] = int(part[1:])
                    elif part.startswith("-"):
                        info["behind"] = int(part[1:])
                except ValueError:
                    pass
        elif line[:2] in ("1 ", "2 ") and len(line) > 3:
            if line[2] != ".":
                info["staged"] += 1
            if line[3] != ".":
                info["modified"] += 1
        elif line.startswith("u "):
            info["conflicts"] += 1
        elif line.startswith("? "):
            info["untracked"] += 1
    if info["branch"] == "(detached)":
        info["branch"] = "@" + oid[:7] if oid and oid != "(initial)" else "(detached)"
    return info


def git_info(cwd, session_id, now):
    path = state_path(session_id, "git")
    cached = read_json(path)
    try:
        fresh = cached is not None and cached.get("cwd") == cwd and (
            now - os.path.getmtime(path)) <= GIT_TTL
    except OSError:
        fresh = False
    if fresh:
        return {k: cached.get(k, v) for k, v in GIT_EMPTY.items()}

    info = dict(GIT_EMPTY)
    try:
        proc = subprocess.run(
            ["git", "-C", cwd or ".", "status", "--porcelain=v2", "--branch"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"),
            timeout=2,
        )
        if proc.returncode == 0:
            info = parse_porcelain(proc.stdout.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 - no git, not a repo, or too slow: show no branch
        pass
    write_json(path, dict(info, cwd=cwd))
    return info


# --------------------------------------------------------------------------- #
# Price map — a distilled copy of LiteLLM's rate table on disk.                #
# The raw file is 1.6MB of mostly capability flags; we keep the rates that     #
# bill tokens, which parses in single-digit milliseconds per render.           #
# --------------------------------------------------------------------------- #
RATE_FIELDS = (
    ("i", "input_cost_per_token"),
    ("o", "output_cost_per_token"),
    ("r", "cache_read_input_token_cost"),
    ("w", "cache_creation_input_token_cost"),
    ("w1h", "cache_creation_input_token_cost_above_1hr"),
    # Long-context tier: a request whose input passes 200k bills at these instead.
    ("iL", "input_cost_per_token_above_200k_tokens"),
    ("oL", "output_cost_per_token_above_200k_tokens"),
    ("rL", "cache_read_input_token_cost_above_200k_tokens"),
    ("wL", "cache_creation_input_token_cost_above_200k_tokens"),
    ("w1hL", "cache_creation_input_token_cost_above_1hr_above_200k_tokens"),
)
TOKEN_KEYS = ("i", "o", "r", "w5", "w1h", "ws")


def price_cache_path():
    return os.path.join(price_cache_dir(), "prices.json")


def distill_prices(raw):
    """Strip the rate table down to the fields that bill tokens."""
    out = {}
    for key, spec in raw.items():
        if key == "sample_spec" or not isinstance(spec, dict):
            continue
        entry = {}
        for short, full in RATE_FIELDS:
            val = spec.get(full)
            if isinstance(val, (int, float)):
                entry[short] = val
        # Presence isn't pricing: rerank/image tiers and free placeholders publish
        # an explicit 0.0 per token. Keeping them lets a basename collision resolve
        # a real model onto a $0 card and render a confident `≈$0.00` — the exact
        # failure this whole segment exists to remove. Demand a non-zero rate.
        if not entry.get("i") and not entry.get("o"):
            continue
        search = spec.get("search_context_cost_per_query")
        if isinstance(search, dict):
            val = search.get("search_context_size_medium")
            if isinstance(val, (int, float)):
                entry["s"] = val
        provider = spec.get("litellm_provider")
        if isinstance(provider, str):
            entry["p"] = provider
        # Speed/region multipliers, e.g. {"us": 1.1, "fast": 2.0} — fast mode
        # bills the same model at double rate, which is not a rounding error.
        mult = spec.get("provider_specific_entry")
        if isinstance(mult, dict):
            keep = {
                k: v for k, v in mult.items() if isinstance(v, (int, float)) and v > 0
            }
            if keep:
                entry["m"] = keep
        out[key] = entry
    return out


def refresh_prices():
    """Fetch, distill and atomically install the price map. Never raises.

    The lock file is a last-attempt timestamp, never cleared: concurrent sessions
    cooperate, and an offline machine retries at most once per LOCK_TTL instead of
    spawning a doomed fetch on every render.
    """
    import urllib.request

    lock = os.path.join(price_cache_dir(), "prices.lock")
    try:
        os.makedirs(price_cache_dir(), exist_ok=True)
        if os.path.exists(lock) and (time.time() - os.path.getmtime(lock)) < LOCK_TTL:
            return False
        with open(lock, "w") as fh:
            fh.write(str(int(time.time())))
    except OSError:
        return False

    try:
        request = urllib.request.Request(
            PRICE_URL, headers={"User-Agent": "acf-mission-control"}
        )
        raw = urllib.request.urlopen(request, timeout=FETCH_TIMEOUT).read()
        models = distill_prices(json.loads(raw.decode("utf-8")))
        if not models:
            return False
        tmp = "{}.{}.tmp".format(price_cache_path(), os.getpid())
        with open(tmp, "w") as fh:
            json.dump(
                {"fetched": int(time.time()), "source": PRICE_URL, "v": PRICE_FORMAT,
                 "models": models},
                fh,
                separators=(",", ":"),
            )
        os.replace(tmp, price_cache_path())
        return True
    except Exception:  # noqa: BLE001 - a stale map beats a broken status line
        return False


_PRICES = {}


def load_price_blob():
    if "blob" not in _PRICES:
        blob = read_json(price_cache_path())
        _PRICES["blob"] = blob if isinstance(blob, dict) else None
    return _PRICES["blob"]


def load_prices():
    blob = load_price_blob()
    models = blob.get("models") if blob else None
    return models if isinstance(models, dict) else None


def prices_age():
    """Seconds since the cached map was written, or None when there is none."""
    try:
        return time.time() - os.path.getmtime(price_cache_path())
    except OSError:
        return None


def prices_stale(ttl):
    age = prices_age()
    if age is None or age > ttl:
        return True
    blob = load_price_blob()
    # A map distilled by an older build lacks fields this one bills with.
    return not blob or blob.get("v", 1) < PRICE_FORMAT


def spawn_refresh():
    """Kick off a detached refresh — the HUD must never wait on the network."""
    try:
        subprocess.Popen(
            [sys.executable or "python3", os.path.abspath(__file__), "--refresh-prices"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception:  # noqa: BLE001 - non-blocking by design
        pass


def price_index(models):
    """Lookup tables built once per render: exact (lowercased) and by basename."""
    lower, base = {}, {}
    for key in models:
        lower[key.lower()] = key
        base.setdefault(key.rsplit("/", 1)[-1].lower(), []).append(key)
    return {"models": models, "lower": lower, "base": base}


def resolve_model(model_id, idx, aliases=None):
    """Map a live model id onto a price-map key. Returns (key, how) or (None, None).

    Provider prefixes are routing, not identity: `nebius/zai-org/GLM-5.2` is
    GLM-5.2 served by nebius, so segments are dropped left to right until a rate
    entry matches, then the bare model name is looked up wherever it is published.

    A trailing bracket is a context-window variant, not a different model:
    `claude-opus-5[1m]` bills on the `claude-opus-5` card, so it is tried both
    ways — as given first, in case a table ever publishes the decorated id.
    """
    if not model_id or not idx:
        return None, None

    aliases = aliases if aliases is not None else (CONFIG.get("price_aliases") or {})
    alias = aliases.get(model_id) or aliases.get(model_id.lower())
    if alias and alias in idx["models"]:
        return alias, "alias"

    forms = [model_id]
    if model_id.endswith("]") and "[" in model_id:
        bare = model_id[: model_id.rindex("[")].strip()
        if bare:
            forms.append(bare)

    for form in forms:
        segments = form.split("/")
        for start in range(len(segments)):
            hit = idx["lower"].get("/".join(segments[start:]).lower())
            if hit:
                exact = start == 0 and form == model_id
                return hit, "exact" if exact else "suffix"

    candidates = None
    for form in forms:
        segments = form.split("/")
        candidates = idx["base"].get(segments[-1].lower())
        if candidates:
            break
    if not candidates:
        return None, None

    prefixes = set(seg.lower() for seg in segments[:-1])

    def rank(key):
        spec = idx["models"][key]
        # Prefer the provider actually serving it, then the most complete rates,
        # then alphabetical so the same id always resolves the same way.
        return (0 if (spec.get("p") or "").lower() in prefixes else 1, -len(spec), key)

    return sorted(candidates, key=rank)[0], "basename"


def usage_files(transcript_path):
    """The main transcript plus every subagent transcript billing to this session.

    Subagent and workflow conversations are written to sibling files under
    `<transcript-stem>/subagents/` (workflows one level deeper), not into the
    transcript itself. Their tokens bill to the same account, and on a
    workflow-heavy session they can outweigh the main thread several times over,
    so a total that skips them is not a session cost at all.
    """
    files = [transcript_path]
    try:
        side = os.path.join(os.path.splitext(transcript_path)[0], "subagents")
        for root, _dirs, names in os.walk(side):
            for name in sorted(names):
                if name.endswith(".jsonl"):
                    files.append(os.path.join(root, name))
    except OSError:
        pass
    return files


def scan_file(path, cursor, seen, totals):
    """Fold one transcript's new bytes into totals. Returns the updated cursor.

    `cursor` is {"ino", "offset"}; a rotated or truncated file resets it.
    """
    try:
        st = os.stat(path)
    except OSError:
        return cursor

    offset = cursor.get("offset", 0)
    if cursor.get("ino") != st.st_ino or offset > st.st_size:
        offset = 0
    if offset >= st.st_size:
        return {"ino": st.st_ino, "offset": offset}

    try:
        with open(path, "rb") as fh:
            fh.seek(offset)
            blob = fh.read()
    except OSError:
        return cursor

    # Stop at the last newline: the tail may be a half-written record, and byte
    # offsets must be counted on bytes, not characters.
    cut = blob.rfind(b"\n") + 1
    if cut == 0:
        return {"ino": st.st_ino, "offset": offset}

    # split(b"\n"), never splitlines(): the latter also breaks on U+2028/U+2029/
    # U+0085, which JSON encoders emit raw inside strings. A record carrying one
    # would be torn into fragments that fail to parse, and since the offset still
    # advances past them that request's tokens would be lost for good.
    for raw in blob[:cut].split(b"\n"):
        if b'"usage"' not in raw:
            continue
        try:
            record = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            continue
        try:
            fold_record(record, seen, totals)
        except (TypeError, AttributeError, ValueError):
            continue      # an odd-shaped record is skipped, not re-crashed on every render

    return {"ino": st.st_ino, "offset": offset + cut}


def fold_record(record, seen, totals):
    """Add one transcript record's usage to totals (deduplicated through `seen`)."""
    if not isinstance(record, dict) or record.get("type") != "assistant":
        return
    message = record.get("message")
    usage = message.get("usage") if isinstance(message, dict) else None
    if not isinstance(usage, dict) or not usage:
        return
    # Claude Code writes one assistant record per content block and repeats
    # the whole request's usage in each, so totals are deduplicated on
    # requestId; summing raw records overstates cost by 3-4x.
    request_id = record.get("requestId") or message.get("id")
    if isinstance(request_id, str) and request_id:
        if request_id in seen:
            return
        seen[request_id] = None     # a dict keeps insertion order: the oldest go first

    creation = usage.get("cache_creation")
    if isinstance(creation, dict) and creation:
        write_5m = num(creation.get("ephemeral_5m_input_tokens")) or 0
        write_1h = num(creation.get("ephemeral_1h_input_tokens")) or 0
    else:
        write_5m = num(usage.get("cache_creation_input_tokens")) or 0
        write_1h = 0
    server = usage.get("server_tool_use")
    server = server if isinstance(server, dict) else {}
    prompt = (
        (num(usage.get("input_tokens")) or 0)
        + (num(usage.get("cache_read_input_tokens")) or 0)
        + write_5m
        + write_1h
    )

    # Speed is a price multiplier, not a model: fast mode bills the same
    # model at 2x. A request whose input passes 200k bills the long-context
    # tier where the entry publishes one. Bucket per (model, speed, tier).
    model = message.get("model")
    speed = usage.get("speed")
    bucket = totals.setdefault(
        "{}\t{}\t{}".format(
            model if isinstance(model, str) and model else "unknown",
            speed if isinstance(speed, str) and speed else "standard",
            "long" if prompt > LONG_CONTEXT else "",
        ),
        {},
    )
    for key, value in (
        ("i", usage.get("input_tokens")),
        ("o", usage.get("output_tokens")),
        ("r", usage.get("cache_read_input_tokens")),
        ("w5", write_5m),
        ("w1h", write_1h),
        ("ws", server.get("web_search_requests")),
    ):
        value = num(value)
        if value:
            bucket[key] = bucket.get(key, 0) + value


def scan_usage(transcript_path, session_id):
    """Per-(model, speed, tier) token totals across the session, parsing only what's new.

    State is kept per session, so a long session re-reads only the bytes appended
    since the last render, per file, and is rewritten only when a cursor moved.
    Seen requestIds are persisted in full rather than in a short ring: with many
    subagent transcripts folded in, an id can reappear far more than a fixed
    window later, and a ring that has rolled past it double counts.
    """
    if not transcript_path:
        return None

    state_file = state_path(session_id, "cost")
    state = read_json(state_file) or {}
    # A different transcript entirely invalidates the incremental state.
    if state.get("path") != transcript_path:
        state = {}

    cursors = state.get("files")
    if not isinstance(cursors, dict):
        cursors = {}
    totals = state.get("tok")
    totals = totals if isinstance(totals, dict) else {}
    req = state.get("req")
    seen = dict.fromkeys(r for r in (req if isinstance(req, list) else []) if isinstance(r, str))

    moved = not state
    for path in usage_files(transcript_path):
        before = cursors.get(path) or {}
        after = scan_file(path, before, seen, totals)
        if after != before:
            moved = True
        cursors[path] = after

    if moved:
        # Bounded so a marathon session can't grow the state file without limit;
        # far beyond any plausible in-flight duplicate distance. Oldest ids go first.
        req = list(seen)[-DEDUP_WINDOW:]
        write_json(
            state_file,
            {"path": transcript_path, "files": cursors, "req": req, "tok": totals},
        )
    return totals


def price_tokens(tokens, spec, speed="standard", long_tier=False):
    """Dollar cost of one model's token totals under one rate entry.

    Returns (cost, partial). Most published entries carry no cache rates at all —
    in a current table 1811 of 2521 have no cache-read price — while cache reads
    are the great majority of a Claude Code session's tokens. Billing them at the
    plain input rate is the only estimate available, but it overstates by ~3.5x,
    so `partial` says the figure rests on a substituted rate rather than letting
    it pass as fully priced.
    """
    if long_tier:
        # The long-context tier replaces each rate it publishes; the rest stay.
        spec = dict(spec)
        for short in ("i", "o", "r", "w", "w1h"):
            if spec.get(short + "L") is not None:
                spec[short] = spec[short + "L"]
    rate_in = spec.get("i", 0.0)
    # Entries that list no cache pricing bill cached tokens as plain input.
    rate_read = spec.get("r", rate_in)
    rate_write = spec.get("w", rate_in)
    partial = bool(
        (tokens.get("r") and spec.get("r") is None)
        or (tokens.get("w5") and spec.get("w") is None)
        or (tokens.get("w1h") and spec.get("w1h") is None)
    )
    cost = (
        tokens.get("i", 0) * rate_in
        + tokens.get("o", 0) * spec.get("o", 0.0)
        + tokens.get("r", 0) * rate_read
        + tokens.get("w5", 0) * rate_write
        + tokens.get("w1h", 0) * spec.get("w1h", rate_write)
        + tokens.get("ws", 0) * spec.get("s", 0.0)
    )
    mults = spec.get("m")
    if isinstance(mults, dict) and speed in mults:
        cost *= mults[speed]
    return cost, partial


def session_cost(transcript_path, session_id, aliases=None):
    """Session cost from transcript usage x LiteLLM rates.

    Returns (cost, unpriced). cost is None when nothing could be priced — the
    caller then falls back to Claude Code's own figure. unpriced flags that some
    model burned tokens the table couldn't price exactly, so the total is an
    estimate: low when a model resolved to nothing, high when only a cache rate
    was missing and those tokens got charged at the input rate.
    """
    models = load_prices()
    if not models:
        return None, False
    totals = scan_usage(transcript_path, session_id)
    if not totals:
        return None, False

    idx = price_index(models)
    cost, priced, unpriced = 0.0, False, False
    for bucket_key, tokens in totals.items():
        if not isinstance(bucket_key, str) or not isinstance(tokens, dict):
            continue
        # (model, speed, tier); state written before 1.4.0 has no tier field.
        model_id, speed, tier = (bucket_key.split("\t") + ["", ""])[:3]
        key, _ = resolve_model(model_id, idx, aliases)
        spec = models[key] if key is not None else None
        # An entry with no non-zero rate prices nothing. Counting it as priced
        # would publish a confident `≈$0.00` and suppress Claude Code's figure —
        # worse than admitting we don't know. distill_prices drops these, but a
        # cache distilled by an earlier build can still hold them.
        if spec is None or not (spec.get("i") or spec.get("o")):
            if any(tokens.get(name) for name in TOKEN_KEYS):
                unpriced = True
            continue
        model_cost, partial = price_tokens(
            tokens, spec, speed or "standard", long_tier=tier == "long"
        )
        cost += model_cost
        priced = True
        if partial:
            unpriced = True
    return (cost if priced else None), unpriced


def cache_write_rate(model_id, ttl, aliases, tokens=0, fast=False):
    """$ per token to re-write `tokens` of cache at this TTL, or None when the map can't say.

    The rebuild is one request, so a prompt over 200k bills the long-context tier where the
    entry publishes one, and fast mode its speed multiplier.
    """
    models = load_prices()
    if not models or not model_id:
        return None
    key, _ = resolve_model(model_id, price_index(models), aliases)
    spec = models.get(key) if key else None
    if not spec:
        return None
    long_tier = tokens > LONG_CONTEXT
    rate = None
    if ttl == "1h":
        rate = (spec.get("w1hL") if long_tier else None) or spec.get("w1h")
    if rate is None:
        rate = (spec.get("wL") if long_tier else None) or spec.get("w")
    if rate is None:
        return None
    mults = spec.get("m")
    if fast and isinstance(mults, dict) and num(mults.get("fast")):
        rate *= mults["fast"]
    return rate


# --------------------------------------------------------------------------- #
# Context — a trend of how full the conversation is, per prompt, measured      #
# against the point where Claude Code compacts.                                #
# --------------------------------------------------------------------------- #
def parse_window(value, bare_thousands):
    """A window size in tokens from 967000, "500k", "1M", or (bare_thousands) "500"."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip().lower().replace(",", "").replace("_", "")
        match = re.match(r"^(\d+(?:\.\d+)?)\s*([km]?)$", text)
        if not match:
            return None
        number = float(match.group(1))
        if match.group(2) == "k":
            number *= 1e3
        elif match.group(2) == "m":
            number *= 1e6
        elif bare_thousands and 100 <= number <= 1000:
            number *= 1e3
    else:
        return None
    return int(number) if number > 0 else None


def canonical_model(model_id):
    """claude-opus-5-5[1m], claude-sonnet-4-5@20250929, claude-x-20250929 -> the bare name."""
    name = str(model_id or "").split("[", 1)[0].strip().lower()
    name = re.sub(r"@\d{8}$", "", name)
    return re.sub(r"-\d{8}$", "", name)


def model_setting(settings, model_id, key):
    """modelSettings[<model>][key], matching the model's [1m] and date-suffixed ids too."""
    table = (settings or {}).get("modelSettings")
    if not isinstance(table, dict) or not model_id:
        return None
    want = canonical_model(model_id)
    for name, entry in table.items():
        if isinstance(entry, dict) and canonical_model(name) == want:
            return entry.get(key)
    return None


def resolve_compact(data, cfg, settings_chain):
    """Tokens at which this session auto-compacts, in Claude Code's own order:

    CLAUDE_CODE_AUTO_COMPACT_WINDOW (it beats the command, the flag and the setting); the
    `compact_at` option, standing in for the `--autocompact` flag the status line can't see;
    a settings file's modelSettings.<model>.autoCompactWindow, then its top-level
    autoCompactWindow, from the highest-precedence file that sets either; else the
    documented default. Like Claude Code, it holds a window to 100k-1M and the model's size.
    """
    window = window_size(data)
    env = os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
    point = parse_window(env, bare_thousands=False) if env else None
    if point is None:
        point = parse_window(cfg.get("compact_at"), bare_thousands=True)
    if point is not None:
        point = min(max(point, 100000), 1000000)
    if point is None:
        model_id = gs(data, "model.id")
        for settings in settings_chain:
            value = model_setting(settings, model_id, "autoCompactWindow")
            if value is None and settings:
                value = settings.get("autoCompactWindow")
            if value is not None:
                point = parse_window(value, bare_thousands=False)  # "auto" -> default
                break
    if point is None:
        point = DEFAULT_1M_COMPACT if window >= 1000000 else window
    return int(max(1, min(point, window)))


def spark_char(fraction):
    """Square-root scale: early growth stays visible, █ only near compaction."""
    f = min(1.0, max(0.0, fraction))
    return SPARK[min(len(SPARK) - 1, int(math.sqrt(f) * len(SPARK)))]


def sparkline(values, ceiling):
    if not ceiling:
        return ""
    return "".join(spark_char(v / float(ceiling)) for v in values)


def window_size(data):
    """The context window in tokens; anything but a positive number reads as the 200k default."""
    size = num(g(data, "context_window.context_window_size"))
    return size if size and size > 0 else 200000


def context_used(data):
    window = window_size(data)
    used = num(g(data, "context_window.total_input_tokens"))
    if not used:
        pct = num(g(data, "context_window.used_percentage"))
        used = int(pct * window / 100) if pct is not None else 0
    return int(used or 0)


def record_sample(state, data, used, width):
    """One sample per prompt (its latest reading). A drop of 30%+ inside one prompt is a
    compaction and gets its own sample, so the trend shows it. Returns True on change."""
    if g(data, "context_window.current_usage") is None or not used:
        return False      # null right after /compact and before the first response
    pid = data.get("prompt_id")
    if not isinstance(pid, str) or not pid:
        return False
    samples = state.get("s")
    if not isinstance(samples, list) or any(num(s) is None for s in samples):
        samples = state["s"] = []
    before = list(samples)
    if state.get("pid") == pid and samples and used >= 0.7 * samples[-1]:
        samples[-1] = used
    else:
        samples.append(used)
        state["pid"] = pid
    del samples[:-max(1, width)]
    return samples != before


def context_segment(data, cfg, compact, samples):
    used = context_used(data)
    fraction = used / float(compact) if compact else 0.0
    color = zone_color(fraction * 100, cfg["ctx_warn"], cfg["ctx_crit"])
    spark = sparkline(samples[-max(1, cfg["spark_width"]):], compact) if samples else ""
    head = "ctx " + (paint(spark, color) + " " if spark else "")
    return head + paint(fmt_tok(used), color) + paint(" → compact @" + fmt_tok(compact), DIM)


# --------------------------------------------------------------------------- #
# Segments                                                                     #
# --------------------------------------------------------------------------- #
def cache_segments(data, cfg, now, aliases):
    """[(priority, text)] for the prompt cache: its state, then the last miss's cause.

    Claude Code reports the real state in `prompt_cache` (v2.1.251+). Older clients
    fall back to the transcript's age against the TTL Claude Code would request:
    one hour for a subscription's main conversation, five minutes otherwise.
    """
    pc = data.get("prompt_cache")
    if isinstance(pc, dict):
        if pc.get("caching_observed") is False:
            return []
        expires = num(pc.get("expires_at"))
        left = (expires - now) if expires is not None else None
        warm = bool(pc.get("warm")) and left is not None and left > 0
        parts = []
        if warm and left > 120:
            state, color, prio = "warm", GREEN, 35
            parts.append(lead(G("warm")) + fmt_span(left) if G("warm") else "cache " + fmt_span(left))
        else:
            state = "cooling" if warm else "cold"
            color, prio = (YELLOW if warm else RED), 85
            label = fmt_span(left) if warm else "cold"
            parts.append(lead(G(state)) + label if G(state) else "cache " + label)
            tokens = num(pc.get("recache_tokens_if_cold"))
            if tokens:
                rate = cache_write_rate(gs(data, "model.id"), pc.get("ttl"), aliases, tokens,
                                        data.get("fast_mode") is True)
                parts.append(
                    "rebuild ≈${:.2f}".format(tokens * rate) if rate else
                    "rebuild " + fmt_tok(tokens)
                )
        out = [(prio, paint(parts[0], color) + "".join(
            paint(SEP_PLAIN, DIM) + p for p in parts[1:]))]
        miss_at = num(pc.get("last_miss_at"))
        causes = g(pc, "last_miss_cause.causes")
        causes = [c for c in causes if isinstance(c, str)] if isinstance(causes, list) else []
        if miss_at and now - miss_at < 600 and isinstance(causes, list) and causes:
            out.append((55, paint("miss " + ",".join(str(c) for c in causes[:2]), YELLOW)))
        return out

    transcript = gs(data, "transcript_path")
    if not transcript:
        return []
    try:
        idle = now - os.path.getmtime(transcript)
    except OSError:
        return []
    subscribed = bool(g(data, "rate_limits.five_hour") or g(data, "rate_limits.seven_day"))
    ttl = 3600 if subscribed else 300
    if idle < 0.8 * ttl:
        state, color, prio = "warm", GREEN, 35
    elif idle < ttl:
        state, color, prio = "cooling", YELLOW, 85
    else:
        state, color, prio = "cold", RED, 85
    return [(prio, paint(lead(G(state)) + state, color))]


WINDOWS = (("5h", "five_hour", 5 * 3600), ("7d", "seven_day", 7 * 86400))


def rate_segment(label, win, length, now):
    """(priority, text): usage, the reset countdown, and a projection of the pace.

    Color follows where the window is heading, not where it is: 62% two hours into
    a five-hour window runs out before the reset, and that is the news.
    """
    used = num(win.get("used_percentage"))
    if used is None:
        return None
    resets = num(win.get("resets_at"))
    projected, eta, left = None, None, None
    if resets is not None:
        left = resets - now
        elapsed = length - left
        if left > 0 and elapsed >= 0.1 * length and used > 0:
            pace = used / elapsed
            projected = used + pace * left
            if projected >= 100 and used < 100:
                eta = now + (100 - used) / pace
    heat = max(used, projected if projected is not None else used)
    color = zone_color(heat, 85, 100) if projected is not None else zone_color(used, 70, 90)
    if eta is not None:
        text = "{} {:.0f}% → 100% ~{}".format(label, used, fmt_clock(eta, now))
    elif left is not None and left > 0:
        text = "{} {:.0f}% {}{}".format(label, used, G("reset"), fmt_span(left))
    else:
        text = "{} {:.0f}%".format(label, used)
    prio = 90 if color == RED else (60 if color == YELLOW else 42 if label == "5h" else 41)
    return prio, paint(text, color)


PERIODS = {"daily": "day", "weekly": "wk", "monthly": "mo"}


def spend_segment(spend, now):
    used = num(spend.get("used_percentage"))
    if used is None:
        return None
    color = zone_color(used, 70, 90)
    used_usd, limit_usd = num(spend.get("used_usd")), num(spend.get("limit_usd"))
    if used_usd is not None and limit_usd:
        text = "spend ${:,.0f}/${:,.0f}".format(used_usd, limit_usd)
        period = PERIODS.get(spend.get("period")) if isinstance(spend.get("period"), str) else None
        if period:
            text += " " + period
    else:
        text = "spend {:.0f}%".format(used)
        resets = num(spend.get("resets_at"))
        if resets is not None and resets > now:
            text += " " + G("reset") + fmt_span(resets - now)
    return (88 if color == RED else 45), paint(text, color)


def branch_segment(data, info):
    branch = gs(data, "worktree.branch") or info.get("branch") or gs(data, "workspace.git_worktree")
    if not branch:
        return None
    seg = anchor(G("branch"), CYAN) + branch
    ab = ""
    if info.get("ahead"):
        ab += G("ahead") + str(info["ahead"])
    if info.get("behind"):
        ab += G("behind") + str(info["behind"])
    if ab:
        seg += " " + paint(ab, CYAN)
    for key, color in (("modified", YELLOW), ("staged", GREEN), ("untracked", DIM),
                       ("conflicts", RED)):
        count = info.get(key)
        if count:
            glyph = G("conflict") if key == "conflicts" else G(key)
            seg += " " + paint("{}{}".format(glyph, count), color)
    return seg


def badges_segment(data):
    parts = []
    if data.get("fast_mode") is True:
        parts.append(paint(G("fast") + "fast", YELLOW))
    effort = g(data, "effort.level")
    if isinstance(effort, str) and effort or num(effort) is not None:
        parts.append(paint(str(effort), DIM))
    style = gs(data, "output_style.name")
    if style and style.lower() != "default":
        parts.append(paint(style, MAGENTA))
    agent = gs(data, "agent.name")
    if agent:
        parts.append(paint("@" + agent, CYAN))
    return " ".join(parts) if parts else None


REVIEW_COLORS = {"approved": GREEN, "changes_requested": RED}


def pr_segment(data):
    number = g(data, "pr.number")
    if number is None:
        return None
    prefix = "!" if gs(data, "pr.kind") == "mr" else "#"
    color = REVIEW_COLORS.get(gs(data, "pr.review_state"), DIM)
    return paint(link("{}{}".format(prefix, number), gs(data, "pr.url")), color)


def read_kv(path):
    """key=value lines, first occurrence wins (acf-whip's state format; never sourced)."""
    out = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                key, sep, value = line.rstrip("\n").partition("=")
                if sep and key not in out:
                    out[key] = value
    except OSError:
        pass
    return out


def acf_segment(project_dir, now):
    """acf-whip's autopilot round and a live /go run, read from its state files.

    Optional composition: no acf-whip, no files, no segment. Stats and two small
    reads only, never git. /go's run lock lives at its default path; a run started
    with another `runLockPath` is not seen.
    """
    if not project_dir:
        return None
    parts = []
    state = read_kv(os.path.join(project_dir, ".acfwhip", "run", "autopilot", "state"))
    mode = state.get("state")
    if mode in ("running", "paused"):
        rnd, rounds = state.get("round", ""), state.get("rounds", "")
        tag = " r{}/{}".format(rnd, rounds) if rnd and rounds else (" r" + rnd if rnd else "")
        if mode == "running":
            parts.append(paint(lead(G("auto")) + "auto" + tag, CYAN))
        else:
            parts.append(paint(lead(G("paused")) + "auto" + tag + " paused", YELLOW))
    lock = os.path.join(project_dir, ".backlog", ".acfw-run.json")
    try:
        age = now - os.path.getmtime(lock)
    except OSError:
        age = None
    if age is not None and -60 <= age < GO_LOCK_FRESH:
        beat = read_json(lock) or {}
        it = num(beat.get("iteration"))
        parts.append(paint(lead(G("go")) + "/go" + (" it{}".format(int(it)) if it else ""), CYAN))
    return " ".join(parts) if parts else None


def cost_segment(data, cfg, aliases, priced=True):
    computed, unpriced = None, False
    if cfg["price_map"] and priced:
        if prices_stale(cfg["price_ttl"]):
            spawn_refresh()
        computed, unpriced = session_cost(
            gs(data, "transcript_path"), gs(data, "session_id"), aliases
        )
    # Claude Code's figure only covers models it ships rates for; ours covers
    # whatever the price map resolves. Prefer ours, fall back to theirs.
    cost = computed if computed is not None else num(g(data, "cost.total_cost_usd"))
    if cost is None:
        return None
    color = zone_color(cost, cfg["cost_warn"], cfg["cost_crit"])
    # Below warn threshold, keep it muted rather than green.
    if cost < cfg["cost_warn"]:
        color = DIM
    text = "{}{}${:.2f}{}".format(
        G("cost"),
        "≈" if computed is not None else "",
        cost,
        "?" if unpriced else "",  # some tokens burned at unknown rates
    )
    return paint(text, color)


# --------------------------------------------------------------------------- #
# Render                                                                       #
# --------------------------------------------------------------------------- #
def settings_chain(project_dir, user_settings):
    """Settings files in precedence order: managed, local, project, user."""
    chain = [read_json(managed_settings_path())]
    if project_dir:
        chain.append(read_json(os.path.join(project_dir, ".claude", "settings.local.json")))
        chain.append(read_json(os.path.join(project_dir, ".claude", "settings.json")))
    chain.append(user_settings)
    return chain


def render(data, cfg, now, user_settings=None, persist=True, samples=None, git=None):
    """The HUD's lines. `persist=False` (the preview) touches no state, no git, no network."""
    sid = gs(data, "session_id")
    current_dir = gs(data, "workspace.current_dir") or gs(data, "cwd")
    project_dir = gs(data, "workspace.project_dir") or current_dir
    aliases = cfg.get("price_aliases") or {}

    # ---- Line 1: identity --------------------------------------------------
    model = gs(data, "model.display_name") or "Claude"
    window = window_size(data)
    model_label = anchor(G("model"), model_color(model)) + paint(model, model_color(model))
    if window >= 1000000:
        model_label += paint(" [1m]", CYAN + BOLD)
    line1 = [(100, model_label)]
    if cfg["badges"]:
        line1.append((48, safe(badges_segment, data)))
    if current_dir:
        line1.append((50, anchor(G("dir"), BLUE) + paint(os.path.basename(current_dir), DIM)))
    if cfg["git"]:
        info = git if git is not None else (
            safe(git_info, current_dir, sid, now) if persist else None) or dict(GIT_EMPTY)
        line1.append((65, safe(branch_segment, data, info)))
    if cfg["pr"]:
        line1.append((60, safe(pr_segment, data)))
    if cfg["acf_status"]:
        line1.append((70, safe(acf_segment, project_dir, now)))

    # ---- Line 2: telemetry -------------------------------------------------
    compact = resolve_compact(data, cfg, settings_chain(project_dir, user_settings))
    if samples is None:
        hud_path = state_path(sid, "hud") if persist else None
        hud = (read_json(hud_path) if hud_path else None) or {}
        if record_sample(hud, data, context_used(data), cfg["spark_width"]) and hud_path:
            write_json(hud_path, hud)
        samples = hud.get("s") or []
    line2 = [(95, context_segment(data, cfg, compact, samples))]

    if cfg["cost"]:
        line2.append((72, safe(cost_segment, data, cfg, aliases, persist)))
    if cfg["cache"]:
        line2.extend(safe(cache_segments, data, cfg, now, aliases) or [])
    if cfg["rate_limits"]:
        for label, key, length in WINDOWS:
            win = g(data, "rate_limits." + key)
            if isinstance(win, dict):
                line2.append(safe(rate_segment, label, win, length, now))
        spend = g(data, "rate_limits.spend_limit")
        if isinstance(spend, dict):
            line2.append(safe(spend_segment, spend, now))
    if cfg["duration"]:
        dur = num(g(data, "cost.total_duration_ms"))
        if dur is not None:
            line2.append((10, paint(G("dur") + fmt_duration(int(dur)), DIM)))
    if cfg["lines"]:
        added = g(data, "cost.total_lines_added")
        removed = g(data, "cost.total_lines_removed")
        if added is not None or removed is not None:
            line2.append((20, "{}/{}".format(
                paint("+{}".format(added or 0), GREEN),
                paint("-{}".format(removed or 0), RED),
            )))

    # ---- Fit and emit ------------------------------------------------------
    cols = columns()
    width = max(20, cols - WIDTH_MARGIN)
    layout = cfg.get("layout")
    two = layout == "two-line" or (layout not in ("one-line", "two-line") and cols >= 100)
    sep = paint(SEP_PLAIN, DIM)
    line1 = [s for s in line1 if s and s[1]]
    line2 = [s for s in line2 if s and s[1]]
    if two:
        return [sep.join(fit(line1, width)), sep.join(fit(line2, width))]
    return [sep.join(fit(line1 + line2, width))]


def read_stdin_json():
    """stdin as a JSON object, or None. NaN and Infinity (which Python accepts) read as null."""
    try:
        data = json.loads(sys.stdin.read(), parse_constant=lambda _token: None)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def main():
    data = read_stdin_json()
    if data is None:
        print(lead(G("model")) + "Mission Control")
        return
    try:
        user_settings = read_json(os.path.join(claude_config_dir(), "settings.json"))
        cfg = load_config(user_settings)
        apply_style(cfg)
        print("\n".join(render(data, cfg, now_ts(), user_settings=user_settings)))
    except Exception:  # noqa: BLE001 - a blank status line explains nothing
        print(lead(G("model")) + (gs(data, "model.display_name") or "Mission Control"))


# --------------------------------------------------------------------------- #
# Subagent rows (subagentStatusLine)                                           #
# --------------------------------------------------------------------------- #
STATUS_STYLE = {
    "running": ("●", GREEN),
    "completed": ("✓", DIM),
    "failed": ("✗", RED),
    "killed": ("■", DIM),
}


def subagent_rows(data, cfg, now):
    """One {"id", "content"} JSON line per row. No dollar figure: tokenCount isn't
    split into input, output and cache, so a $ estimate could be off by up to ~10x."""
    try:
        cols = int(data.get("columns") or 0) or columns()
    except (TypeError, ValueError):
        cols = columns()
    sep = paint(SEP_PLAIN, DIM)
    rows = []
    tasks = data.get("tasks")
    for task in tasks if isinstance(tasks, list) else []:
        if not isinstance(task, dict) or not isinstance(task.get("id"), str):
            continue
        row = safe(subagent_row, task, cfg, now, cols, sep)
        if row is not None:      # a malformed task keeps Claude Code's default row
            rows.append(row)
    return rows


def subagent_row(task, cfg, now, cols, sep):
    """One row's {"id", "content"} JSON line."""
    status = task.get("status")
    mark, color = STATUS_STYLE.get(status if isinstance(status, str) else "", ("○", DIM))
    name = next((v for v in (task.get("agentType"), task.get("name"), task.get("type"))
                 if isinstance(v, str) and v), "agent")
    model = task.get("model") if isinstance(task.get("model"), str) else ""
    family = model_family(model)
    head = paint(mark, color) + " " + paint(str(name), BOLD)
    if model:
        head += " " + paint(family or model.rsplit("/", 1)[-1], model_color(model))
    effort = task.get("effort")
    if isinstance(effort, str) and effort or num(effort) is not None:
        head += " " + paint(str(effort), DIM)
    parts = [head]

    window = num(task.get("contextWindowSize"))
    window = window if window and window > 0 else None
    tokens = num(task.get("tokenCount")) or 0
    raw = task.get("tokenSamples")
    samples = [s for s in (raw if isinstance(raw, list) else []) if num(s) is not None]
    if window:
        zone = zone_color(tokens * 100.0 / window, cfg["ctx_warn"], cfg["ctx_crit"])
        spark = sparkline((samples or [tokens])[-max(1, cfg["spark_width"]):], window)
        parts.append(paint(spark, zone) + " " + paint(
            "{}/{}".format(fmt_tok(tokens), fmt_tok(window)), zone))
    elif tokens:
        parts.append(fmt_tok(tokens))
    start = num(task.get("startTime"))
    if start:
        parts.append(paint(fmt_span(now - start / 1000.0), DIM))

    content = sep.join(parts)
    label = next((v for v in (task.get("label"), task.get("description"))
                  if isinstance(v, str) and v), "")
    room = cols - visible_width(content) - len(SEP_PLAIN)
    if label and room >= 8:
        content += sep + truncate(label, room)
    return json.dumps({"id": task["id"], "content": content})


def subagents_main():
    data = read_stdin_json()
    if data is None:
        return          # no output keeps every row at Claude Code's default
    try:
        cfg = load_config()
        apply_style(cfg)
        rows = subagent_rows(data, cfg, now_ts())
    except Exception:  # noqa: BLE001 - default rows beat a failed command
        return
    if rows:
        print("\n".join(rows))


# --------------------------------------------------------------------------- #
# Preview and price check (debug modes, not the HUD)                           #
# --------------------------------------------------------------------------- #
def preview_samples(now):
    """Two representative sessions: a subscriber on a 1M model, a gateway user near compaction."""
    subscriber = {
        "session_id": "preview", "prompt_id": "p8",
        "model": {"id": "claude-opus-5-5[1m]", "display_name": "Opus"},
        "workspace": {"current_dir": "/work/acf-tools", "project_dir": "/work/acf-tools"},
        "output_style": {"name": "challenger"}, "effort": {"level": "high"},
        "context_window": {"context_window_size": 1000000, "total_input_tokens": 142000,
                           "current_usage": {"input_tokens": 9000}},
        "cost": {"total_cost_usd": 3.10, "total_duration_ms": 47 * 60000,
                 "total_lines_added": 156, "total_lines_removed": 23},
        "prompt_cache": {"warm": True, "caching_observed": True, "ttl": "1h",
                         "expires_at": now + 52 * 60, "recache_tokens_if_cold": 142000},
        "rate_limits": {"five_hour": {"used_percentage": 62, "resets_at": now + 100 * 60},
                        "seven_day": {"used_percentage": 41, "resets_at": now + 4 * 86400}},
        "pr": {"number": 1234, "url": "https://github.com/fib7/acf-tools/pull/1234",
               "review_state": "approved"},
    }
    gateway = {
        "session_id": "preview", "prompt_id": "p9",
        "model": {"id": "nebius/zai-org/GLM-5.2", "display_name": "GLM-5.2"},
        "workspace": {"current_dir": "/work/api", "project_dir": "/work/api"},
        "fast_mode": True,
        "context_window": {"context_window_size": 200000, "total_input_tokens": 188000,
                           "current_usage": {"input_tokens": 4000}},
        "cost": {"total_cost_usd": 18.40, "total_duration_ms": 2 * 3600000 + 5 * 60000,
                 "total_lines_added": 812, "total_lines_removed": 301},
        "prompt_cache": {"warm": False, "caching_observed": True, "ttl": "5m",
                         "expires_at": None, "recache_tokens_if_cold": 188000,
                         "last_miss_at": now - 120,
                         "last_miss_cause": {"causes": ["ttl_expired_5m"]}},
        "rate_limits": {"spend_limit": {"used_percentage": 63, "resets_at": now + 12 * 86400,
                                        "used_usd": 314, "limit_usd": 500,
                                        "period": "monthly"}},
    }
    sub_git = dict(GIT_EMPTY, branch="main", ahead=2, modified=3, staged=2)
    gw_git = dict(GIT_EMPTY, branch="fix/auth", modified=1, untracked=4)
    return [
        ("subscriber, 1M model, early", subscriber, sub_git,
         [20000, 30000, 45000, 60000, 80000, 100000, 120000, 142000]),
        ("gateway, 200k model, near compaction", gateway, gw_git,
         [150000, 172000, 181000, 60000, 90000, 140000, 170000, 188000]),
    ]


def preview():
    now = now_ts()
    cfg = load_config()
    print("COLUMNS={} (set COLUMNS=60 or 160 to see the layout adapt)".format(columns()))
    for theme in ("sleek", "emoji", "nerd", "text"):
        cfg_theme = dict(cfg, glyphs=theme)
        apply_style(cfg_theme)
        for title, payload, git, samples in preview_samples(now):
            print("\n[{}] {}".format(theme, title))
            for line in render(payload, cfg_theme, now, user_settings={}, persist=False,
                               samples=samples, git=git):
                print(line)
    apply_style(cfg)
    print("\n[subagent rows]")
    tasks = {"columns": columns(), "tasks": [
        {"id": "a1", "agentType": "whippet", "status": "running", "model": "claude-sonnet-5-5",
         "contextWindowSize": 1000000, "tokenCount": 84000,
         "tokenSamples": [12000, 30000, 51000, 70000, 84000], "startTime": (now - 192) * 1000,
         "description": "feature-014-token-refresh"},
        {"id": "a2", "agentType": "quality-reviewer", "status": "completed",
         "model": "claude-opus-5-5", "contextWindowSize": 200000, "tokenCount": 61000,
         "startTime": (now - 640) * 1000, "description": "review feature-012"},
    ]}
    for row in subagent_rows(tasks, cfg, now):
        print(json.loads(row)["content"])
    return 0


def fmt_age(seconds):
    if seconds is None:
        return "never fetched"
    if seconds < 3600:
        return "{:.0f}m old".format(seconds / 60)
    if seconds < 86400:
        return "{:.0f}h old".format(seconds / 3600)
    return "{:.0f}d old".format(seconds / 86400)


def price_check(model_id):
    """Show how a model id maps onto the price map. Debug mode, not the HUD."""
    if not model_id:
        print("usage: status-line.py --price-check <model-id>")
        return 2

    models = load_prices()
    if not models:
        print("no price map cached at {}".format(price_cache_path()))
        print("run: {} --refresh-prices".format(os.path.basename(__file__)))
        return 1

    print("price map     : {} entries, {}".format(len(models), fmt_age(prices_age())))
    print("cache         : {}".format(price_cache_path()))
    print("model id      : {}".format(model_id))

    aliases = load_config().get("price_aliases") or {}
    key, how = resolve_model(model_id, price_index(models), aliases)
    if key is None:
        print("matched key   : none — no entry for '{}'".format(model_id.split("/")[-1]))
        print("               pin one with the price_aliases option in /config")
        return 1

    spec = models[key]
    print("matched key   : {}  (via {})".format(key, how))
    print("provider      : {}".format(spec.get("p", "?")))
    for label, short in (
        ("input", "i"),
        ("output", "o"),
        ("cache read", "r"),
        ("cache write", "w"),
        ("cache write 1h", "w1h"),
        ("input >200k", "iL"),
        ("output >200k", "oL"),
    ):
        val = spec.get(short)
        if val is None and short.endswith("L"):
            continue
        rate = "${:.2f} / Mtok".format(val * 1e6) if val is not None else "n/a"
        print("{:<14}: {}".format(label, rate))
    if spec.get("s") is not None:
        print("{:<14}: ${:.4f} / query".format("web search", spec["s"]))
    return 0


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--refresh-prices":
        ok = refresh_prices()
        print("price map refreshed" if ok else "price map unchanged (locked or fetch failed)")
        sys.exit(0 if ok else 1)
    elif argv and argv[0] == "--price-check":
        sys.exit(price_check(argv[1] if len(argv) > 1 else ""))
    elif argv and argv[0] == "--subagents":
        subagents_main()
    elif argv and argv[0] == "--preview":
        sys.exit(preview())
    else:
        main()
