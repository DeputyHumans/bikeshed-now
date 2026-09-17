#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build the self-hosted UI font from an upstream OFL variable face (SPEC §10).

Usage:
    npm pack inter-ui                       # or fetch the upstream release
    tar xzf inter-ui-*.tgz package/variable/InterVariable.woff2
    python3 tools/build-font.py package/variable/InterVariable.woff2

Why this exists rather than a font CDN
--------------------------------------
This product holds documents people mark confidential, and a CDN link tells a
third party the viewer's IP, user agent and referer on every page load. That is
an unacceptable default for a self-hosted tool, it fails a security review on
sight, and it breaks entirely in an air-gapped deployment.

Why the output is renamed
-------------------------
The upstream face is under the SIL Open Font License 1.1. Subsetting and
restricting an axis are modifications, and shipping a modified file under the
upstream name would imply the upstream project vouches for it. Renaming a
derivative is explicitly permitted and is the honest thing to do. Attribution
and the full license text live in app/public/fonts/OFL.txt and
THIRD_PARTY_LICENSES.md.

The output is committed as a binary asset. The brand guard keeps an explicit
allowlist of tracked binaries and byte-scans each one, so this file cannot
become a place where a forbidden string hides.

Requires: fontTools with brotli (pip install fonttools brotli).
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OUTPUT = Path(__file__).resolve().parent.parent / "app/public/fonts/bikeshed-sans-var.woff2"

FAMILY = "Bikeshed Sans"

# The weight range the design system actually uses. Everything outside it is
# dead bytes in every page load.
WEIGHT_MIN, WEIGHT_MAX = 300, 800

# Google Fonts' latin and latin-ext ranges. Together they cover Western and
# Central European text plus the punctuation and currency a document interface
# needs, which is the whole audience this file is sized for.
UNICODES = ",".join(
    [
        # latin
        "U+0000-00FF", "U+0131", "U+0152-0153", "U+02BB-02BC", "U+02C6",
        "U+02DA", "U+02DC", "U+0304", "U+0308", "U+0329", "U+2000-206F",
        "U+2074", "U+20AC", "U+2122", "U+2191", "U+2193", "U+2212", "U+2215",
        "U+FEFF", "U+FFFD",
        # latin-ext
        "U+0100-02AF", "U+1E00-1E9F", "U+1EF2-1EFF", "U+2020", "U+20A0-20AB",
        "U+20AD-20C0", "U+2113", "U+2C60-2C7F", "U+A720-A7FF",
    ]
)


def rename(font: TTFont, source_note: str) -> None:
    """Point every family/name record at the derivative's own name."""
    name = font["name"]
    records = {
        0: source_note,
        1: FAMILY,
        2: "Regular",
        3: f"{FAMILY};bikeshed",
        4: FAMILY,
        6: FAMILY.replace(" ", ""),
        16: FAMILY,
        17: "Regular",
    }
    for name_id, value in records.items():
        name.setName(value, name_id, 3, 1, 0x409)  # Windows, Unicode BMP, en-US
        name.setName(value, name_id, 1, 0, 0)  # Macintosh, Roman, English
    # Drop every other localization: they describe the upstream face, not this one.
    name.names = [n for n in name.names if n.nameID in records]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    source_path = Path(sys.argv[1])
    font = TTFont(source_path, lazy=False)

    original_copyright = ""
    for record in font["name"].names:
        if record.nameID == 0:
            original_copyright = str(record)
            break

    # Pin every axis except weight. An optical-size axis the stylesheet never
    # varies is pure payload, and pinning it makes the output deterministic.
    axis_limits = {}
    for axis in font["fvar"].axes:
        if axis.axisTag == "wght":
            axis_limits["wght"] = (WEIGHT_MIN, axis.defaultValue, WEIGHT_MAX)
        else:
            axis_limits[axis.axisTag] = axis.defaultValue
    font = instancer.instantiateVariableFont(font, axis_limits, updateFontNames=False)

    # Round-trip before subsetting. The instancer leaves some tables lazily
    # bound to the pre-instance glyph order, and the subsetter then trips over a
    # glyph the instancer already removed. Serializing forces everything to
    # agree on one glyph set.
    buffer = io.BytesIO()
    font.flavor = None
    font.save(buffer)
    buffer.seek(0)
    font = TTFont(buffer, lazy=False)

    options = subset.Options()
    options.flavor = "woff2"
    # The subsetter's default feature set, plus the two this design system
    # actually asks for by name: tabular figures for aligned numerics and
    # slashed zero so an id is unambiguous. Keeping "*" would carry every
    # stylistic set in the upstream face for nothing.
    options.layout_features = options.layout_features + ["tnum", "zero"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["DSIG"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)

    rename(
        font,
        f"{original_copyright} — subset and weight-restricted for Bikeshed; "
        f"licensed under the SIL Open Font License 1.1. See app/public/fonts/OFL.txt.",
    )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = "woff2"
    font.save(OUTPUT)

    size = OUTPUT.stat().st_size
    print(f"wrote {OUTPUT.relative_to(OUTPUT.parent.parent.parent.parent)} ({size / 1024:.1f} KB)")
    print(f"  family : {FAMILY}")
    print(f"  weight : {WEIGHT_MIN}-{WEIGHT_MAX}")
    print(f"  source : {source_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
