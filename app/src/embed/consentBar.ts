// SPDX-License-Identifier: Apache-2.0
// The embed's own one-line consent bar, because an embed cannot read the answer given on the deployment (SPEC §15 "Consent").

/**
 * The same question as `CookieConsent`, asked where it can be answered. A
 * browser keeps a framed page's storage apart for each site that frames it,
 * so a visitor who answered on this deployment is asked again in an embed on
 * somebody else's page, once per site.
 *
 * Plain DOM, not React: the embed page carries nothing it does not use
 * (`app/src/embed/graph.test.ts`). Decline comes first, so it takes focus
 * first, and neither button is the accent: this surface has no preferred
 * answer.
 */
export function showConsentBar(
  root: HTMLElement,
  onAnswer: (answer: "granted" | "denied") => void,
): () => void {
  const bar = document.createElement("aside");
  bar.className = "embed-consent";
  bar.setAttribute("aria-label", "Cookie choices");

  const text = document.createElement("p");
  text.className = "embed-consent-text";
  text.append("Bikeshed would like to count page views. No titles, addresses or contents are sent. ");
  const privacy = document.createElement("a");
  privacy.href = "/privacy";
  privacy.target = "_blank";
  privacy.rel = "noopener noreferrer";
  privacy.textContent = "Privacy";
  text.append(privacy);

  const button = (label: string, answer: "granted" | "denied"): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = label;
    b.addEventListener("click", () => {
      bar.remove();
      onAnswer(answer);
    });
    return b;
  };
  const actions = document.createElement("div");
  actions.className = "embed-consent-actions";
  actions.append(button("No thanks", "denied"), button("Allow", "granted"));

  bar.append(text, actions);
  root.append(bar);
  return () => bar.remove();
}
