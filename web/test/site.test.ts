import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pageOf, siteFooter, siteHeader } from "../site/layout.ts";
import { externalLinksInNewTab } from "../site/links.ts";
import { sitePages } from "../site/plugin.ts";
import { inline, renderMarkdown, slug, tocHtml } from "../site/markdown.ts";

const repo = resolve(import.meta.dirname, "../..");

test("the header has RFC, Schemas and Demo on the left and GitHub on the right, all on the site", () => {
  const html = siteHeader("/demo/index.html", "#root");
  const nav = /<nav aria-label="Main">([\s\S]*?)<\/nav>/.exec(html)![1]!;
  assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), ["RFC", "Schemas", "Demo"]);
  assert.match(html.split("</nav>")[1]!, /class="topbar-gh" href="\/github\/"[^>]*>GitHub</);
  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) assert.match(href!, /^[/#]/, `${href} leaves the site`);
  assert.match(html, /href="\/demo\/" aria-current="page"/);
  assert.match(html, /href="#root">Skip/);
});

test("each page knows which header link is its own", () => {
  assert.equal(pageOf("/index.html"), "home");
  assert.equal(pageOf("/rfc/index.html"), "rfc");
  assert.equal(pageOf("/github/"), "github");
  assert.match(siteHeader("/rfc/index.html"), /href="\/rfc\/" aria-current="page"/);
  assert.match(siteHeader("/github/index.html"), /href="\/github\/" aria-current="page"/);
  assert.match(siteHeader("/spec/index.html"), /href="\/spec\/" aria-current="page"/);
});

test("the footer links stay on the site", () => {
  for (const [, href] of siteFooter().matchAll(/href="([^"]+)"/g)) assert.match(href!, /^\//);
});

