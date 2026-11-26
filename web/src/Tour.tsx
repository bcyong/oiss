import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CARD_W, markSeen, place, TOUR_STEPS, type Box, type TourStep } from "./tourSteps.ts";

export { tourSeen } from "./tourSteps.ts";

/**
 * A short guided tour over the demo's always-visible parts. It rings one part at a time with a card beside it.
 * Skip, Escape or finishing closes it, and it counts as seen either way.
 */
export function Tour({ onClose, onStory, onMore, steps = TOUR_STEPS }: { onClose: () => void; onStory: () => void; onMore: (open: boolean) => void; steps?: TourStep[] }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState({ w: CARD_W, h: 220 });
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const card = useRef<HTMLDivElement>(null);
  const step = steps[i]!;
  const last = i === steps.length - 1;

  const measure = useCallback(() => {
    const el = document.querySelector(step.target);
    setView({ w: window.innerWidth, h: window.innerHeight });
    if (!el) return setBox(null);
    const r = el.getBoundingClientRect();
    setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [step.target]);

  // The More step needs the menu open before it can ring it.
  useLayoutEffect(() => {
    onMore(!!step.opensMore);
  }, [step.opensMore, onMore]);

  // Bring the part into view, then ring it. On phones the page scrolls, so wait for the scroll to settle.
  useLayoutEffect(() => {
    const el = document.querySelector(step.target);
    if (el && window.innerWidth <= 960) el.scrollIntoView({ block: "center" });
    measure();
    const t = setTimeout(measure, 350);
    return () => clearTimeout(t);
  }, [step.target, measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  useLayoutEffect(() => {
    const c = card.current;
    if (!c) return;
    setCardSize({ w: c.offsetWidth, h: c.offsetHeight });
    c.focus({ preventScroll: true });
  }, [i]);

  const close = (story = false) => {
    markSeen();
    onMore(false);
    onClose();
    if (story) onStory();
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" && !last) setI((x) => x + 1);
      else if (e.key === "ArrowLeft" && i > 0) setI((x) => x - 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const pad = 6;
  const ring: CSSProperties | undefined = box ? { top: box.top - pad, left: box.left - pad, width: box.width + 2 * pad, height: box.height + 2 * pad } : undefined;
  const cardStyle = box ? place(box, cardSize, view.w, view.h) : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };

  return (
    <div className="tour">
      <div className="tour-block" onClick={(e) => e.stopPropagation()} />
      {ring ? <div className="tour-ring" style={ring} /> : <div className="tour-dim" />}
      <div ref={card} className="tour-card" style={cardStyle} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text" tabIndex={-1}>
        <p className="tour-count">
          {i + 1} of {steps.length}
        </p>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-text">{step.text}</p>
        {step.items && (
          <ul className="tour-items">
            {step.items.map(([name, what]) => (
              <li key={name}>
                <b>{name}:</b> {what}
              </li>
            ))}
          </ul>
        )}
        <div className="tour-foot">
          {last ? (
            <>
              <button type="button" className="tour-skip" onClick={() => setI(i - 1)}>
                Back
              </button>
              <span className="tour-buttons">
                <button type="button" onClick={() => close()}>
                  Explore on my own
                </button>
                <button type="button" className="primary" onClick={() => close(true)}>
                  Start the story
                </button>
              </span>
            </>
          ) : (
            <>
              <button type="button" className="tour-skip" onClick={() => close()}>
                Skip tour
              </button>
              <span className="tour-buttons">
                {i > 0 && (
                  <button type="button" onClick={() => setI(i - 1)}>
                    Back
                  </button>
                )}
                <button type="button" className="primary" onClick={() => setI(i + 1)}>
                  Next
                </button>
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
