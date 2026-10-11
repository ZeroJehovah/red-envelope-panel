#!/usr/bin/env python3
"""生成扩展图标（16/32/48/128 PNG）。

图形沿用面板历史行「查看红包详情」按钮里的那颗红包字形（`src/panel.js` 的
`PACKET_ICON_PATHS`，与脚本版网站行内按钮同一组 path）：红包红 #c05c5c 单色填充、
透明底，等比放到画布里最大。字形本身是 793.6×1024 的竖长红包，上片的封口弧线把封口
圆环留成负空间，因此按高度铺到画布的 96%、横向居中。

先画一张 2048 的母版再降采样到各尺寸：字形里最细的负空间只有约 3.5% 的画布高度，
直接按目标尺寸画会让小尺寸下的圆环糊成一片。
用法：python3 tools/make-icons.py
"""

import os
import re

from PIL import Image, ImageDraw

RED = (192, 92, 92, 255)

SIZES = (16, 32, 48, 128)
# 图形高度占画布的比例，四周留一点边距，工具栏里不会顶到边（字形实际是 793.6×1024，
# 竖长，横向本来就有富余）。
FILL_RATIO = 0.96
MASTER = 2048
# 每条三次贝塞尔压成的折线段数；母版 2048 下足够抹平肉眼可见的棱角。
CURVE_STEPS = 48

PACKET_ICON_PATHS = (
    'M925.888 76.8v400.96c-57.088 73.408-134.08 130.56-222.848 163.328C681.536 570.112 615.616 518.4 537.6 518.4'
    'c-79.936 0-147.264 54.336-166.912 128.064-95.36-31.616-178.048-91.072-238.4-168.704V76.8c0-42.24 34.56-76.8 76.8-76.8'
    'h640c42.24 0 76.8 34.56 76.8 76.8z',
    'M925.888 554.56V947.2c0 42.24-34.56 76.8-76.8 76.8h-640c-42.24 0-76.8-34.56-76.8-76.8V554.56c59.712 76.8 141.248'
    ' 135.808 235.328 167.68C382.208 802.88 452.8 864 537.6 864c87.104 0 159.168-64.448 171.072-148.288'
    ' 86.464-33.024 161.344-89.344 217.216-161.152z',
    'M659.2 691.2c0 14.976-2.688 29.312-7.68 42.56C634.24 779.904 589.76 812.8 537.6 812.8c-50.496 0-93.824-30.784-112.192-74.688'
    '-6.08-14.4-9.408-30.272-9.408-46.912 0-10.752 1.408-21.184 4.032-31.104C433.792 608 481.216 569.6 537.6 569.6'
    'c55.04 0 101.504 36.544 116.48 86.72 3.328 11.072 5.12 22.784 5.12 34.88z',
)

OUT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons'))

# 这组 path 只用到直线、水平/垂直与三次贝塞尔的绝对/相对写法，够用就好。
TOKENS = re.compile(r'[MmLlHhVvCcSsZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')
ARG_COUNT = ('M', 'L', 'H', 'V', 'C', 'S', 'Z')


def _bezier(start, control1, control2, end):
    points = []
    for step in range(1, CURVE_STEPS + 1):
        t = step / CURVE_STEPS
        u = 1 - t
        points.append((
            u * u * u * start[0] + 3 * u * u * t * control1[0] + 3 * u * t * t * control2[0] + t * t * t * end[0],
            u * u * u * start[1] + 3 * u * u * t * control1[1] + 3 * u * t * t * control2[1] + t * t * t * end[1],
        ))
    return points


def flatten(path):
    """把一条 SVG path 压成折线点集（闭合轮廓，不带自交）。"""
    tokens = TOKENS.findall(path)
    points = []
    index = 0
    command = None
    start = current = (0.0, 0.0)
    last_control = None

    def number():
        nonlocal index
        value = float(tokens[index])
        index += 1
        return value

    while index < len(tokens):
        token = tokens[index]
        if token.upper() in ARG_COUNT:
            command = token
            index += 1
        elif command is None:
            raise ValueError('path 以数字开头: %r' % path[:24])

        kind = command.upper()
        # 命令后跟的成对数字是同一命令的重复参数，大小写沿用该命令自己。
        relative = command.islower()
        if kind == 'Z':
            points.append(start)
            current = start
            last_control = None
            command = None
            continue
        if kind == 'M':
            x, y = number(), number()
            current = (current[0] + x, current[1] + y) if relative else (x, y)
            start = current
            # moveto 之后跟着的成对数字按 lineto 处理。
            command = 'l' if relative else 'L'
            last_control = None
        elif kind == 'L':
            x, y = number(), number()
            current = (current[0] + x, current[1] + y) if relative else (x, y)
            last_control = None
        elif kind == 'H':
            x = number()
            current = (current[0] + x, current[1]) if relative else (x, current[1])
            last_control = None
        elif kind == 'V':
            y = number()
            current = (current[0], current[1] + y) if relative else (current[0], y)
            last_control = None
        elif kind == 'C':
            x1, y1, x2, y2, x, y = (number() for _ in range(6))
            control1 = (current[0] + x1, current[1] + y1) if relative else (x1, y1)
            control2 = (current[0] + x2, current[1] + y2) if relative else (x2, y2)
            end = (current[0] + x, current[1] + y) if relative else (x, y)
            points.extend(_bezier(current, control1, control2, end))
            current = end
            last_control = control2
        elif kind == 'S':
            x2, y2, x, y = (number() for _ in range(4))
            control1 = current if last_control is None else (
                2 * current[0] - last_control[0],
                2 * current[1] - last_control[1],
            )
            control2 = (current[0] + x2, current[1] + y2) if relative else (x2, y2)
            end = (current[0] + x, current[1] + y) if relative else (x, y)
            points.extend(_bezier(current, control1, control2, end))
            current = end
            last_control = control2
        else:
            raise ValueError('path 里出现未支持的命令: %s' % command)

        points.append(current)
    return points


def render_mask(px):
    """按目标像素边长画一张灰度遮罩：字形等比铺满高度、横向居中。"""
    shapes = [flatten(path) for path in PACKET_ICON_PATHS]
    xs = [point[0] for points in shapes for point in points]
    ys = [point[1] for points in shapes for point in points]
    # 图形铺满高度、横向居中；边界直接取自折线，换字形时不必再手工核对数字。
    origin_x, origin_y = min(xs), min(ys)
    width, height = max(xs) - origin_x, max(ys) - origin_y
    scale = px * FILL_RATIO / height
    left = (px - width * scale) / 2
    top = (px - height * scale) / 2
    canvas = Image.new('L', (px, px), 0)
    draw = ImageDraw.Draw(canvas)

    def place(point):
        return (left + (point[0] - origin_x) * scale, top + (point[1] - origin_y) * scale)

    for points in shapes:
        # 三片是同一个颜色，逐片填即可，重叠处不必额外做并集。
        draw.polygon([place(point) for point in points], fill=255)
    return canvas


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    master = render_mask(MASTER)
    for size in SIZES:
        icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        icon.putalpha(master.resize((size, size), Image.LANCZOS))
        icon.paste(RED, (0, 0), icon)
        path = os.path.join(OUT_DIR, 'icon%d.png' % size)
        icon.save(path, optimize=True)
        print('wrote %s' % path)


if __name__ == '__main__':
    main()
