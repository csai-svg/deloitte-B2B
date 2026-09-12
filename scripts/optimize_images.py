#!/usr/bin/env python3
"""
Convert a local image (PNG/JPEG) to a WebP with a max width, for cutting the
byte weight of static assets shipped with the site — hero banners, logos,
anything committed under assets/ rather than pulled from the live catalogue.

Usage:
    python3 scripts/optimize_images.py <input> [<output>] [--quality N] [--max-width N]

    python3 scripts/optimize_images.py assets/brand/hero-deloitte.png
        -> writes assets/brand/hero-deloitte.webp (quality 80, max width 1600)

Leaves the original file untouched — this only ever writes the new .webp
alongside it (or wherever <output> points).
"""
import argparse
import sys
from pathlib import Path

from PIL import Image


def optimize(src: Path, dst: Path, quality: int = 80, max_width: int = 1600) -> Path:
    img = Image.open(src)
    img.load()  # fail loudly here rather than lazily during save

    if img.width > max_width:
        new_height = round(img.height * (max_width / img.width))
        img = img.resize((max_width, new_height), Image.LANCZOS)

    # WebP doesn't need an alpha channel preserved as RGBA if the source never
    # used transparency; keeping mode as-is is simplest and still correct.
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "WEBP", quality=quality, method=6)

    # Verify the file we just wrote is a real, openable image before calling
    # this a success — a truncated/corrupt write should fail the script.
    check = Image.open(dst)
    check.verify()

    return dst


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", type=Path)
    ap.add_argument("output", type=Path, nargs="?")
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--max-width", type=int, default=1600)
    args = ap.parse_args()

    if not args.input.exists():
        sys.exit(f"error: {args.input} does not exist")

    out = args.output or args.input.with_suffix(".webp")
    result = optimize(args.input, out, args.quality, args.max_width)

    before = args.input.stat().st_size
    after = result.stat().st_size
    print(f"{args.input} ({before/1024:.1f} KB) -> {result} ({after/1024:.1f} KB)")


if __name__ == "__main__":
    main()
