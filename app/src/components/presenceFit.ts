// SPDX-License-Identifier: Apache-2.0
// How many presence chips fit on the bar's one line (SPEC §16).

/**
 * How many chips, in order, the presence bar shows whole; the rest fold
 * into its "+N" button.
 *
 * A pure function, for the reason `menuPosition` is one: jsdom measures
 * nothing, and the arithmetic is where the edge cases are. It reads widths
 * that do not change with the answer — a folded chip keeps its width and the
 * "+N" button keeps its slot — so the bar cannot flip between two answers.
 *
 * `available` of 0 or less means the bar has not been laid out (jsdom, a
 * hidden tab): everyone is shown rather than folding everyone away.
 */
export function chipsThatFit(widths: number[], gap: number, available: number, moreWidth: number): number {
  if (available <= 0) return widths.length;
  const whole = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  if (whole <= available) return widths.length;
  // Not everyone fits, so the "+N" button needs its room, after the chips
  // that are shown and a gap each.
  let used = moreWidth;
  let shown = 0;
  for (const width of widths) {
    if (used + width + gap > available) break;
    used += width + gap;
    shown += 1;
  }
  return shown;
}
