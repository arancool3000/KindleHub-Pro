#!/usr/bin/env python3
"""Generate the AranOS brand assets (wallpaper, logos, boot art).
Pure-Pillow, no network. Run: python3 gen_assets.py <outdir>
"""
import sys, math, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(OUT, exist_ok=True)

# --- palette (aurora) ---
TOP    = (12, 14, 33)     # deep night
BOTTOM = (5, 7, 18)       # near black
AUR1   = (46, 230, 200)   # teal
AUR2   = (95, 130, 255)   # blue
AUR3   = (170, 90, 255)   # violet
ACCENT = (64, 224, 208)   # turquoise accent

def font(sz, bold=True):
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

def vgrad(w, h, top, bot):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        # ease for a smoother sky
        t = t ** 1.15
        r = int(top[0] + (bot[0] - top[0]) * t)
        g = int(top[1] + (bot[1] - top[1]) * t)
        b = int(top[2] + (bot[2] - top[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img

def aurora_layer(w, h):
    """Soft, blurred diagonal aurora bands on a transparent layer."""
    layer = Image.new("RGB", (w, h), (0, 0, 0))
    d = ImageDraw.Draw(layer)
    bands = [
        (AUR3, 0.16, 230),
        (AUR2, 0.34, 260),
        (AUR1, 0.52, 220),
        (AUR2, 0.70, 180),
    ]
    for color, cy, amp in bands:
        pts_top, pts_bot = [], []
        base = h * cy
        for x in range(0, w + 1, 12):
            phase = x / w * math.pi * 2.2
            y = base + math.sin(phase) * amp * 0.5 + math.sin(phase * 0.5 + 1) * amp * 0.3
            pts_top.append((x, y - h * 0.06))
            pts_bot.append((x, y + h * 0.06))
        poly = pts_top + pts_bot[::-1]
        d.polygon(poly, fill=color)
    layer = layer.filter(ImageFilter.GaussianBlur(70))
    return layer

def screen_blend(base, glow, strength=0.55):
    b = base.load(); g = glow.load()
    w, h = base.size
    for y in range(h):
        for x in range(w):
            br, bg, bb = b[x, y]; gr, gg, gb = g[x, y]
            # screen blend, scaled
            r = 255 - (255 - br) * (255 - gr * strength) // 255
            gg2 = 255 - (255 - bg) * (255 - gg * strength) // 255
            bb2 = 255 - (255 - bb) * (255 - gb * strength) // 255
            b[x, y] = (int(r), int(gg2), int(bb2))
    return base

def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size[0]-1, size[1]-1], radius=radius, fill=255)
    return m

def make_logo(px):
    """Rounded gradient tile with a stylized 'A'. Returns RGBA."""
    S = px
    tile = Image.new("RGB", (S, S))
    p = tile.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            r = int(AUR1[0] + (AUR3[0]-AUR1[0]) * t)
            g = int(AUR1[1] + (AUR3[1]-AUR1[1]) * t)
            b = int(AUR1[2] + (AUR3[2]-AUR1[2]) * t)
            p[x, y] = (r, g, b)
    tile = tile.convert("RGBA")
    tile.putalpha(rounded_mask((S, S), int(S * 0.22)))
    d = ImageDraw.Draw(tile)
    # custom 'A' glyph (clean geometric)
    m = S * 0.20
    apex = (S/2, m)
    bl = (m, S - m); br = (S - m, S - m)
    lw = int(S * 0.07)
    d.line([apex, bl], fill=(255, 255, 255), width=lw)
    d.line([apex, br], fill=(255, 255, 255), width=lw)
    # crossbar
    cy = S * 0.64
    lx = apex[0] - (apex[0]-bl[0]) * ((cy-apex[1])/(bl[1]-apex[1]))
    rx = apex[0] + (br[0]-apex[0]) * ((cy-apex[1])/(br[1]-apex[1]))
    d.line([(lx, cy), (rx, cy)], fill=(255, 255, 255), width=int(lw*0.85))
    return tile

def text_center(d, cx, y, s, fnt, fill, anchor_mm=False):
    bb = d.textbbox((0, 0), s, font=fnt)
    w = bb[2]-bb[0]; h = bb[3]-bb[1]
    d.text((cx - w/2, y), s, font=fnt, fill=fill)
    return h

# ---------- WALLPAPER ----------
W, H = 1920, 1080
wall = vgrad(W, H, TOP, BOTTOM)
wall = screen_blend(wall, aurora_layer(W, H), 0.6)
# faint stars
import random
random.seed(7)
dd = ImageDraw.Draw(wall)
for _ in range(380):
    x = random.randint(0, W-1); y = random.randint(0, int(H*0.6))
    b = random.randint(60, 170)
    dd.ellipse([x, y, x+1, y+1], fill=(b, b, min(255, b+25)))
# centered logo + wordmark
logo = make_logo(190)
wall.paste(logo, (W//2 - 95, H//2 - 230), logo)
text_center(dd, W//2, H//2 - 10, "AranOS", font(120), (244, 247, 255))
text_center(dd, W//2, H//2 + 130, "Simple. Beautiful. Yours.", font(40, False), (150, 200, 235))
wall.save(os.path.join(OUT, "wallpaper.png"))
print("wallpaper.png")

# ---------- LOGOS ----------
base = make_logo(512)
for s in (512, 256, 128, 96, 64, 48, 32):
    base.resize((s, s), Image.LANCZOS).save(os.path.join(OUT, f"logo-{s}.png"))
base.save(os.path.join(OUT, "aranos-logo.png"))
print("logos")

# ---------- GRUB BACKGROUND ----------
grub = vgrad(W, H, (8, 10, 24), (3, 4, 12))
grub = screen_blend(grub, aurora_layer(W, H), 0.32)
gd = ImageDraw.Draw(grub)
gl = make_logo(120); grub.paste(gl, (90, 70), gl)
gd.text((230, 95), "AranOS", font=font(72), fill=(235, 240, 255))
gd.text((232, 168), "1.0  “Aurora”", font=font(30, False), fill=(140, 180, 220))
grub.save(os.path.join(OUT, "grub-bg.png"))
print("grub-bg.png")

# ---------- PLYMOUTH BACKGROUND ----------
ply = vgrad(W, H, (8, 10, 24), (3, 4, 12))
ply = screen_blend(ply, aurora_layer(W, H), 0.28)
ply.save(os.path.join(OUT, "plymouth-bg.png"))
make_logo(220).save(os.path.join(OUT, "plymouth-logo.png"))
print("plymouth art")
print("ALL ASSETS DONE ->", OUT)
