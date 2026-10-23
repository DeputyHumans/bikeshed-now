// SPDX-License-Identifier: Apache-2.0
// Emulator-only health marker fault injection, never a production dependency mutation (SPEC §12).
import { readFileSync } from "node:fs";
import { adminFor } from "./admin.mjs";
const config = JSON.parse(readFileSync(new URL("../../functions/src/health.json", import.meta.url), "utf8"));
export async function healthMarker(target, state) {
  if (target.kind !== "local") throw new Error("Health fault injection is emulator-only");
  const file = adminFor(target).bucket.file(config.storagePath);
  if (state === "missing") await file.delete({ ignoreNotFound: true });
  else if (state === "valid" || state === "corrupt") await file.save(state === "valid" ? config.marker : "wrong-marker", { resumable: false });
  else throw new Error("Unknown health marker state");
}
