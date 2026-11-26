import type { CSSProperties } from "react";

/** One stop on the tour: the part of the page it rings, and what it says about it. */
export interface TourStep {
  /** CSS selector of the part to ring. */
  target: string;
  title: string;
  text: string;
  /** A short line on each of several options, under the text. */
  items?: [string, string][];
  /** Opens the header's More menu while this step shows, so its items can be ringed. */
  opensMore?: boolean;
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: ".stage .map",
    title: "A grocery store, told in OISS records",
    text: "Everything on this floor plan comes from records sent by four vendors and the store's own systems: shelf scans, shelf cameras, checkout alerts, people counts and shelf labels. Tap any shelf, zone or checkout to see the records behind it.",
  },
  {
    target: ".ticker",
    title: "Every vendor, one format",
    text: "Records arrive here as they're sent. Shelf observations, zone metrics, incidents and tasks all come in the same OISS format, whichever vendor sent them. Tap it to see the full stream.",
  },
  {
    target: ".timebar",
    title: "Play the day",
    text: "Press play, or drag across the chart, to move through the sample day. The chart shows out-of-stock and low-stock facings through the day. Live switches to today, on the store's real clock.",
  },
  {
    target: ".side",
    title: "What the store team sees",
    text: "On-shelf availability, lines and staffed lanes at that moment, and the tasks the records raised for the store team, from replenishment to fixing a shelf tag.",
  },
  {
    target: ".more .menu",
    title: "More views, when you want them",
    text: "Each opens beside the floor plan, which stays in view.",
    items: [
      ["Take the tour", "this tour again"],
      ["The day's story", "four moments a store team would act on, found in the records"],
      ["Vendor disagreements", "where two sources report the same facing differently: stock, a misplaced item or the shelf price"],
      ["Shelf faults", "cause a go-back, a wrong price tag or phantom inventory, then see which vendor catches it"],
      ["Record stream", "every OISS record as it arrives, by type"],
      ["Sources", "each feed behind the demo; switch one off to see what the store would miss"],
      ["Vendors", "the kind of company behind each feed, and what it sends"],
      ["Simulate another day", "a new day, generated in your browser"],
    ],
    opensMore: true,
  },
  {
    target: ".ask-button",
    title: "Ask the store",
    text: "Ask a question in plain words, like “What's out of stock in dairy?” The answers cite the OISS records they came from.",
  },
];

const SEEN_KEY = "oiss-demo-tour-seen";

/** Whether this browser has seen the tour. Storage can be unavailable, so any failure counts as seen. */
export function tourSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Nothing to keep: the tour shows again next time.
  }
}

const GAP = 12;
export const CARD_W = 380;

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Where the card goes: beside the ringed part where there's room, else above or below it, kept on screen. */
export function place(box: Box, card: { w: number; h: number }, vw: number, vh: number): CSSProperties {
  if (vw <= 960) {
    // Narrow screens: the card spans the width, at the top or bottom, away from the ringed part.
    const below = box.top + box.height / 2 < vh / 2;
    return below ? { left: GAP, right: GAP, bottom: GAP } : { left: GAP, right: GAP, top: GAP };
  }
  const clampTop = (t: number) => Math.max(GAP, Math.min(t, vh - card.h - GAP));
  const clampLeft = (l: number) => Math.max(GAP, Math.min(l, vw - card.w - GAP));
  if (vw - (box.left + box.width) >= card.w + 2 * GAP) return { left: box.left + box.width + GAP, top: clampTop(box.top) };
  if (box.left >= card.w + 2 * GAP) return { left: box.left - card.w - GAP, top: clampTop(box.top) };
  if (box.top >= card.h + 2 * GAP) return { left: clampLeft(box.left + box.width / 2 - card.w / 2), top: box.top - card.h - GAP };
  if (vh - (box.top + box.height) >= card.h + 2 * GAP) return { left: clampLeft(box.left + box.width / 2 - card.w / 2), top: box.top + box.height + GAP };
  // No room outside it (the floor plan on a short screen): inside its top right corner.
  return { left: clampLeft(box.left + box.width - card.w - GAP), top: clampTop(box.top + GAP) };
}

