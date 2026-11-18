// SPDX-License-Identifier: Apache-2.0
// What publishing a pick would do, shown before anything is sent (SPEC §2).

import { describeLeftOut, type Pick, type Plan } from "../bundleInput";

const SHOWN = 8;

/** Up to eight names, then "and 12 more". */
function some<T>(items: readonly T[], render: (item: T) => React.ReactNode, key: (item: T) => string) {
  const shown = items.slice(0, SHOWN);
  return (
    <>
      {shown.map((item) => <li key={key(item)}>{render(item)}</li>)}
      {items.length > SHOWN ? <li className="caption">and {items.length - SHOWN} more</li> : null}
    </>
  );
}

/**
 * The consequences of publishing, in the order a person needs them: what it
 * opens with, what an update replaces and what it drops, what was left out,
 * and what stops it. `version` is true in the new-version dialog.
 */
export function PlanSummary({ plan, pick, version }: { plan: Plan; pick: Pick; version: boolean }) {
  const leftOut = describeLeftOut(pick.leftOut);
  return (
    <div className="upload-plan">
      {plan.action === "bundle" && plan.entry ? (
        <p>Opens with <code>{plan.entry}</code>.</p>
      ) : null}

      {version && plan.action === "page" ? (
        <p>
          Replaces the page.{" "}
          {plan.keeps === 1 ? "The other file stays as it is." : plan.keeps > 1 ? `The other ${plan.keeps} files stay as they are.` : null}
        </p>
      ) : null}
      {version && plan.action === "zip" ? (
        <p>The zip becomes the whole next version: any file the current version has that the zip doesn’t is removed.</p>
      ) : null}
      {version && plan.action === "bundle" ? (
        plan.drops.length > 0 ? (
          <div className="banner banner-warn" role="status">
            <p>
              The folder becomes the whole next version, so it removes {plan.drops.length === 1 ? "a file" : `${plan.drops.length} files`} the current version has:
            </p>
            <ul className="upload-list">{some(plan.drops, (p) => <code>{p}</code>, (p) => p)}</ul>
          </div>
        ) : (
          <p>The folder becomes the whole next version.</p>
        )
      ) : null}
      {plan.action === "merge" ? (
        <>
          <ul className="upload-list">
            {some(
              plan.files,
              (p) => (
                <>
                  <code>{p.sent.path}</code>{" "}
                  {p.does === "adds" ? "is added" : p.does === "replaces the page" ? "replaces the page" : <>replaces <code>{p.at}</code></>}
                </>
              ),
              (p) => p.sent.path,
            )}
          </ul>
          <p>Every other file stays as it is.</p>
        </>
      ) : null}

      {leftOut ? <p className="caption">{leftOut}</p> : null}

      {plan.problems.length > 0 ? (
        <div className="banner banner-error" role="alert">
          <ul className="upload-list">{some(plan.problems, (p) => p, (p) => p)}</ul>
        </div>
      ) : null}
    </div>
  );
}
