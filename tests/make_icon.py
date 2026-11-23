"""生成应用图标（开发工具）：python tests/make_icon.py

输出：
  icon.ico                       Windows 桌面快捷方式图标（圆角、透明背景）
  apple-touch-icon.png           iOS「添加到主屏幕」图标（180×180，不透明）
  icon-192.png                   PWA 图标
  icon-512.png                   PWA 图标（purpose "any"）
  icon-maskable-512.png          PWA 图标（purpose "maskable"）

maskable 图标采用 full-bleed 渐变背景，白色图案整体收进中心安全圆内：
Android 会按直径 80%（512×512 画布上半径 204.8px）的圆裁剪图标。
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024

TOP = (90, 200, 250)
BOTTOM = (0, 102, 204)
WHITE = (255, 255, 255, 235)

# maskable：在 1024 画布上留白，输出 512×512 时图案外接框半宽为 (512 - 2×116.2)/2 ≈ 139.8px，
# 外接框对角半径 sqrt(2) × 139.8 ≈ 197.7px（LANCZOS 缩放振铃后实测约 201.5px），
# 图案像素到中心的最大距离实测约 194.5px，均小于安全圆半径 204.8px（这里按 204 校验），
# 保证任何裁剪形状（圆形、圆角方形等）下图案都完整。
MASKABLE_MARGIN_FRACTION = 0.227


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


def draw_artwork(img, margin_fraction, opaque=False):
    """在背景图上绘制白色数独网格图案（icon-512.png 即此画法）。

    opaque=True 时图案全部使用不透明白色（用于 maskable：整张图不能有透明像素）。
    """
    draw = ImageDraw.Draw(img, "RGBA")
    margin = int(S * margin_fraction)
    grid = S - 2 * margin
    cell = grid / 3
    highlight = (255, 255, 255, 255) if opaque else (255, 255, 255, 34)
    line_color = (255, 255, 255, 255) if opaque else WHITE

    # 三个对角格高亮（icon-512.png 在浅色背景上即显示为白色格）
    for row, col in [(0, 0), (1, 1), (2, 2)]:
        x0 = margin + col * cell
        y0 = margin + row * cell
        draw.rounded_rectangle(
            [x0 + 4, y0 + 4, x0 + cell - 4, y0 + cell - 4],
            radius=int(cell * 0.08),
            fill=highlight,
        )

    # 内部细网格线
    thin_w = max(3, int(S * 0.012))
    for i in range(1, 3):
        x = margin + i * cell
        draw.line([(x, margin), (x, margin + grid)], fill=line_color, width=thin_w)
        y = margin + i * cell
        draw.line([(margin, y), (margin + grid, y)], fill=line_color, width=thin_w)

    # 外框
    draw.rounded_rectangle(
        [margin, margin, margin + grid, margin + grid],
        radius=int(S * 0.055),
        outline=line_color,
        width=max(5, int(S * 0.022)),
    )
    return img


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
    return draw_artwork(img, margin_fraction)


def draw_maskable_icon():
    """full-bleed 渐变背景（无圆角裁切、无透明像素），图案整体位于中心安全圆内。"""
    bg = gradient_background().convert("RGB")
    return draw_artwork(bg, MASKABLE_MARGIN_FRACTION, opaque=True).convert("RGBA")


def verify_maskable_icon(path=None, safe_radius=204.0, threshold=8):
    """用 PIL 校验 maskable 图标：背景 full-bleed 不透明，且所有白色图案像素位于安全圆内。

    「白色图案像素」= 与 full-bleed 渐变背景差异超过 threshold 的像素。
    返回 (bbox, max_radius, art_pixel_count)；校验失败抛出 AssertionError。
    """
    icon_path = Path(path) if path else ROOT / "icon-maskable-512.png"
    image = Image.open(icon_path).convert("RGBA")
    assert image.size == (512, 512), "maskable icon must be 512x512, got %r" % (image.size,)
    alpha = image.getchannel("A")
    assert alpha.getextrema() == (255, 255), "maskable icon must be fully opaque (full-bleed), got alpha=%r" % (
        alpha.getextrema(),
    )

    width, height = image.size
    center = (width - 1) / 2
    # 与生成时完全相同的 full-bleed 渐变，用作「背景」参考
    expected = gradient_background().resize(image.size, Image.LANCZOS).convert("RGB")
    pixels = image.convert("RGB").load()
    background = expected.load()

    artwork = []
    for y in range(height):
        for x in range(width):
            diff = sum(abs(pixels[x, y][channel] - background[x, y][channel]) for channel in range(3))
            if diff > threshold:
                artwork.append((x, y))
    assert artwork, "no white artwork pixels found"

    xs = [point[0] for point in artwork]
    ys = [point[1] for point in artwork]
    bbox = (min(xs), min(ys), max(xs), max(ys))
    max_radius = max(((x - center) ** 2 + (y - center) ** 2) ** 0.5 for x, y in artwork)
    outside = [point for point in artwork if ((point[0] - center) ** 2 + (point[1] - center) ** 2) ** 0.5 > safe_radius]
    assert not outside, "artwork outside maskable safe circle: %d pixels, max radius %.2fpx > %.0fpx" % (
        len(outside),
        max_radius,
        safe_radius,
    )
    return bbox, max_radius, len(artwork)


def report_maskable_verification():
    bbox, max_radius, count = verify_maskable_icon()
    print(
        "maskable safe-zone check passed: bbox=%s, max_radius=%.2fpx (limit 204), artwork_pixels=%d"
        % (bbox, max_radius, count)
    )


def main():
    rounded_icon = draw_icon(True, 0.16).resize((256, 256), Image.LANCZOS)
    rounded_icon.save(ROOT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    square_icon = draw_icon(False, 0.18)
    square_icon.resize((180, 180), Image.LANCZOS).save(ROOT / "apple-touch-icon.png")
    square_icon.resize((192, 192), Image.LANCZOS).save(ROOT / "icon-192.png")
    square_icon.resize((512, 512), Image.LANCZOS).save(ROOT / "icon-512.png")

    draw_maskable_icon().resize((512, 512), Image.LANCZOS).save(ROOT / "icon-maskable-512.png")

    for name in ["icon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]:
        print("written:", ROOT / name)
    report_maskable_verification()


if __name__ == "__main__":
    import sys

    if "--verify-only" in sys.argv:
        report_maskable_verification()
    else:
        main()
