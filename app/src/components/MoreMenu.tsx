// SPDX-License-Identifier: Apache-2.0
// The ⋮ overflow menu: the viewer's, and an open folder's (SPEC §2, §13, §17, §20).

import { Menu, type MenuEntry } from "./Menu";
import { Icon } from "./Icon";

/**
 * Named "More" rather than "Export", because it is not an export menu: it
 * carries downloads, presentation, versions and settings. The design this
 * replaces called it ExportMenu and filed "Present full screen" under it, which
 * is where somebody looking for presentation mode would never think to look.
 */
export function MoreMenu({
  entries,
  label = "More actions",
  menuLabel = label,
}: {
  entries: MenuEntry[];
  /** The trigger's accessible name. */
  label?: string;
  /** The open menu's, when it should name what it acts on. */
  menuLabel?: string;
}) {
  return (
    <Menu
      label={menuLabel}
      entries={entries}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className="icon-btn"
          aria-label={label}
          aria-haspopup="menu"
        >
          <Icon name="more" />
        </button>
      )}
    />
  );
}
