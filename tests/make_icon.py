"""生成应用图标（开发工具）：python tests/make_icon.py"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_ICO = ROOT / "icon.ico"
OUT_TOUCH = ROOT / "apple-touch-icon.png"
OUT_PREVIEW = ROOT / "icon-preview.png"

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 蓝色渐变背景（类似 iOS 图标）
bg = Image.new("RGBA", (S, S))
px = bg.load()
top = (90, 200, 250)
bottom = (0, 102, 204)
for y in range(S):
    t = y / (S - 1)
    color = (
        int(top[0] + (bottom[0] - top[0]) * t),
        int(top[1] + (bottom[1] - top[1]) * t),
        int(top[2] + (bottom[2] - top[2]) * t),
        255,
    )
    for x in range(S):
        px[x, y] = color

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
img.paste(bg, (0, 0), mask)

draw = ImageDraw.Draw(img, "RGBA")

margin = int(S * 0.16)
grid = S - 2 * margin
cell = grid / 3

# 三格轻微高亮
for row, col in [(0, 0), (1, 1), (2, 2)]:
    x0 = margin + col * cell
    y0 = margin + row * cell
    draw.rounded_rectangle(
        [x0 + 4, y0 + 4, x0 + cell - 4, y0 + cell - 4],
        radius=int(cell * 0.08),
        fill=(255, 255, 255, 34),
    )

# 细网格线
white = (255, 255, 255, 235)
thin_w = max(3, int(S * 0.012))
for i in range(1, 3):
    x = margin + i * cell
    draw.line([(x, margin), (x, margin + grid)], fill=white, width=thin_w)
    y = margin + i * cell
    draw.line([(margin, y), (margin + grid, y)], fill=white, width=thin_w)

# 外框
draw.rounded_rectangle(
    [margin, margin, margin + grid, margin + grid],
    radius=int(S * 0.055),
    outline=white,
    width=max(5, int(S * 0.022)),
)

img = img.resize((256, 256), Image.LANCZOS)
img.save(OUT_PREVIEW)
img.save(OUT_TOUCH)
img.save(
    OUT_ICO,
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("written:", OUT_ICO)
print("written:", OUT_TOUCH)
print("written:", OUT_PREVIEW)
