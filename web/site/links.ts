/**
 * Links that leave the site open in a new tab, so a reader keeps their place in the RFC, the schemas or
 * the demo. Every link to another page of this site is written as a path ("/spec/") or a fragment ("#x"),
 * so an absolute http(s) address always points somewhere else.
 */
export const NEW_TAB_ATTRS = 'target="_blank" rel="noopener noreferrer"';

export const isExternalHref = (href: string): boolean => /^https?:\/\//i.test(href.trim());

/** Adds the new-tab attributes to every external link in a page that doesn't already set a target. */
export function externalLinksInNewTab(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (tag, attrs: string) => {
    const href = /\shref\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2];
    if (href === undefined || !isExternalHref(href) || /\starget\s*=/i.test(attrs)) return tag;
    const rest = attrs.replace(/\srel\s*=\s*(["']).*?\1/i, "");
    return `<a${rest} ${NEW_TAB_ATTRS}>`;
  });
}