test("every page carries the shared header", () => {
  for (const page of ["index.html", "rfc/index.html", "demo/index.html", "spec/index.html", "github/index.html"]) {
    const html = readFileSync(resolve(repo, "web", page), "utf8");
    assert.match(html, /<!--site-header(:#[\w-]+)?-->/, page);
    assert.match(html, /href="\/src\/site\.css"/, page);
    assert.doesNotMatch(html, /<header class="topbar">/, `${page} has its own header`);
    assert.doesNotMatch(html, /role="tablist"/, `${page} has page tabs; the header is the site's navigation`);
  }
});

test("inline Markdown escapes HTML and formats bold, italics, code and links", () => {
  assert.equal(inline("**Bold** and *it* <b>"), "<strong>Bold</strong> and <em>it</em> &lt;b&gt;");
  assert.equal(inline("Run `a < b`"), "Run <code>a &lt; b</code>");
  assert.equal(inline("[GS1](https://www.gs1.org/epcis)"), '<a href="https://www.gs1.org/epcis" target="_blank" rel="noopener noreferrer">GS1</a>');
  assert.equal(inline("[RFC](/rfc/)"), '<a href="/rfc/">RFC</a>');
  assert.doesNotMatch(inline("[bad](javascript:alert(1))"), /href/);
  assert.equal(slug("1. The problem"), "1-the-problem");
});

test("a document renders its title, byline, sections, tables and lists", () => {
  const doc = renderMarkdown(
    ["# Title", "", "Someone · 2026", "", "## First", "", "Text that", "wraps.", "", "| A | B |", "| --- | --- |", "| 1 | **2** |", "", "### Inner", "", "- one", "- two", "", "1. a", "2. b", "", "![Alt](x.svg)"].join("\n"),
    { image: (src, alt) => `<figure>${src}:${alt}</figure>` },
  );
  assert.equal(doc.title, "Title");
  assert.equal(doc.byline, "Someone · 2026");
  assert.match(doc.html, /<h2 id="first">First<\/h2>/);
  assert.match(doc.html, /<p>Text that wraps\.<\/p>/);
  assert.match(doc.html, /<th>A<\/th><th>B<\/th>[\s\S]*<td>1<\/td><td><strong>2<\/strong><\/td>/);
  assert.match(doc.html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(doc.html, /<ol><li>a<\/li><li>b<\/li><\/ol>/);
  assert.match(doc.html, /<figure>x\.svg:Alt<\/figure>/);
  assert.deepEqual(doc.toc, [{ id: "first", text: "First", children: [{ id: "inner", text: "Inner", children: [] }] }]);
  assert.doesNotMatch(tocHtml(doc.toc, 1), /inner/);
});

test("the RFC in the repo renders whole, with its diagram and a way to comment off the doc", () => {
  const source = readFileSync(resolve(repo, "docs/rfc/OISS-RFC.md"), "utf8");
  const doc = renderMarkdown(source, { image: (src) => `<figure data-src="${src}"></figure>` });
  assert.match(doc.title, /^OISS RFC/);
  const sections = doc.toc.map((e) => e.text);
  for (const s of ["Summary", "1. The problem", "4. The proposal", "9. Governance, license, and open questions", "Glossary", "References"]) assert.ok(sections.includes(s), s);
  assert.match(doc.html, /<figure data-src="today-vs-oiss\.svg">/);
  assert.match(doc.html, /<figure data-src="how-oiss-fits\.svg">/);
  assert.doesNotMatch(doc.html, /embedded content|in this document\./);
  // Every Markdown link became a link, and no Markdown syntax is left over.
  assert.equal((doc.html.match(/<a href=/g) ?? []).length, (source.match(/\]\(https?:/g) ?? []).length);
  assert.doesNotMatch(doc.html.replace(/<[^>]+>/g, ""), /\*\*|\]\(|^\|/m);
});

test("a link that leaves the site gets a new tab, and links on the site stay in the tab", () => {
  assert.equal(
    externalLinksInNewTab('<a class="btn" href="https://github.com/bcyong/oiss">Repo</a>'),
    '<a class="btn" href="https://github.com/bcyong/oiss" target="_blank" rel="noopener noreferrer">Repo</a>',
  );
  assert.equal(externalLinksInNewTab('<a href="/demo/">Demo</a> <a href="#x">X</a> <a href="mailto:a@b.c">M</a>'), '<a href="/demo/">Demo</a> <a href="#x">X</a> <a href="mailto:a@b.c">M</a>');
  assert.equal(externalLinksInNewTab('<a href="https://x.org" target="_self">X</a>'), '<a href="https://x.org" target="_self">X</a>');
  assert.equal(externalLinksInNewTab('<a href="https://x.org" rel="nofollow">X</a>'), '<a href="https://x.org" target="_blank" rel="noopener noreferrer">X</a>');
});

const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);

test("every page as built opens each external link in a new tab", () => {
  const plugin = sitePages(repo);
  const hook = plugin.transformIndexHtml as { handler: (html: string, ctx: { path: string }) => string };
  for (const page of ["index.html", "rfc/index.html", "demo/index.html", "spec/index.html", "github/index.html"]) {
    const html = hook.handler(readFileSync(resolve(repo, "web", page), "utf8"), { path: `/${page}` });
    const external = anchors(html).filter((a) => /href="https?:/.test(a));
    if (page === "index.html" || page === "github/index.html" || page === "rfc/index.html") assert.ok(external.length > 0, page);
    for (const a of external) assert.match(a, /target="_blank" rel="noopener noreferrer"/, `${page}: ${a}`);
    for (const a of anchors(html).filter((x) => /href="[/#]/.test(x))) assert.doesNotMatch(a, /target=/, `${page}: ${a}`);
  }
});

test("every external link the demo and schema browser draw opens in a new tab", () => {
  const dir = resolve(import.meta.dirname, "../src");
  for (const file of readdirSync(dir, { recursive: true }) as string[]) {
    if (!file.endsWith(".tsx")) continue;
    const src = readFileSync(resolve(dir, file), "utf8");
    for (const [tag] of src.matchAll(/<a\b[^>]*href=\{?["'`]https?:[^>]*>/g)) assert.match(tag, /target="_blank" rel="noopener noreferrer"/, `${file}: ${tag}`);
  }
});
