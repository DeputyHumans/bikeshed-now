// SPDX-License-Identifier: Apache-2.0
// What /sitemap.xml says: the site's own public pages, then its public documents (SPEC §2).

/**
 * The pages every deployment answers for anybody, in the order they are listed.
 * None has a date: a build date is not when the page changed, and a sitemap that
 * guesses is one a crawler learns to ignore.
 *
 * `/docs` is not here. It redirects to `/d/docs`, which is listed as a document
 * once a deployment has published it.
 */
const PAGES = ["/", "/terms", "/privacy"] as const;

export interface SitemapDocument {
  id: string;
  /** `YYYY-MM-DD`, or empty when the record has no date to give. */
  lastmod: string;
}

function entry(loc: string, lastmod: string): string {
  const escaped = loc.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `  <url><loc>${escaped}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
}

export function sitemapXml(origin: string, documents: readonly SitemapDocument[]): string {
  const entries = [
    ...PAGES.map((path) => entry(`${origin}${path}`, "")),
    ...documents.map((d) => entry(`${origin}/d/${d.id}`, d.lastmod)),
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}
