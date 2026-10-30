"""Draw the channel-banner platform icons shipped with the engine.

Writes engine/assets/icons/<platform>.png: white, 128 px square, transparent
background, drawn at 4x and downsampled so the edges stay smooth at the ~40 px
the banner uses. They are simplified original drawings that identify the
platform (a play button, an X, a note, a camera), not the platforms' own
artwork.

    engine/.venv/bin/python scripts/banner-icons.py
"""

import os

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 4
CANVAS = SIZE * SCALE
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "engine", "assets", "icons")


def canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGBA", (CANVAS, CANVAS), CLEAR)
    return image, ImageDraw.Draw(image)


def youtube() -> Image.Image:
    image, draw = canvas()
    w, h = 512, 360
    x0, y0 = (CANVAS - w) // 2, (CANVAS - h) // 2
    draw.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=96, fill=WHITE)
    cx, cy = CANVAS // 2 + 16, CANVAS // 2
    draw.polygon([(cx - 70, cy - 90), (cx - 70, cy + 90), (cx + 90, cy)], fill=CLEAR)
    return image


def x() -> Image.Image:
    image, draw = canvas()
    m = 64
    draw.line([(m, m), (CANVAS - m, CANVAS - m)], fill=WHITE, width=104)
    draw.line([(CANVAS - m, m), (m, CANVAS - m)], fill=WHITE, width=56)
    return image


def tiktok() -> Image.Image:
    image, draw = canvas()
    stroke = 72
    # Note head: a ring at the bottom left.
    cx, cy, r = 196, 372, 112
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=WHITE, width=stroke)
    # Stem up the right side of the head.
    sx = cx + r - stroke
    draw.rectangle([sx, 60, sx + stroke, cy], fill=WHITE)
    # Flag: a quarter arc from the top of the stem, sweeping right and down.
    fr, fcx, fcy = 150, sx + stroke // 2, 60 + stroke // 2 + 150
    draw.arc([fcx - fr, fcy - fr, fcx + fr, fcy + fr], start=270, end=360, fill=WHITE, width=stroke)
    return image


def instagram() -> Image.Image:
    image, draw = canvas()
    stroke = 48
    m = 40
    draw.rounded_rectangle([m, m, CANVAS - m, CANVAS - m], radius=128, outline=WHITE, width=stroke)
    c, r = CANVAS // 2, 104
    draw.ellipse([c - r, c - r, c + r, c + r], outline=WHITE, width=stroke)
    dx, dy, dr = CANVAS - 150, 150, 30
    draw.ellipse([dx - dr, dy - dr, dx + dr, dy + dr], fill=WHITE)
    return image


ICONS = {"youtube": youtube, "x": x, "tiktok": tiktok, "instagram": instagram}


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, draw_icon in ICONS.items():
        image = draw_icon().resize((SIZE, SIZE), Image.LANCZOS)
        path = os.path.join(OUT_DIR, f"{name}.png")
        image.save(path, "PNG", optimize=True)
        print(f"wrote {os.path.relpath(path)}")


if __name__ == "__main__":
    main()
