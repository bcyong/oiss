/**
 * A small Markdown renderer for the site's own documents, such as the RFC. It handles what those
 * documents use: headings, paragraphs, bold, italics, inline code, links, images, tables and
 * bulleted or numbered lists. Text is escaped, so no HTML in the source reaches the page.
 */

import { isExternalHref, NEW_TAB_ATTRS } from "./links.ts";

export interface TocEntry {
  id: string;
  text: string;
  children: TocEntry[];
}

export interface Rendered {
  /** The first-level heading, as plain text. */
  title: string;
  /** The paragraph right under the title, such as the author and date, as HTML. */
  byline: string;
  /** Everything after the title and byline. */
  html: string;
  /** Second- and third-level headings, for an "On this page" list. */
  toc: TocEntry[];
}

export interface RenderOptions {
  /** Returns the HTML for an image, such as an inlined SVG. Without it, images become <img> tags. */
  image?: (src: string, alt: string) => string | undefined;
}

export function escapeHtml(s: string): string {
  return s.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A heading's anchor id: "1. The problem" becomes "1-the-problem". */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[^;]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const SAFE_URL = /^(https?:\/\/|\/|#|mailto:)/;

/** Inline Markdown in one line of text. */
export function inline(text: string): string {
  const parts: string[] = [];
  // Code spans first, so nothing inside them is formatted.
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(emphasis(escapeHtml(text.slice(last, m.index))));
    if (m[1] !== undefined) parts.push(`<code>${escapeHtml(m[1])}</code>`);
    else {
      const href = m[3]!;
      const label = emphasis(escapeHtml(m[2]!));
      parts.push(SAFE_URL.test(href) ? `<a href="${escapeHtml(href)}"${isExternalHref(href) ? ` ${NEW_TAB_ATTRS}` : ""}>${label}</a>` : label);
    }
    last = m.index! + m[0].length;
  }
  parts.push(emphasis(escapeHtml(text.slice(last))));
  return parts.join("");
}

function emphasis(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, "$1<em>$2</em>");
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function renderMarkdown(source: string, options: RenderOptions = {}): Rendered {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const toc: TocEntry[] = [];
  let title = "";
  let byline = "";
  let i = 0;

  const isBlockStart = (l: string) => /^(#{1,6}\s|\||\s*[-*]\s|\s*\d+\.\s|!\[)/.test(l);

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      i++;
      if (level === 1 && !title) {
        title = text;
        // The paragraph straight after the title is its byline.
        while (i < lines.length && !lines[i]!.trim()) i++;
        if (i < lines.length && !isBlockStart(lines[i]!)) {
          byline = inline(lines[i]!.trim());
          i++;
        }
        continue;
      }
      const id = slug(text);
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      if (level === 2) toc.push({ id, text, children: [] });
      else if (level === 3 && toc.length) toc[toc.length - 1]!.children.push({ id, text, children: [] });
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (image) {
      const [, alt, src] = image;
      const custom = options.image?.(src!, alt!);
      out.push(custom ?? `<figure class="diagram"><img src="${escapeHtml(src!)}" alt="${escapeHtml(alt!)}" /></figure>`);
      i++;
      continue;
    }

    if (line.trim().startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(lines[i++]!);
      const [head, sep, ...body] = rows;
      if (head && sep && /^[\s|:-]+$/.test(sep)) {
        out.push(
          `<div class="table-wrap"><table><thead><tr>${cells(head)
            .map((c) => `<th>${inline(c)}</th>`)
            .join("")}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
        );
      } else out.push(`<p>${rows.map((r) => inline(r.trim())).join(" ")}</p>`);
      continue;
    }

    const bullet = /^\s*([-*]|\d+\.)\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && bullet.test(lines[i]!) && /^\s*\d+\./.test(lines[i]!) === ordered) {
        items.push(lines[i]!.replace(bullet, ""));
        i++;
        // A line that continues the item without a marker belongs to it.
        while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) items[items.length - 1] += ` ${lines[i++]!.trim()}`;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.trim())}</li>`).join("")}</${tag}>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) para.push(lines[i++]!.trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }

  return { title, byline, html: out.join("\n"), toc };
}

/** The "On this page" list for a rendered document. */
export function tocHtml(toc: TocEntry[], depth = 2): string {
  const list = (entries: TocEntry[], level: number): string =>
    `<ul>${entries.map((e) => `<li><a href="#${e.id}">${inline(e.text)}</a>${e.children.length && level < depth ? list(e.children, level + 1) : ""}</li>`).join("")}</ul>`;
  return list(toc, 1);
}
