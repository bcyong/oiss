/**
 * The header and footer that every page of the site shares. The Vite plugin in plugin.ts puts them
 * into each page's HTML at build time, so the static pages and the React pages get the same markup.
 * Every link stays on the site; the GitHub page links out from its own body.
 */

export const NAV = [
  { href: "/rfc/", label: "RFC", page: "rfc" },
  { href: "/spec/", label: "Schemas", page: "spec" },
  { href: "/demo/", label: "Demo", page: "demo" },
] as const;
export const GITHUB = { href: "/github/", label: "GitHub", page: "github" } as const;

/** Which page an HTML entry is: "/demo/index.html" is "demo", "/index.html" is "home". */
export function pageOf(path: string): string {
  const m = /^\/?([^/]+)\/(?:index\.html)?$/.exec(path);
  return m ? m[1]! : "home";
}

const current = (page: string, here: string) => (page === here ? ' aria-current="page"' : "");

const LOGO =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="3" width="14" height="10" rx="1.5" /><rect class="cut" x="4" y="6" width="2" height="5" /><rect class="cut" x="7" y="6" width="2" height="5" /><rect class="cut" x="10" y="6" width="2" height="5" /></svg>';

/** The site header: the OISS mark, RFC, Schemas and Demo on the left, GitHub on the right. */
export function siteHeader(path: string, skipTo = "#main-content"): string {
  const here = pageOf(path);
  return [
    `<a class="skip" href="${skipTo}">Skip to main content</a>`,
    '<header class="topbar">',
    '  <div class="topbar-inner">',
    `    <a class="brand" href="/"${current("home", here)}>${LOGO}OISS</a>`,
    '    <nav aria-label="Main">',
    ...NAV.map((n) => `      <a href="${n.href}"${current(n.page, here)}>${n.label}</a>`),
    "    </nav>",
    `    <a class="topbar-gh" href="${GITHUB.href}"${current(GITHUB.page, here)}>${GITHUB.label}</a>`,
    "  </div>",
    "</header>",
  ].join("\n");
}

/** The footer of the site's document pages. */
export function siteFooter(): string {
  return [
    '<footer class="footer">',
    '  <a href="/rfc/">RFC</a>',
    '  <span aria-hidden="true">|</span>',
    '  <a href="/demo/">Demo</a>',
    '  <span aria-hidden="true">|</span>',
    '  <a href="/spec/">Schemas</a>',
    '  <span aria-hidden="true">|</span>',
    '  <a href="/github/">GitHub</a>',
    "  <p>OISS is a community draft. All demo data is synthetic.</p>",
    "</footer>",
  ].join("\n");
}
