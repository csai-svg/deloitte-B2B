#!/usr/bin/env python3
"""Refresh assets/products.json from the live Apps Script feed.

The storefront paints from this bundled snapshot on first load and only
swaps in the live feed on the *next* navigation (see loadCatalogueJSON in
assets/js/app.js), so a stale snapshot means first-time visitors never see
newly published products. Re-run this after every sheet change:

    python3 scripts/build_catalog.py

Writes assets/products.json only; taxonomy.json and colorways.json are
hand-maintained overrides applied client-side on top of it.
"""
import json
import pathlib
import subprocess
import sys

FEED = ("https://script.google.com/macros/s/"
        "AKfycbzNmMUxZWR7TtSGZYY0QS4Ld0oJ2QCs-OYB6cmOmBdHftrnZQdQkebt3ww-pbe11_BShA/exec"
        "?fn=catalog&brand=Deloitte")
OUT = pathlib.Path(__file__).resolve().parent.parent / "assets" / "products.json"

# Every field the storefront reads off a product. A feed that drops one of
# these silently disables a feature (no `sustainable` => the Sustainable
# filter and badge match nothing), so fail loudly instead.
REQUIRED = {"sku", "name", "category", "subcategory", "brand", "description",
            "moq", "gst_rate", "tiers", "base_price", "image", "active",
            "top_selling", "sustainable", "parent_sku"}


def fetch():
    """Apps Script answers the /exec redirect chain for a browser-shaped client
    only — urllib gets a 404 on the follow-up hop — so the fetch goes through
    curl, which handles it."""
    out = subprocess.run(["curl", "-sL", "--max-time", "120", FEED],
                         capture_output=True, check=True).stdout
    return json.loads(out)


def main():
    data = fetch()

    products = data.get("products") or []
    if len(products) < 100:
        sys.exit(f"refusing to write a {len(products)}-product snapshot — feed looks broken")
    missing = REQUIRED - set(products[0])
    if missing:
        sys.exit(f"feed is missing required fields: {sorted(missing)}")

    snapshot = {
        "generated_from": "Apps Script feed (fn=catalog&brand=Deloitte)",
        "generated_at": data.get("generated_at", ""),
        "categories": data.get("categories", []),
        "products": products,
        "event_kits": data.get("event_kits", []),
    }
    OUT.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n")
    sus = sum(1 for p in products if p.get("sustainable"))
    top = sum(1 for p in products if p.get("top_selling"))
    print(f"wrote {OUT.relative_to(OUT.parents[1])}: {len(products)} products, "
          f"{sus} sustainable, {top} top-selling")


if __name__ == "__main__":
    main()
