// SPDX-License-Identifier: Apache-2.0
// Export marking: the owner's policy, resolved once at publish time (SPEC §20).

/**
 * Why this is resolved at PUBLISH time, not at export time
 * -------------------------------------------------------
 * The marking is the owner's policy about their document. Resolving it when
 * somebody exports would apply the EXPORTER's default instead — so a reader with
 * "Confidential" as their account default would stamp it on a document its owner
 * deliberately published openly, and a reader with no default would strip it
 * from one that needed it. The decision belongs to the person who published.
 *
 * Three layers, each seeding the next: a deployment default seeds an account
 * default, which seeds a document, which is authoritative. All of them default
 * to off.
 */

export interface Marking {
  enabled: boolean;
  /** Short corner stamp, e.g. "CONFIDENTIAL". */
  label: string;
  /** Per-page footer. Supports {year} {date} {title} {version} {user}. */
  footer: string;
}

export const MARKING_OFF: Marking = { enabled: false, label: "", footer: "" };

const MAX_LABEL = 40;
const MAX_FOOTER = 300;

/**
 * Clean a stored or submitted marking.
 *
 * Bounded and stripped of control characters because these values are written
 * into an export with `textContent` and into a `style` attribute's sibling text.
 * They are never `innerHTML`, which is what makes a length cap sufficient rather
 * than a sanitizer.
 */
export function resolveMarking(raw: unknown): Marking {
  if (raw == null || typeof raw !== "object") return MARKING_OFF;
  const m = raw as Partial<Marking>;
  if (m.enabled !== true) return MARKING_OFF;
  return {
    enabled: true,
    label: clean(m.label, MAX_LABEL),
    footer: clean(m.footer, MAX_FOOTER),
  };
}

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, max);
}

/** True when a marking would actually render something. */
export function markingIsVisible(marking: Marking): boolean {
  return marking.enabled && (marking.label.length > 0 || marking.footer.length > 0);
}
