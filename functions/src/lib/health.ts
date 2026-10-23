// SPDX-License-Identifier: Apache-2.0
// Bounded, read-only dependency health with no public diagnostic details (SPEC §2).

import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { noStore, rejectMethod } from "./http";

type Dependencies = {
  firestore: () => Promise<unknown>;
  storage: () => Promise<unknown>;
  report: (dependency: string) => void;
};

/** Each invocation reads afresh; only the response status is public. */
export function healthHandler(dependencies: Dependencies, deadlineMs = 5000) {
  return async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    if (rejectMethod(req, res, ["GET", "HEAD"])) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async (name: "firestore" | "storage") => {
      try { await dependencies[name](); }
      catch { dependencies.report(name); throw new Error("dependency failed"); }
    };
    let healthy = false;
    try {
      await Promise.race([
        Promise.all([check("firestore"), check("storage")]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            dependencies.report("deadline");
            reject(new Error("health deadline"));
          }, deadlineMs);
        }),
      ]);
      healthy = true;
    } catch { /* Details stay in the structured, bounded diagnostic event. */ }
    finally { clearTimeout(timer); }
    res.status(healthy ? 200 : 503);
    if (req.method === "HEAD") res.end();
    else res.json({ status: healthy ? "ok" : "degraded" });
  };
}
