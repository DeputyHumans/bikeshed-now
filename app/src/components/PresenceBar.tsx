// SPDX-License-Identifier: Apache-2.0
// Who else is here, and where they are looking (SPEC §16).

import { Icon } from "./Icon";
import type { Peer } from "../presence";

/**
 * One colour per person, and the SAME colour everywhere.
 *
 * The value here also paints the live caret, the scroll-rail marker, the
 * comment thread accent and the edge of each persisted highlight, so a person
 * can be traced across five surfaces at a glance. It is derived from their
 * address rather than assigned on join, so it is the same tomorrow and on a
 * different device.
 *
 * Colour is never the ONLY signal: the chip carries a name, and mode is
 * encoded by dot SHAPE — round for reading, square for editing — so somebody
 * who cannot distinguish two hues still gets both facts.
 */
export function PresenceBar({
  peers,
  following,
  onToggleFollow,
}: {
  peers: Peer[];
  following: string | null;
  onToggleFollow: (uid: string) => void;
}) {
  if (peers.length === 0) return null;

  return (
    <div className="presence-bar" role="group" aria-label="People here now">
      {peers.map((peer) => (
        <button
          key={peer.uid}
          type="button"
          className="presence-chip"
          style={{ color: peer.color }}
          aria-pressed={following === peer.uid}
          title={
            following === peer.uid
              ? `Following ${peer.name}. Scroll to stop.`
              : `Follow ${peer.name}'s scrolling`
          }
          onClick={() => onToggleFollow(peer.uid)}
        >
          <span className="presence-dot" data-mode={peer.mode} />
          <span className="presence-name">{peer.name}</span>
          {peer.mode === "edit" ? (
            <Icon name="edit" size={12} title="Editing" />
          ) : null}
        </button>
      ))}
    </div>
  );
}
