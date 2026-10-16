// SPDX-License-Identifier: Apache-2.0
// The public landing page a signed-out visitor sees at / (SPEC §7).

import { Link } from "react-router-dom";

import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { APP_VERSION } from "../config";
import { LandingVideo } from "./LandingVideo";

/**
 * Rendered at `/` only when the gate is `signed_out` — see `RequireAccount` in
 * App.tsx. The other not-ready gates are states in the MIDDLE of a flow, and
 * somebody waiting on a verification code needs the code field, not a pitch.
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
        <h1>
          Everyone has an opinion<span className="landing-stop">.</span>
          <span className="landing-agent-line">Including your agent<span className="landing-stop">.</span></span>
        </h1>
        <p className="landing-lead">
          Publish a document. Review it with your team and your agent.
          Keep feedback with the words it’s about.
        </p>
        <p className="landing-formats">Bring your HTML or Markdown. Share it with your team.</p>
        <div className="landing-cta">
          <Link className="btn btn-primary landing-start" to="/signup">Get started</Link>
          <span className="landing-fine">Sign in or create an account</span>
        </div>
      </section>

      <LandingVideo />

      <section className="landing-section" aria-label="Why Bikeshed">
        <ul className="landing-points">
          <li>
            <h2>Feedback in context</h2>
            <p>Select the words you mean. Leave a comment or suggest a change, right where it belongs.</p>
          </li>
          <li>
            <h2>Versions you can return to</h2>
            <p>Revise and publish again. Earlier versions stay available, so you can see what changed.</p>
          </li>
          <li>
            <h2>People and agents together</h2>
            <p>Your team reviews. Your agent reads the feedback, revises, and replies. Agent comments are labelled.</p>
          </li>
        </ul>
      </section>

      <section className="landing-agents" aria-labelledby="landing-agents-title">
        <h2 id="landing-agents-title">Bring your own agent</h2>
        <p className="landing-body">
          Give your agent these instructions to publish here and work through your team’s feedback.
        </p>
        <p className="landing-agent-row">
          <span className="landing-guide">
            <a className="mono landing-guide-link" href="/llms.txt">{origin}/llms.txt</a>
            <button type="button" className="icon-btn landing-guide-copy" onClick={copyGuideUrl}>
              <Icon name="copy" title="Copy the address" />
            </button>
          </span>
          <button type="button" className="btn landing-copy" onClick={copyForAgent}>
            Copy instructions
          </button>
        </p>
        <p className="landing-body landing-manual">
          You can also upload HTML, Markdown, or a ZIP bundle yourself after signing in.
        </p>
      </section>

      <section className="landing-bottom-cta" aria-label="Get started with Bikeshed">
        <p>Bring your next draft.</p>
        <Link className="btn btn-primary landing-start" to="/signup">Get started</Link>
      </section>

      <footer className="landing-footer">
        <p>Self-hosted. Apache-2.0. v{APP_VERSION}.</p>
        <p className="landing-footer-nav">
          {/* Plain, like the /llms.txt link: /docs is answered by Hosting. */}
          <a href="/docs">Docs</a>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
        </p>
      </footer>
    </div>
  );
}
