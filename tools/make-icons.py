#!/usr/bin/env python3
"""生成扩展图标（16/32/48/128 PNG）。

配色遵循 docs/AGENTS.md：红包红 #c05c5c、封口金 #c98f4b、暖燕麦底 #f3efe8。
图形为「红包封口」：红色圆角方片、暖色 V 形封口线与金色封口圆点。
用法：python3 tools/make-icons.py
"""

import os

from PIL import Image, ImageChops, ImageDraw

RED = (192, 92, 92, 255)
GOLD = (201, 143, 75, 255)
CREAM = (243, 239, 232, 255)

SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 8
OUT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons'))


def draw_icon(size):
    scale = size * SUPERSAMPLE
    canvas = Image.new('RGBA', (scale, scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    radius = scale * 0.24
    draw.rounded_rectangle((0, 0, scale - 1, scale - 1), radius=radius, fill=RED)

    # 封口折线：从上方两角收拢到中心，随后用圆角矩形蒙版裁掉溢出边角。
    joint_y = scale * 0.42
    draw.line(
        [(0, scale * 0.06), (scale / 2, joint_y), (scale, scale * 0.06)],
        fill=CREAM,
        width=max(1, round(scale * 0.075)),
        joint='curve',
    )

    # 金色封口圆点压在折线交点上，小尺寸下也能读出「红包」形状。
    seal = scale * 0.13
    draw.ellipse(
        (scale / 2 - seal, joint_y - seal, scale / 2 + seal, joint_y + seal),
        fill=GOLD,
    )

    mask = Image.new('L', (scale, scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, scale - 1, scale - 1), radius=radius, fill=255)
    canvas.putalpha(ImageChops.multiply(canvas.getchannel('A'), mask))
    return canvas.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, 'icon%d.png' % size)
        draw_icon(size).save(path, optimize=True)
        print('wrote %s' % path)


if __name__ == '__main__':
    main()
