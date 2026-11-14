"""生成应用图标（开发工具）：python tests/make_icon.py

输出：
  icon.ico             Windows 桌面快捷方式图标（圆角、透明背景）
  apple-touch-icon.png iOS「添加到主屏幕」图标（180×180，不透明）
  icon-192.png         PWA 图标
  icon-512.png         PWA 图标（同时用于 maskable）
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024

TOP = (90, 200, 250)
BOTTOM = (0, 102, 204)
WHITE = (255, 255, 255, 235)


def gradient_background():
    bg = Image.new("RGBA", (S, S))
    px = bg.load()
    for y in range(S):
        t = y / (S - 1)
        color = (
            int(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
            int(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
            int(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
            255,
        )
        for x in range(S):
            px[x, y] = color
    return bg


def draw_icon(rounded, margin_fraction):
    """rounded=True 用于 .ico；rounded=False 用于 PWA / iOS 图标（不透明方形）。"""
    bg = gradient_background()
    if rounded:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
        img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        img.paste(bg, (0, 0), mask)
    else:
        img = bg.copy()

    draw = ImageDraw.Draw(img, "RGBA")
    margin = int(S * margin_fraction)
    grid = S - 2 * margin
    cell = grid / 3

    # 三个对角格轻微高亮
    for row, col in [(0, 0), (1, 1), (2, 2)]:
        x0 = margin + col * cell
        y0 = margin + row * cell
        draw.rounded_rectangle(
            [x0 + 4, y0 + 4, x0 + cell - 4, y0 + cell - 4],
            radius=int(cell * 0.08),
            fill=(255, 255, 255, 34),
        )

    # 内部细网格线
    thin_w = max(3, int(S * 0.012))
    for i in range(1, 3):
        x = margin + i * cell
        draw.line([(x, margin), (x, margin + grid)], fill=WHITE, width=thin_w)
        y = margin + i * cell
        draw.line([(margin, y), (margin + grid, y)], fill=WHITE, width=thin_w)

    # 外框
    draw.rounded_rectangle(
        [margin, margin, margin + grid, margin + grid],
        radius=int(S * 0.055),
        outline=WHITE,
        width=max(5, int(S * 0.022)),
    )
    return img


rounded_icon = draw_icon(True, 0.16).resize((256, 256), Image.LANCZOS)
rounded_icon.save(ROOT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

square_icon = draw_icon(False, 0.18)
square_icon.resize((180, 180), Image.LANCZOS).save(ROOT / "apple-touch-icon.png")
square_icon.resize((192, 192), Image.LANCZOS).save(ROOT / "icon-192.png")
square_icon.resize((512, 512), Image.LANCZOS).save(ROOT / "icon-512.png")

for name in ["icon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]:
    print("written:", ROOT / name)
