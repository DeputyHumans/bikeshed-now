// SPDX-License-Identifier: Apache-2.0
// The terms of service and the privacy policy (SPEC §21).

import { Link } from "react-router-dom";
import { LEGAL_CONTACT } from "../config";
import { analyticsConfigured } from "../analytics";
import { readConsent, writeConsent } from "../consent";

/**
 * These describe THIS DEPLOYMENT, not the Bikeshed project.
 *
 * Bikeshed is self-hosted, so the operator of each deployment is the party who
 * holds the data and owes the duties. The text below is written to be true of a
 * default deployment of this codebase — every claim in the privacy policy is
 * something the code actually does, and several are enforced by tests rather
 * than by intention.
 *
 * An operator changing what the software does must change these pages too. The
 * most likely way for them to go stale is somebody adding a third party.
 */

const UPDATED = "4 November 2026";

function Contact() {
  if (!LEGAL_CONTACT) {
    return (
      <>this deployment has not published a contact address, which its operator should fix</>
    );
  }
  return <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>;
}

function LegalNav() {
  return (
    <nav className="legal__nav">
      <Link to="/">Back to your documents</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/privacy">Privacy</Link>
    </nav>
  );
}

export function Terms() {
  return (
    <main className="legal" id="main">
      <h1>Terms of service</h1>
      <p className="legal__updated">Last updated {UPDATED}</p>

      <p>
        These terms cover your use of this Bikeshed deployment. Bikeshed is
        open-source software under the Apache License 2.0; these terms are
        between you and whoever operates this particular installation of it.
      </p>

      <h2>What the service does</h2>
      <p>
        You publish documents, share them with named people, teams, or publicly,
        and collect comments anchored to passages of text. Documents are stored
        as immutable versions.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>
          You need a verified email address. Access is granted to an address, so
          keep control of yours — anyone who controls it can reach what was
          shared with it.
        </li>
        <li>One account per email address. Do not share credentials.</li>
        <li>
          Personal access tokens carry your full access. Treat one like a
          password, and revoke it in your account settings if it leaks.
        </li>
      </ul>

      <h2>Your content stays yours</h2>
      <p>
        You keep all rights to the documents and comments you publish here.
        Operating the service requires storing, copying and displaying them to
        the people you share them with, and you grant permission for that and
        nothing more. We claim no licence to use your content for anything else.
      </p>

      <h2>What you may not do</h2>
      <ul>
        <li>Publish content you have no right to publish.</li>
        <li>
          Publish material that is unlawful, or that exists to harass or defraud
          somebody.
        </li>
        <li>
          Try to reach documents you were not granted, interfere with the
          service, or work around its access controls.
        </li>
        <li>
          Use automated access to place load that degrades the service for other
          people. Agent access through the API and MCP endpoint is expected and
          welcome; hammering them is not.
        </li>
      </ul>

      <h2>Documents you publish publicly</h2>
      <p>
        Making a document public or unlisted means anyone with the link can read
        it without an account. Search engines may index a public document, and AI
        crawlers may read it, including crawlers that collect training data for AI
        models. That is irreversible in the practical sense: once something has
        been read, copied or cached, making it private again does not unread it.
        Cached copies can be served for up to five minutes after you change it.
      </p>

      <h2>Availability</h2>
      <p>
        The service is provided as-is, with no guarantee of availability,
        and may change or stop. Keep your own copies of anything you cannot
        afford to lose; every document can be downloaded in its original form.
      </p>

      <h2>No warranty, and limits on liability</h2>
      <p>
        To the fullest extent the law allows, this service is provided without
        warranties of any kind, and its operator is not liable for indirect or
        consequential losses arising from your use of it. Nothing here limits
        liability that cannot lawfully be limited.
      </p>

      <h2>Ending it</h2>
      <p>
        You may stop using the service at any time. Its operator may suspend
        access that breaks these terms. Deleting a document moves it to your
        Trash, where it stays, yours alone, for 30 days unless you restore it,
        and is then deleted for good; you can delete it sooner from the Trash,
        with a code we email you. Copies other people saved, and what a cache
        already holds for a few minutes, cannot be recalled. A version can be
        withdrawn by an operator, and you can ask for your content to be
        removed using the contact below.
      </p>

      <h2>Changes</h2>
      <p>
        These terms may change. The date above tells you when they last did.
        Continuing to use the service after a change means you accept it.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <Contact />.
      </p>

      <LegalNav />
    </main>
  );
}

