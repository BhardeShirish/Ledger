"""Generate the PWA icons from the app's own palette.

Kept as a script rather than committed binaries alone so the icons can be
regenerated if the brand colours change.
"""
from pathlib import Path

from PIL import Image, ImageDraw

PAPER = "#FAF7F2"
ACCENT = "#C2410C"
INK = "#1C1917"
RULE = "#D6CCC0"

OUT = Path(__file__).resolve().parent.parent / "web" / "public"
OUT.mkdir(parents=True, exist_ok=True)


def draw(size: int, maskable: bool = False) -> Image.Image:
    # Maskable icons get cropped to a circle by Android, so everything
    # important has to sit inside the middle 80%.
    img = Image.new("RGBA", (size, size), PAPER)
    d = ImageDraw.Draw(img)
    pad = size * 0.18 if maskable else size * 0.12
    if not maskable:
        d.rounded_rectangle([0, 0, size - 1, size - 1],
                            radius=int(size * 0.22), fill=PAPER)

    # A ledger page: ruled lines with one turmeric entry.
    top, bottom = pad, size - pad
    rows = 4
    gap = (bottom - top) / rows
    line_w = max(1, int(size * 0.035))
    for i in range(rows + 1):
        y = top + i * gap
        d.line([pad, y, size - pad, y], fill=RULE, width=line_w)

    # The vertical rule that makes it read as a ledger, not notepaper.
    x_rule = pad + (size - 2 * pad) * 0.62
    d.line([x_rule, top, x_rule, bottom], fill=RULE, width=line_w)

    # One filled entry in the accent colour: the "money in" line.
    y0 = top + gap * 1
    y1 = top + gap * 2
    d.rectangle([x_rule + line_w, y0 + line_w, size - pad, y1 - line_w],
                fill=ACCENT)

    # A short ink stroke standing for the entry's label.
    d.line([pad + gap * 0.25, (y0 + y1) / 2, x_rule - gap * 0.25,
            (y0 + y1) / 2], fill=INK, width=line_w)
    return img


for size in (192, 512):
    draw(size).save(OUT / f"icon-{size}.png")
    draw(size, maskable=True).save(OUT / f"icon-{size}-maskable.png")

draw(180).save(OUT / "apple-touch-icon.png")
draw(32).resize((32, 32), Image.LANCZOS).save(OUT / "favicon.png")

for p in sorted(OUT.glob("*.png")):
    print(f"  {p.name:28} {p.stat().st_size:>6} bytes")
