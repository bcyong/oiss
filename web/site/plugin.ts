import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Plugin } from "vite";
import { siteFooter, siteHeader } from "./layout.ts";
import { externalLinksInNewTab } from "./links.ts";
import { escapeHtml, renderMarkdown, tocHtml } from "./markdown.ts";

/**
 * Fills each page's placeholders at build time, and on every request in the dev server:
 * <!--site-header--> (or <!--site-header:#root--> to name the skip link's target), <!--site-footer-->,
 * and on the RFC page <!--rfc-title-->, <!--rfc-byline-->, <!--rfc-body--> and <!--rfc-toc-->, rendered
 * from docs/rfc/OISS-RFC.md. An SVG the RFC shows from its own folder is inlined, so it scales and
 * follows the page's colors. Every link that leaves the site then opens in a new tab.
 */
export function sitePages(repoRoot: string): Plugin {
  const rfcDir = resolve(repoRoot, "docs/rfc");
  const rfcFile = resolve(rfcDir, "OISS-RFC.md");

  const rfc = () =>
    renderMarkdown(readFileSync(rfcFile, "utf8"), {
      image: (src, alt) => {
        if (!/^[\w-]+\.svg$/.test(src)) return undefined;
        const svg = readFileSync(resolve(rfcDir, basename(src)), "utf8").replace(/^<\?xml[^>]*>\s*/, "");
        return `<figure class="diagram rfc-figure" aria-label="${escapeHtml(alt)}">${svg}</figure>`;
      },
    });

  return {
    name: "oiss-site-pages",
    configureServer(server) {
      server.watcher.add([rfcFile, rfcDir]);
      server.watcher.on("change", (file) => {
        if (file.startsWith(rfcDir)) server.ws.send({ type: "full-reload" });
      });
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        let out = html
          .replace(/<!--site-header(?::(#[\w-]+))?-->/, (_, skip: string | undefined) => siteHeader(ctx.path, skip))
          .replace("<!--site-footer-->", siteFooter());
        if (out.includes("<!--rfc-body-->")) {
          const doc = rfc();
          out = out
            .replaceAll("<!--rfc-title-->", escapeHtml(doc.title))
            .replace("<!--rfc-byline-->", doc.byline)
            .replace("<!--rfc-body-->", doc.html)
            .replace("<!--rfc-toc-->", tocHtml(doc.toc, 1));
        }
        return externalLinksInNewTab(out);
      },
    },
  };
}
