"""Draws the README architecture diagram in light and dark versions.

Run from the repo root: python3 docs/images/architecture.py docs/images
"""
import sys
from xml.sax.saxutils import escape as e
out = sys.argv[1]
THEMES = {
 "light": dict(text="#1f2328", muted="#59636e", line="#d1d9e0", group="#f6f8fa", box="#ffffff", hl="#0969da", hlfill="#ddf4ff", arrow="#818b98"),
 "dark":  dict(text="#f0f6fc", muted="#9198a1", line="#3d444d", group="#151b23", box="#0d1117", hl="#4493f8", hlfill="#0d2a4d", arrow="#9198a1"),
}
W = 1240; X0, X1 = 40, 1160
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"
def svg(t):
    c = THEMES[t]; o = []
    def rect(x, y, w, h, fill, stroke, sw=1.5, r=12):
        o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
    def text(x, y, s, size, color, weight=400, anchor="middle"):
        o.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{color}" text-anchor="{anchor}">{e(s)}</text>')
    def box(x, y, w, h, title, subs=(), hl=False, tsize=20):
        rect(x, y, w, h, c["hlfill"] if hl else c["box"], c["hl"] if hl else c["line"], 2.5 if hl else 1.5)
        lines = 1 + len(subs); top = y + h/2 - (lines-1)*13 + 7
        text(x+w/2, top, title, tsize, c["text"], 600)
        for i, s in enumerate(subs): text(x+w/2, top + 28*(i+1) - 2, s, 16, c["muted"])
    def arrow(x, y1, y2):
        o.append(f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2-7}" stroke="{c["arrow"]}" stroke-width="1.5"/>')
        o.append(f'<path d="M{x-5},{y2-9} L{x},{y2} L{x+5},{y2-9} Z" fill="{c["arrow"]}"/>')
    def group(y, h, label, items, bh, tsize):
        rect(X0, y, X1-X0, h, c["group"], c["line"])
        text(X0+24, y+34, label, 19, c["text"], 600, "start")
        n = len(items); gap = 20; inner = X1-X0-48; bw = (inner-gap*(n-1))/n
        for i, it in enumerate(items):
            box(X0+24+i*(bw+gap), y+54, bw, bh, it[0], it[1:], tsize=tsize)
    mid = (X0+X1)/2
    text(X0, 40, "Vendor outputs become one record set that agents act on", 22, c["text"], 600, "start")
    group(70, 158, "Store-intelligence sources (simulated in the demo)",
          [("Shelf vendors", "Simbe, Focal, VusionGroup"), ("Loss prevention", "Everseen and others"),
           ("Metropolis apps", "Store Pulse, VSS"), ("Retailer systems", "Planogram, POS, ESL")], 80, 19)
    arrow(mid, 228, 266)
    box(X0, 266, X1-X0, 80, "Adapters and validator", ["Map each vendor export to the OISS JSON Schemas"])
    arrow(mid, 346, 384)
    box(X0, 384, X1-X0, 108, "OISS record stream",
        ["CloudEvents over MQTT or HTTP, GS1 identifiers, one store layout",
         "StoreLayout, ShelfObservation, ZoneMetric, ShopperPath, Incident, Evidence, Task"], hl=True)
    half = (X1-X0-20)/2
    l, r = X0+half/2, X1-half/2
    arrow(l, 492, 530); arrow(r, 492, 530)
    box(X0, 530, half, 80, "OISS store", ["DuckDB for current state, Parquet for history"])
    box(X1-half, 530, half, 80, "Evidence store", ["Clips and images with retention and access roles"])
    arrow(l, 610, 648); arrow(r, 610, 648)
    box(X0, 648, X1-X0, 80, "Query API and MCP server", ["Out-of-stocks, zone status, open incidents, create task"])
    arrow(mid, 728, 766)
    group(766, 134, "Store Operations Assistant routes each question to an agent",
          [("Availability",), ("Price and label",), ("Front end",), ("Loss prevention",), ("Store insights",)], 56, 18)
    arrow(mid, 900, 938)
    box(X0, 938, X1-X0, 80, "Actions in the store", ["Tasks to associates, shelf tag price fixes, lane openings, alerts with evidence"])
    # Feedback loop: tasks are written back as records and close on the next shelf check.
    lx = 1196
    o.append(f'<path d="M{X1},978 H{lx} V438 H{X1+9}" fill="none" stroke="{c["hl"]}" stroke-width="1.5" stroke-dasharray="6 5"/>')
    o.append(f'<path d="M{X1+9},433 L{X1},438 L{X1+9},443 Z" fill="{c["hl"]}"/>')
    o.append(f'<text x="{lx+20}" y="708" font-size="15" fill="{c["muted"]}" text-anchor="middle" transform="rotate(90 {lx+20} 708)">Task records, closed by the next shelf check</text>')
    H = 1040
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}" role="img" aria-label="OISS architecture: vendor outputs become one record set that agents act on">\n'
            + "\n".join(o) + "\n</svg>\n")
for t in THEMES:
    open(f"{out}/architecture-{t}.svg", "w").write(svg(t))