export function Privacy() {
  const consent = readConsent();
  return (
    <main className="legal" id="main">
      <h1>Privacy policy</h1>
      <p className="legal__updated">Last updated {UPDATED}</p>

      <p>
        This describes what this deployment stores and who it is shared with.
        Bikeshed is self-hosted, so the operator of this installation is the
        party holding the data.
      </p>

      <h2>What is collected</h2>
      <ul>
        <li>
          <strong>Your account</strong> — the email address and display name
          your sign-in provider returns, and which providers you have linked.
        </li>
        <li>
          <strong>What you publish</strong> — documents, their versions, and
          who you shared them with.
        </li>
        <li>
          <strong>Comments and highlights</strong>, with the passage each is
          anchored to and who wrote it.
        </li>
        <li>
          <strong>Reading activity on documents you can see</strong> — that a
          document was opened, and roughly how long it was actively read for.
          The owner of a document can see this for their own documents, and
          you can see your own: it is what Recent lists.
        </li>
        <li>
          <strong>Provenance</strong> — whether an action came from the web app,
          the command line, or an agent, and which access token was used.
        </li>
      </ul>

      <h2>What is deliberately not collected</h2>
      <ul>
        <li>
          <strong>No IP addresses or device fingerprints</strong> are stored with
          reading activity, and no attempt is made to identify anonymous
          readers. Sessions are counted; people are not.
        </li>
        <li>
          <strong>No document titles, slugs, folder names or email addresses are
          ever sent to analytics.</strong> Only route patterns such as{" "}
          <code>/d/:docId</code>, never <code>/d/your-document</code>. A test
          asserts this, because a document slug is frequently the confidential
          part.
        </li>
        <li>No advertising, no profiling, no selling of anything to anybody.</li>
      </ul>

      <h2>Cookies</h2>
      <ul>
        <li>
          <strong>Session cookie</strong> — strictly necessary. It is what lets
          the service serve you a document you have access to. It cannot be
          switched off while you are signed in, and it needs no consent.
        </li>
        <li>
          <strong>Analytics cookies</strong> — only if you allow them, and only
          if this deployment configured analytics at all. Decline and the
          measurement script is never loaded, rather than loaded and disabled.
        </li>
        <li>
          <strong>Your view choices</strong> — how you last sorted and laid out
          your documents, and which filters you left on. They are kept in this
          browser so they are there when you come back, never leave it, and are
          forgotten when you clear this site's data.
        </li>
      </ul>
      {analyticsConfigured() ? (
        <p>
          Your current choice on this device:{" "}
          <strong>
            {consent === "granted"
              ? "analytics allowed"
              : consent === "denied"
                ? "analytics declined"
                : "not yet chosen"}
          </strong>
          .{" "}
          {consent !== "unset" ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                writeConsent(consent === "granted" ? "denied" : "granted");
                window.location.reload();
              }}
            >
              {consent === "granted" ? "Withdraw it" : "Allow analytics"}
            </button>
          ) : null}
        </p>
      ) : (
        <p>This deployment has not configured analytics, so none is collected.</p>
      )}

      <h2>Who else sees it</h2>
      <ul>
        <li>
          <strong>Google Firebase</strong> hosts the service, stores the data and
          handles sign-in.
        </li>
        <li>
          <strong>Your sign-in provider</strong> confirms your identity to us. We
          receive your address and name, not your password.
        </li>
        <li>
          <strong>Resend</strong> delivers transactional email, if this
          deployment configured it. It sees the recipient address and the
          message.
        </li>
        <li>
          <strong>Google Analytics</strong> receives route patterns and event
          counts, if this deployment configured it and you allowed cookies.
        </li>
      </ul>
      <p>
        Your documents are shared with the people you share them with, and with
        anyone at all if you make a document public. Nobody else is given access
        to them.
      </p>

      <h2>How long it is kept</h2>
      <p>
        Documents and their versions are kept until removed by the operator.
        Versions are immutable by design, which means editing a document adds a
        version rather than replacing one — earlier versions remain readable to
        people who can read the document.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Allow or decline analytics cookies, above, at any time.</li>
        <li>
          Turn off email notifications in your account settings. Email tied to
          verifying your address still sends.
        </li>
        <li>Revoke any access token you have created.</li>
        <li>
          Ask for a copy of your data or for it to be deleted, using the contact
          below. Any document can be downloaded in its original form at any time.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Documents are stored in a private bucket and are never served directly.
        Every request for document bytes is authenticated and checked against
        the document's access list first. A document that has not been vouched
        for runs with its scripts blocked.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, access requests or deletion requests: <Contact />.
      </p>

      <LegalNav />
    </main>
  );
}
