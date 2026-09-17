// SPDX-License-Identifier: Apache-2.0
// The viewer's overflow menu (SPEC §2, §17, §20).

import { Menu, type MenuEntry } from "./Menu";
import { Icon } from "./Icon";

/**
 * Named "More" rather than "Export", because it is not an export menu: it
 * carries downloads, presentation, versions and settings. The design this
 * replaces called it ExportMenu and filed "Present full screen" under it, which
 * is where somebody looking for presentation mode would never think to look.
 */
export function MoreMenu({ entries }: { entries: MenuEntry[] }) {
  return (
    <Menu
      label="More actions"
      entries={entries}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className="icon-btn"
          aria-label="More actions"
          aria-haspopup="menu"
        >
          <Icon name="more" />
        </button>
      )}
    />
  );
}
