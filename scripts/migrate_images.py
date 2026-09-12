#!/usr/bin/env python3
"""
Migrate product photos off Google Drive onto a static host (the
csai-svg/b2b-assets repo, published via GitHub Pages), so both the Optum
and Deloitte storefronts can reference one canonical, CDN-cached URL
instead of lh3.googleusercontent.com (no cache headers, occasional
403s/rate-limits at this volume).

Reads the catalogue (defaults to assets/products.json — the same data the
live feed serves; pass --source <url> to pull straight from
?fn=catalog&brand=... instead), downloads each product's current Drive
image, re-encodes it to WebP, and writes it into a local working copy of
the target repo as img/<SKU>.webp. Also writes manifest.json
({sku: canonical_url}) at the repo root, which is what lets the master
sheet's Image URL column get updated in bulk afterwards (see
apps-script-feed/Code.gs's migrateImageUrls()) instead of by hand.

This script does NOT touch the master sheet, the Apps Script feed, or the
publish pipeline, and does not run git for you — commit/push the output
directory yourself once you're happy with the results.

Usage:
    python3 scripts/migrate_images.py --out ../b2b-assets
    python3 scripts/migrate_images.py --out ../b2b-assets --limit 5   # dry run on a handful
    python3 scripts/migrate_images.py --out ../b2b-assets --skus CS0082,CS0087

Requires Pillow + requests (pip install Pillow requests).
"""
import argparse
import hashlib
import json
import os
import sys
import time

import requests
from PIL import Image
from io import BytesIO

DEFAULT_BASE_URL = 'https://csai-svg.github.io/B2B-assets'
DEFAULT_SOURCE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'assets/products.json')

MAX_WIDTH = 1000
QUALITY = 80
STATE_FILE = '.migrate_state.json'   # lives in --out, tracks source hash per SKU


def load_products(source):
    if source.startswith('http'):
        r = requests.get(source, timeout=20)
        r.raise_for_status()
        data = r.json()
    else:
        with open(source, encoding='utf-8') as f:
            data = json.load(f)
    return data['products']


def load_state(out_dir):
    p = os.path.join(out_dir, STATE_FILE)
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return {}


def save_state(out_dir, state):
    with open(os.path.join(out_dir, STATE_FILE), 'w', encoding='utf-8') as f:
        json.dump(state, f, indent=1, sort_keys=True)


def url_hash(url):
    return hashlib.sha256(url.encode('utf-8')).hexdigest()[:16]


def migrate(products, out_dir, base_url, force=False):
    img_dir = os.path.join(out_dir, 'img')
    os.makedirs(img_dir, exist_ok=True)
    state = load_state(out_dir)

    manifest = {}
    done, skipped, failed, missing = [], [], [], []

    for p in products:
        sku, url = p['sku'], (p.get('image') or '').strip()
        dst = os.path.join(img_dir, f'{sku}.webp')
        manifest[sku] = f'{base_url}/img/{sku}.webp'

        if not url:
            missing.append(sku)
            continue

        h = url_hash(url)
        if not force and state.get(sku) == h and os.path.exists(dst):
            skipped.append(sku)
            continue

        try:
            r = requests.get(url, timeout=20)
            r.raise_for_status()
            im = Image.open(BytesIO(r.content))
            im.load()  # force-decode now so a truncated download fails here, not later
            if im.mode in ('P', 'CMYK'):
                im = im.convert('RGBA' if 'transparency' in im.info else 'RGB')
            if im.width > MAX_WIDTH:
                h_px = round(im.height * MAX_WIDTH / im.width)
                im = im.resize((MAX_WIDTH, h_px), Image.LANCZOS)
            im.save(dst, 'WEBP', quality=QUALITY, method=6)
            with Image.open(dst) as check:
                check.verify()
            state[sku] = h
            done.append(sku)
        except Exception as e:
            failed.append((sku, str(e)))
            continue

        time.sleep(0.15)  # be polite to Drive; this is a one-time batch, not the live site

    save_state(out_dir, state)
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1, sort_keys=True)

    return done, skipped, failed, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default=DEFAULT_SOURCE,
                     help='assets/products.json path, or a live ?fn=catalog URL')
    ap.add_argument('--out', required=True, help='local working copy of the target repo')
    ap.add_argument('--base-url', default=DEFAULT_BASE_URL)
    ap.add_argument('--limit', type=int, default=None, help='only process the first N products (dry run)')
    ap.add_argument('--skus', default=None, help='comma-separated SKU allowlist (dry run on specific items)')
    ap.add_argument('--force', action='store_true', help='re-download/re-encode even if unchanged')
    args = ap.parse_args()

    products = load_products(args.source)
    if args.skus:
        want = set(s.strip() for s in args.skus.split(','))
        products = [p for p in products if p['sku'] in want]
    elif args.limit:
        products = products[:args.limit]

    os.makedirs(args.out, exist_ok=True)
    done, skipped, failed, missing = migrate(products, args.out, args.base_url, args.force)

    print(f'converted: {len(done)}')
    print(f'skipped (unchanged): {len(skipped)}')
    print(f'missing image url: {len(missing)} {missing if missing else ""}')
    print(f'failed: {len(failed)}')
    for sku, err in failed:
        print(f'  {sku}: {err}')

    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
