/**
 * The demo is dark like the rest of the site. A light theme is kept for screenshots on light slides
 * and printouts; the choice is remembered in this browser only.
 */
export type Theme = "dark" | "light";

const KEY = "oiss-demo-theme";

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  try {
    if (theme === "light") localStorage.setItem(KEY, "light");
    else localStorage.removeItem(KEY);
  } catch {
    // Storage can be blocked; the theme still applies for this visit.
  }
}
