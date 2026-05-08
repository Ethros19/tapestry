"""Generate Tapestry's app icon as a 1024×1024 PNG.

Cassette tape head-on against a warm dark deck-chassis backdrop. Drawn
purely with Pillow primitives so the build pipeline doesn't need an SVG
renderer (rsvg, cairosvg, etc.).

Usage:
    python scripts/build-icon.py [out-path]

Default output: dist/icon-master.png
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


SIZE = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(w: int, h: int, top: tuple[int, int, int], bot: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        c = lerp(top, bot, y / max(1, h - 1))
        for x in range(w):
            px[x, y] = c
    return img


def draw_icon(out_path: Path) -> None:
    s = SIZE
    # Backdrop: rounded square, warm chassis tone with a subtle vertical
    # gradient from a sunset amber down to walnut.
    base = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg = vgrad(s, s, (60, 40, 22), (24, 16, 8)).convert("RGBA")
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s, s), radius=int(s * 0.22), fill=255)
    base.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(base)

    # Brushed metal sheen — diagonal highlight band.
    sheen = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    sd.polygon(
        [(0, int(s * 0.10)), (s, int(s * 0.0)), (s, int(s * 0.32)), (0, int(s * 0.42))],
        fill=(255, 220, 170, 22),
    )
    sheen = sheen.filter(ImageFilter.GaussianBlur(radius=22))
    base.alpha_composite(sheen)

    # Cassette body geometry — slightly shorter than the canvas so the
    # rounded backdrop frames it.
    cw, ch = int(s * 0.78), int(s * 0.50)
    cx, cy = (s - cw) // 2, int(s * 0.26)
    cassette = (cx, cy, cx + cw, cy + ch)

    # Cassette shell drop shadow.
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        (cx + 8, cy + 18, cx + cw + 8, cy + ch + 26),
        radius=int(s * 0.022), fill=(0, 0, 0, 180),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14))
    base.alpha_composite(shadow)

    # Cassette shell — three horizontal bands: cream label, amber stripe, cream.
    shell_radius = int(s * 0.022)
    d.rounded_rectangle(cassette, radius=shell_radius, fill=(228, 210, 170, 255), outline=(20, 12, 4, 255), width=4)

    # Top cream label region with a faint baseline.
    top_band = (cx, cy, cx + cw, cy + int(ch * 0.30))
    d.rectangle(top_band, fill=(232, 218, 178))
    d.line((top_band[0] + 30, top_band[3] - 6, top_band[2] - 30, top_band[3] - 6), fill=(80, 55, 30, 110), width=2)

    # Middle amber band — the cassette's signature stripe.
    band_y0 = cy + int(ch * 0.30)
    band_y1 = cy + int(ch * 0.70)
    band_grad = vgrad(cw, band_y1 - band_y0, (224, 136, 58), (181, 98, 24)).convert("RGBA")
    base.paste(band_grad, (cx, band_y0))
    d.line((cx, band_y0, cx + cw, band_y0), fill=(60, 30, 8, 200), width=2)
    d.line((cx, band_y1, cx + cw, band_y1), fill=(60, 30, 8, 200), width=2)

    # Side letter "A" tucked into the band.
    try:
        from PIL import ImageFont
        for candidate in [
            "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
            "/System/Library/Fonts/Supplemental/Georgia Italic.ttf",
            "/Library/Fonts/Georgia Italic.ttf",
        ]:
            if Path(candidate).exists():
                font = ImageFont.truetype(candidate, int(ch * 0.38))
                d.text((cx + int(cw * 0.04), band_y0 + int((band_y1 - band_y0) * 0.18)),
                       "A", font=font, fill=(255, 245, 224))
                break
    except Exception:
        pass

    # Window cutout in the band — recessed dark area where the reels sit.
    win_w, win_h = int(cw * 0.55), int(ch * 0.34)
    win_x = cx + (cw - win_w) // 2 + int(cw * 0.06)
    win_y = band_y0 + (band_y1 - band_y0 - win_h) // 2
    win_box = (win_x, win_y, win_x + win_w, win_y + win_h)
    d.rounded_rectangle(win_box, radius=10, fill=(20, 14, 6, 255), outline=(6, 4, 2, 255), width=3)

    # Tape strip running between the two reels.
    tape_y = win_y + win_h // 2 - 4
    d.rectangle((win_x + 16, tape_y, win_x + win_w - 16, tape_y + 8), fill=(40, 24, 12, 255))

    # Reels — two hubs, slightly larger than the window so the top and bottom
    # arcs get clipped by the window's edges (real cassette behavior).
    hub_r = int(win_h * 0.62)
    reel_centers = [
        (win_x + int(win_w * 0.27), win_y + win_h // 2),
        (win_x + int(win_w * 0.73), win_y + win_h // 2),
    ]
    # Clip subsequent reel drawing to the window so the hubs get cropped.
    win_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(win_mask).rounded_rectangle(win_box, radius=10, fill=255)
    reels_layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    rd = ImageDraw.Draw(reels_layer)
    for (rx, ry) in reel_centers:
        # Reel rim (dark) → cream hub face → tooth ring.
        rd.ellipse((rx - hub_r, ry - hub_r, rx + hub_r, ry + hub_r), fill=(235, 220, 180, 255), outline=(40, 26, 12, 255), width=4)
        # Spoke teeth as 6 small wedges around a central bore.
        bore = int(hub_r * 0.22)
        rd.ellipse((rx - bore, ry - bore, rx + bore, ry + bore), fill=(20, 14, 6, 255))
        for k in range(6):
            ang = math.radians(30 + k * 60)
            tx = rx + int(math.cos(ang) * hub_r * 0.62)
            ty = ry + int(math.sin(ang) * hub_r * 0.62)
            rd.ellipse((tx - 14, ty - 14, tx + 14, ty + 14), fill=(20, 14, 6, 255))
    base.alpha_composite(Image.composite(reels_layer, Image.new("RGBA", (s, s), (0, 0, 0, 0)), win_mask))

    # Bottom cream branding strip with a TYPE-I rule line.
    bot_band = (cx, cy + int(ch * 0.70), cx + cw, cy + ch)
    d.rectangle(bot_band, fill=(216, 198, 150))
    d.line((bot_band[0] + 30, bot_band[1] + 6, bot_band[2] - 30, bot_band[1] + 6), fill=(80, 55, 30, 90), width=2)

    # Two screws at the top corners of the cassette (visual flourish).
    for sx in (cx + 18, cx + cw - 18):
        sy = cy + 18
        d.ellipse((sx - 8, sy - 8, sx + 8, sy + 8), fill=(180, 160, 120, 255), outline=(40, 26, 12, 255))
        d.line((sx - 4, sy, sx + 4, sy), fill=(40, 26, 12, 255), width=2)

    # Bolt-style highlights at the chassis corners (echo the deck UI).
    for (px, py) in [
        (int(s * 0.07), int(s * 0.07)),
        (int(s * 0.93), int(s * 0.07)),
        (int(s * 0.07), int(s * 0.93)),
        (int(s * 0.93), int(s * 0.93)),
    ]:
        d.ellipse((px - 12, py - 12, px + 12, py + 12), fill=(70, 50, 28, 255), outline=(15, 9, 3, 255))

    # Inner chassis edge highlight.
    d.rounded_rectangle((6, 6, s - 6, s - 6), radius=int(s * 0.21), outline=(255, 220, 170, 50), width=2)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    base.save(out_path, "PNG")


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("dist/icon-master.png")
    draw_icon(out)
    print(f"✓ wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
