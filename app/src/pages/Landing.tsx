// SPDX-License-Identifier: Apache-2.0
// The public landing page a signed-out visitor sees at / (SPEC §7).

import { Link } from "react-router-dom";

import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";

/**
 * Rendered at `/` only when the gate is `signed_out` — see `RequireAccount` in
 * App.tsx. The other not-ready gates are states in the MIDDLE of a flow, and
 * somebody waiting on a verification code needs the code field, not a pitch.
 *
 * The copy is lifted from README.md, docs/architecture/spec.md §0 and the tour bundle rather
 * than written fresh, so it cannot drift from the voice the product already
 * uses. Every claim here is something the code actually does.
 *
 * Deliberately silent about how concurrent edits merge. That behaviour has
 * changed once already; a landing page is the worst place to restate a decision
 * that moves.
 */

/**
 * Built from the LIVE origin, never a literal host. Bikeshed is self-hosted, so
 * a hardcoded domain would be wrong on every deployment but one — and a host
 * string in the tree is the shape the secrets guard matches for.
 */
export function agentInstructions(origin: string): string {
  return [
    `Publish to Bikeshed at ${origin}.`,
    `Read ${origin}/llms.txt first — that is the complete guide. Follow its`,
    "Start here: install the skills it points at before doing anything else.",
    "It takes a self-contained HTML bundle or a Markdown file, and returns",
    "review comments with the exact passage each one is about.",
    "When a write-up is meant for other people, publish it here rather than",
    "with a built-in artifact tool or as a file left on disk.",
    `If you can't see Bikeshed's tools, ask me to add ${origin}/mcp as a connector.`,
    `If you have a shell, run \`npx -y bikeshed-now login --origin ${origin}\``,
    "and I'll approve it in the browser.",
  ].join("\n");
}

/** The four formats an upload may arrive as, as chips rather than prose. */
const FORMATS = [".html", ".md", ".zip"];

/**
 * A still of the actual interaction.
 *
 * The highlight is drawn the way `annotation/highlighter.ts` draws it: a hairline
 * OUTLINE over a transparent background, not a fill. A document with a dark
 * background is an ordinary case, which is why the real thing never paints one,
 * and a marker-pen swatch here would advertise something that does not exist.
 */
function AnchoredComment() {
  return (
    <figure className="landing-figure">
      <div className="mock" aria-hidden="true">
        <p className="mock-prose">
          Migration is expected to take two weeks, and{" "}
          <mark className="mock-hl">every team will be moved by the 30th</mark>{" "}
          without any interruption to reporting.
        </p>
        <div className="mock-thread">
          <div className="card mock-comment">
            <p className="mock-author">Dana</p>
            <p>Which teams? Payments hasn’t agreed to a date.</p>
          </div>
          <div className="card mock-comment">
            <p className="mock-author">
              drafting-agent <span className="badge-automated">via MCP</span>
            </p>
            <p>Softened to “most teams”, and named the two that are unscheduled.</p>
          </div>
        </div>
      </div>
    </figure>
  );
}

export function Landing() {
  const toast = useToast();
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  function copyForAgent() {
    // Same shape as every other copy in the app: the optional call is what
    // makes it safe where the clipboard API is absent.
    void navigator.clipboard?.writeText(agentInstructions(origin));
    toast.show("Instructions copied");
  }

  /** The address alone, for somebody who would rather hand over just that. */
  function copyGuideUrl() {
    void navigator.clipboard?.writeText(`${origin}/llms.txt`);
    toast.show("Address copied");
  }

  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="landing-hero-main">
          <h1>
            {/* The stop takes the paint, the same move the wordmark makes with
                `.now`. It is the whole joke carried by one character. */}
            Everyone has an opinion<span className="landing-stop">.</span>
          </h1>
          <p className="landing-lead">
            Your agents publish versioned documents here.
            <br />
            Your team discusses and works on them together.
          </p>
          <p className="landing-say">
            Publish a document. Collect comments anchored to the exact passage
            they are about. Revise, and publish again.
          </p>
          <p className="landing-formats">
            HTML or Markdown, shared with named people, a team, or the public.
          </p>
          <p className="landing-cta">
            <Link className="btn btn-primary landing-signin" to="/signup">
              Sign in
            </Link>
          </p>
        </div>

        {/* An aside rather than a section: it sits beside the pitch, and the
            people it is for arrive knowing what they want. */}
        <aside className="landing-agents">
          <h2>Bring your own agent</h2>
          <p className="landing-body">
            Your agent uses the same interface people do. Point it at the
            guide:
          </p>
          <p className="landing-agent-row">
            <span className="landing-guide">
              <a className="mono landing-guide-link" href="/llms.txt">
                {origin}/llms.txt
              </a>
              {/* The icon is the only label here, which is the one case
                  Icon's `title` is for. */}
              <button
                type="button"
                className="icon-btn landing-guide-copy"
                onClick={copyGuideUrl}
              >
                <Icon name="copy" title="Copy the address" />
              </button>
            </span>
            <button type="button" className="btn landing-copy" onClick={copyForAgent}>
              Copy instructions
            </button>
          </p>
        </aside>
      </section>

      <section className="landing-section">
        <h2>Select a passage. A button appears.</h2>
        <AnchoredComment />
      </section>

      <section className="landing-section landing-loop">
        <p className="landing-steps">Publish. Read. Comment. Revise.</p>
        <p className="landing-body">
          Publishing is easy. So is revising. The comment in the middle is what
          usually gets lost.
        </p>
      </section>

      <section className="landing-section">
        <h2>What it does</h2>
        <ul className="landing-points">
          <li>
            <h3>Comments that stay put</h3>
            <p>
              Quote first, position as the fallback. A position that has drifted
              points confidently at the wrong words, which is worse than
              admitting it cannot find them.
            </p>
          </li>
          <li>
            <h3>Your markup, not ours</h3>
            <p>
              Upload a self-contained HTML bundle, a zip with an index at the
              root, or a Markdown file. The editor works on the markup you wrote,
              so a deck with inline SVG and a folded tree survives a round trip.
            </p>
            <p className="landing-chips">
              {FORMATS.map((f) => (
                <span className="chip mono" key={f}>
                  {f}
                </span>
              ))}
            </p>
          </li>
          <li>
            <h3>People and teams</h3>
            <p>
              Share by address, as a viewer or an editor. Make a team and share
              with the team. Folders pass their sharing down to what is inside
              them. It reaches somebody whether or not they have an account: the
              moment they sign in with that address, it is waiting.
            </p>
          </li>
          <li>
            <h3>People and agents, the same way in</h3>
            <p>
              An agent reads and answers comments through the surface a person
              uses, and a comment comes back with the passage it is about. Every
              action carries the channel it came through, derived from the
              credential rather than claimed, so you can always tell which
              feedback a person did not write.
            </p>
          </li>
        </ul>
      </section>

      <footer className="landing-footer">
        <p>Self-hosted. Apache-2.0. v0.1.0. The rough edges are honest ones.</p>
        <p className="landing-footer-nav">
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
        </p>
      </footer>
    </div>
  );
}
