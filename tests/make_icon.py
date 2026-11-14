"""生成桌面快捷方式用的图标（开发工具）：python tests/make_icon.py"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_ICO = ROOT / "icon.ico"
OUT_PNG = ROOT / "icon-256.png"

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 竖向渐变背景
bg = Image.new("RGBA", (S, S))
px = bg.load()
for y in range(S):
    t = y / (S - 1)
    r = int(18 + (7 - 18) * t)
    g = int(31 + (11 - 31) * t)
    b = int(54 + (20 - 54) * t)
    for x in range(S):
        px[x, y] = (r, g, b, 255)

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
img.paste(bg, (0, 0), mask)

draw = ImageDraw.Draw(img, "RGBA")

margin = int(S * 0.15)
grid = S - 2 * margin
cell = grid / 3

# 三个高亮格，颜色呼应游戏界面
highlights = [
    (0, 0, (34, 211, 238, 70)),
    (1, 1, (129, 140, 248, 64)),
    (2, 2, (251, 191, 36, 58)),
]
for row, col, color in highlights:
    x0 = margin + col * cell
    y0 = margin + row * cell
    draw.rounded_rectangle(
        [x0 + 4, y0 + 4, x0 + cell - 4, y0 + cell - 4],
        radius=int(cell * 0.1),
        fill=color,
    )

# 细网格线
thin = (148, 163, 184, 135)
thin_w = max(2, int(S * 0.009))
for i in range(1, 3):
    x = margin + i * cell
    draw.line([(x, margin), (x, margin + grid)], fill=thin, width=thin_w)
    y = margin + i * cell
    draw.line([(margin, y), (margin + grid, y)], fill=thin, width=thin_w)

# 青色外框
draw.rounded_rectangle(
    [margin, margin, margin + grid, margin + grid],
    radius=int(S * 0.06),
    outline=(103, 232, 249, 255),
    width=max(4, int(S * 0.02)),
)

img = img.resize((256, 256), Image.LANCZOS)
img.save(OUT_PNG)
img.save(
    OUT_ICO,
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("written:", OUT_ICO)
print("written:", OUT_PNG)
