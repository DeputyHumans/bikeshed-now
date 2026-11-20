// SPDX-License-Identifier: Apache-2.0
// A person, drawn as their short name with their address under the pointer (SPEC §16, §17, ADR 0040).

import { peerColor } from "../brand/tokens";
import { usePersonName, type Named } from "../people";

/**
 * Three ways to draw somebody, by how much the place can hold:
 *
 *   chip   the dot and the name in a pill: the header, where you are you
 *   dot    the dot and the name: who wrote a comment, who published a version
 *   plain  the name alone, inside a sentence: "Accepted by Pavel S"
 *
 * The dot is the colour the person already has everywhere (`peerColor`, keyed
 * by address as presence and threads are), never the only thing saying who it
 * is. The address is the tooltip, because it is what tells two Pavel S apart.
 */
export function Person({
  uid,
  email,
  known,
  mark = "plain",
  className,
}: Named & { mark?: "chip" | "dot" | "plain"; className?: string }) {
  const name = usePersonName({ uid, email, known });
  const classes = ["person", mark === "chip" ? "chip person-chip" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={classes} title={email}>
      {mark === "plain" ? null : (
        <span className="person-dot" style={{ background: peerColor(email) }} aria-hidden="true" />
      )}
      <span className="person-name">{name}</span>
    </span>
  );
}
