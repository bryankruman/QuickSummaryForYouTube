#!/usr/bin/env python3
"""Generate the extension's Gemini-style "sparkle" icons as PNGs.

Pure standard library (no Pillow/ImageMagick): we rasterize a four-pointed
sparkle (the Gemini/AI "spark" shape) with a blue->purple->pink diagonal
gradient, anti-alias it via supersampling + box downscale, and hand-roll the
PNG with zlib. Re-run to regenerate icons/icon{16,32,48,128}.png.
"""

import os
import struct
import zlib

# --- Geometry --------------------------------------------------------------
# A four-pointed sparkle built from 4 cubic Beziers whose control points sit
# on the axes near the centre, pinching each edge inward (the concave look).
A = 0.5  # control-point pull toward centre: bigger = pointier/slimmer star


def _cubic(p0, c1, c2, p3, n):
    pts = []
    for i in range(n):
        t = i / n
        u = 1 - t
        x = (u * u * u * p0[0] + 3 * u * u * t * c1[0]
             + 3 * u * t * t * c2[0] + t * t * t * p3[0])
        y = (u * u * u * p0[1] + 3 * u * u * t * c1[1]
             + 3 * u * t * t * c2[1] + t * t * t * p3[1])
        pts.append((x, y))
    return pts


def sparkle(cx, cy, r, n=28):
    """Return polygon vertices for a sparkle centred at (cx,cy) with radius r."""
    top, right, bottom, left = (0, -1), (1, 0), (0, 1), (-1, 0)
    segs = [
        _cubic(top, (0, -A), (-A, 0), left, n),
        _cubic(left, (-A, 0), (0, A), bottom, n),
        _cubic(bottom, (0, A), (A, 0), right, n),
        _cubic(right, (A, 0), (0, -A), top, n),
    ]
    return [(cx + x * r, cy + y * r) for seg in segs for (x, y) in seg]


def fill_polygon(mask, w, h, poly):
    """Even-odd scanline fill of poly into mask (bytearray of w*h), value 1."""
    edges = list(zip(poly, poly[1:] + poly[:1]))
    for y in range(h):
        yc = y + 0.5
        xs = []
        for (x1, y1), (x2, y2) in edges:
            if (y1 <= yc < y2) or (y2 <= yc < y1):
                xs.append(x1 + (yc - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        for k in range(0, len(xs) - 1, 2):
            xa = max(0, int(xs[k] + 0.5))
            xb = min(w, int(xs[k + 1] + 0.5))
            row = y * w
            for x in range(xa, xb):
                mask[row + x] = 1


# --- Gradient --------------------------------------------------------------
STOPS = [
    (0.00, (40, 130, 248)),   # blue
    (0.50, (126, 92, 222)),   # purple
    (1.00, (226, 98, 150)),   # pink
]


def grad(t):
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t <= t1:
            f = 0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(int(round(c0[j] + (c1[j] - c0[j]) * f)) for j in range(3))
    return STOPS[-1][1]


# --- PNG encoding ----------------------------------------------------------
def write_png(path, n, rgba):
    raw = bytearray()
    for y in range(n):
        raw.append(0)  # filter: none
        raw.extend(rgba[y * n * 4:(y + 1) * n * 4])
    comp = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", comp))
        f.write(chunk(b"IEND", b""))


def render(n, ss=4):
    """Render an n*n RGBA sparkle icon (supersampled by ss, box-downscaled)."""
    hr = n * ss
    mask = bytearray(hr * hr)
    # Main sparkle, optically centred; plus a small companion spark (top-right).
    fill_polygon(mask, hr, hr, sparkle(hr * 0.47, hr * 0.53, hr * 0.45))
    fill_polygon(mask, hr, hr, sparkle(hr * 0.83, hr * 0.19, hr * 0.16))

    out = bytearray(n * n * 4)
    area = ss * ss
    for y in range(n):
        for x in range(n):
            cov = 0
            for dy in range(ss):
                base = (y * ss + dy) * hr + x * ss
                for dx in range(ss):
                    cov += mask[base + dx]
            alpha = cov * 255 // area
            t = (x + y) / (2 * (n - 1)) if n > 1 else 0
            r, g, b = grad(t)
            o = (y * n + x) * 4
            out[o] = r
            out[o + 1] = g
            out[o + 2] = b
            out[o + 3] = alpha
    return out


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(here, "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(os.path.join(out_dir, f"icon{size}.png"), size, render(size))
        print("wrote", f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
