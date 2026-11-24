#!/usr/bin/env python3
"""生成扩展图标 media/icon.png（圆角深色底 + 三根增长柱 + 折线脉冲）。"""
import math
from PIL import Image, ImageDraw

SIZE = 256
SS = 4  # 超采样
W = SIZE * SS
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角背景（深青黑渐变，用逐行插值近似）
radius = 58 * SS
for y in range(W):
    t = y / (W - 1)
    r = int(10 + 8 * t)
    g = int(24 + 22 * t)
    b = int(28 + 26 * t)
    d.rectangle([0, y, W, y + 1], fill=(r, g, b, 255))

# 抠出圆角遮罩
mask = Image.new("L", (W, W), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, W - 1, W - 1], radius=radius, fill=255)
img.putalpha(mask)

d = ImageDraw.Draw(img)

# 三根柱（token 用量增长）
bar_w = 30 * SS
gap = 18 * SS
base_y = 190 * SS
heights = [64, 104, 150]
colors = [(79, 156, 249), (78, 201, 176), (180, 128, 215)]
total_w = bar_w * 3 + gap * 2
x0 = (W - total_w) // 2
for i, (h, c) in enumerate(zip(heights, colors)):
    x = x0 + i * (bar_w + gap)
    y = base_y - h * SS
    d.rounded_rectangle([x, y, x + bar_w, base_y], radius=10 * SS, fill=(*c, 255))

# 基线
d.rounded_rectangle([x0 - 14 * SS, base_y + 6 * SS, x0 + total_w + 14 * SS, base_y + 14 * SS],
                    radius=4 * SS, fill=(255, 255, 255, 40))

# 折线脉冲（从柱顶穿过）
pts = []
for i, h in enumerate(heights):
    x = x0 + i * (bar_w + gap) + bar_w // 2
    y = base_y - (h + 26) * SS
    pts.append((x, y))
# 添加中间点让折线更像脉冲
pulse = []
for i in range(len(pts) - 1):
    (x1, y1), (x2, y2) = pts[i], pts[i + 1]
    mx = (x1 + x2) // 2
    pulse.append((x1, y1))
    pulse.append((mx, min(y1, y2) - 22 * SS))
pulse.append(pts[-1])
d.line(pulse, fill=(120, 220, 255, 235), width=7 * SS, joint="curve")
# 折线端点
for (x, y) in [pts[0], pts[-1]]:
    d.ellipse([x - 9 * SS, y - 9 * SS, x + 9 * SS, y + 9 * SS], fill=(120, 220, 255, 255))

img = img.resize((SIZE, SIZE), Image.LANCZOS)
img.save("media/icon.png")
print("wrote media/icon.png", img.size)
