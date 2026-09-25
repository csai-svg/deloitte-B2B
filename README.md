# Deloitte B2B Store

View-only merchandise catalogue for Deloitte, published at
<https://csai-svg.github.io/deloitte-B2B/>.

Static frontend on GitHub Pages, one Google Sheet as the catalogue, one Apps
Script web app as the feed and the submission endpoint. No server, no
framework, no build step — the only tooling is a Python script that refreshes
the bundled catalogue snapshot.

There is **no login, no approval, no payment**. A visitor browses, builds a cart
or a kit, and submits a request; that request lands as one row on a
`Deloitte Kit Requests` tab for an ASM to pick up.

---

## What is here

```
index.html        landing: banner, categories, a featured strip
all.html          whole catalogue, search + filter rail
category.html     one category, subcategory filters
product.html      detail, colour/variant picker, tier calculator, MOQ gate
event-kits.html   one occasion (Sustainability, Festive Gift Kits)
preset-kits.html  the ready-made Gift Box products
kit.html          build-a-kit: headcount and budget in, a kit out
cart.html         cart, MOQ enforcement, submits the request

assets/products.json    catalogue snapshot, 304 products (build artifact)
assets/taxonomy.json    per-SKU category override, 304 entries (hand-maintained)
assets/colorways.json   curated colour groups (hand-maintained)
assets/site.json        banner, logo and site copy
assets/offices.json     Deloitte India delivery centres, for the request form
assets/kits/kits.json   occasion photography, keyed by slug
assets/css/app.css      Deloitte palette, all tokens in :root
assets/js/app.js        catalogue, pricing engine, filters, page chrome

apps-script-feed/Code.gs   the backend: catalogue feed + request intake
scripts/                   build and image tooling (not deployed)
```

`robots.txt` disallows everything and every page carries `noindex,nofollow`:
the prices are public to anyone with the link but must not be indexed.

---

## The catalogue pipeline

One Google Sheet is the source of truth. It is read two ways:

```
                    ┌─ JSONP, live, cached 60s ──────────────┐
Google Sheet ──► Code.gs doGet(?fn=catalog&brand=Deloitte) ───┤
                    └─ scripts/build_catalog.py ──► assets/products.json
```

The storefront paints from `assets/products.json` on first load and swaps in
the live feed only on the **next** navigation (`loadCatalogueJSON` in
`app.js`). That keeps first paint instant, but it means a stale snapshot is a
stale storefront for every first-time visitor. **Re-run the build after any
change to the sheet:**

```
python3 scripts/build_catalog.py     # rewrites assets/products.json from the feed
git commit -am "catalogue refresh" && git push
```

The script refuses to write a snapshot under 100 products or one missing any
field the storefront reads, so a broken feed cannot quietly empty the store.

### Two overrides layered on top

Both are applied client-side after the catalogue loads and are **not**
overwritten by `build_catalog.py`:

| file | what it does |
|---|---|
| `assets/taxonomy.json` | pins a SKU's category and subcategory, beating the `classify_` regexes in `Code.gs` |
| `assets/colorways.json` | collapses one style's colour SKUs into a single card with swatches |

`classify_` guesses a category from the product name and description, and it is
wrong often enough to matter — a Crossbody Sling matching `/bottle/` off its
description landed in Drinkware/Bottles, a ball pen in Apparel/Shirts. **Every
new SKU should get a `taxonomy.json` entry**; without one it falls back to the
guess.

### Duplicate listings

Two mechanisms collapse a style that the sheet lists as several rows:

1. **`colorways.json`** — curated. Members are identified by either the
   `CS####` storefront SKU or the vendor code the sheet publishes as
   `parent_sku` (`CSUN-3478`, `OBLI-102`); `findBySku_` resolves both, so a
   group survives a re-export that renumbers `CS####`. All three groups in the
   file are currently dormant — those styles were dropped from the sheet.
2. **`groupVariants()`** — automatic, for rows that share a name *and* a photo
   and carry no colour data at all (SOIL Classic Journal ×3, OMG Full Zip Swag
   Jacket ×2, OMG Surry Sweatshirt ×2). They get one "N variants" card and SKU
   links rather than invented colour swatches. It is keyed on the name, so it
   dissolves by itself once the sheet gives those rows distinct names.

Either way every SKU keeps its own price, MOQ and `product.html?sku=` URL.

---

## Sheet columns the storefront reads

`Code.gs` resolves headers case- and space-insensitively, with a prefix match
as a fallback, so a header with explanatory text tacked on still binds.

| column | becomes |
|---|---|
| `Sr No` | the `CS####` SKU |
| `Product Name`, `Brand`, `Description`, `Style(Gender)` | product copy |
| `MOQ`, `Tax` | order gate and GST rate |
| `B2B MOQ price upto 100`, `100-200`, `200-500`, `500-1000`, `1000+` | the five price tiers |
| `Image URL` | the card and detail photo |
| `Top Selling` | "Top Selling" badge + filter chip |
| `Sustainable` | "Sustainable" badge, filter chip, and the Sustainability page |
| `SKU Codes - Parent` | `parent_sku`, used to resolve `colorways.json` members |

`Cost Price` and margin columns are never read into the response, so the master
sheet can stay private.

---

## Occasions

`EVENT_KIT_NAV` in `app.js` lists the occasions in the nav, and every slug in it
must have a matching rule in `EVENT_KIT_PICKS` that says which products it
shows. Only two qualify today:

| slug | products |
|---|---|
| `sustainability` | the sheet's `Sustainable` column |
| `festive-gift-kits` | the `Gift Box` category |

`assets/kits/kits.json` also carries photography for six more (New Joinee
Program, Employee Recognition & Rewards, New Mom & Baby Kit, Personal
Milestone, CXO Gifting, Executive Gifting), but the sheet has no column that
says which products belong to any of them. They are deliberately **out of the
nav**: a page that can only show stock photography is not a kit. To add one
back, add it to `EVENT_KIT_NAV` *and* give it a rule — never one without the
other.

---

## How pricing works

Tiers are per product, read straight off the sheet's five price columns. The
lowest band starts at the product's MOQ rather than at 20, so the ladder never
advertises a quantity the product cannot be ordered in.

1. Pick the highest tier whose `min_qty` is at or below the line quantity
   (`pickTier`).
2. Below MOQ the cart blocks the line rather than pricing it.
3. A product with no usable tier price shows no price at all — not "0", not
   "Price on request" — and offers an enquiry route instead. `hasPrice()`
   guards every display and total, so a zero can never reach a cart line.

`kit.html` prices a kit as one unit per employee, which means the headcount
alone has to clear each product's MOQ (`kitEligible`).

---

## Brand

Deloitte palette. All tokens live in one place, `:root` in `assets/css/app.css`.

| Token | Value | Use |
|---|---|---|
| `--brand` | `#26890D` | buttons, links, active states |
| `--brand-bright` | `#86BC25` | Deloitte signature green, accents |
| `--brand-deep` | `#046A38` | deep green |
| `--ink` | `#000000` | body text, hero, dark surfaces |
| `--tint` | `#EAF3DF` | callouts, active tier row |
| `--off` | `#F7F7F7` | page and image backgrounds |
| `--line` | `#E4E4E4` | borders |
| `--grey` / `--muted` | `#8A8A8A` / `#4A4A4A` | secondary text |

---

## Deploy

### Frontend

Push to `main`. Pages serves the repo root; a deploy lands in about a minute.

### Backend

`apps-script-feed/Code.gs` is bound to the master pricing spreadsheet and is
**shared with the Optum storefront** — one sheet, one script, one `/exec` URL.
The caller says which brand it is on every request (`?brand=Deloitte` on GET,
`{brand:'Deloitte'}` on POST); only the response tag and the destination tab
differ. Two sheets would mean maintaining the same catalogue twice.

To change it: Extensions → Apps Script from the master sheet → edit → Deploy →
Manage deployments → pencil → Version: New version → Deploy. Editing the
existing deployment keeps the same `/exec` URL, so neither site needs a config
change.

`CONFIG.FEED_URL` / `CONFIG.API_URL` / `CONFIG.BRAND` sit at the top of
`assets/js/app.js`.

---

## Known constraints, stated deliberately

**CORS.** Apps Script cannot answer a preflight `OPTIONS`. The catalogue is
fetched by JSONP (`Code.gs` returns `callback(json)` when `?callback=` is
present) and every POST goes out as `Content-Type: text/plain` with a JSON
string body. Do not "fix" either to `application/json`; every read and write
will start failing.

**Cold starts.** A cold Apps Script call has been seen to take over 12 seconds,
which is the JSONP timeout in `refreshFeedCache`. A timed-out refresh is
silent and harmless — the next navigation retries — but it is another reason
the committed snapshot has to be current.

**Image hosting.** Product photos come from two places: `csai-svg.github.io`
(migrated copies) and `drive.google.com/thumbnail?id=…` straight off Drive.
The Drive folder must stay shared "Anyone with the link — Viewer" or those
images stop resolving for visitors. `imgAt()` rewrites the size parameter per
call site so a 52px thumbnail does not pull a full-size original.

**Sheet header drift.** `colMap_` falls back to a prefix match because a blank
match means every row's name comes back empty and the catalogue silently
disappears. Renaming a column to something that no longer shares a prefix will
still break it.

---

## Still open

1. Colours for the seven auto-grouped variant SKUs, so they can move into
   `colorways.json` as real swatches. The sheet is expected to give them
   distinct names, which will un-group them automatically.
2. Product curation for the six occasions currently out of the nav, if they are
   wanted — a sheet column or a curated SKU list per occasion.
3. Photography for the five products with no image
   (`CS0228`, `CS0245`, `CS0270`, `CS0300`, `CS0301`); they render the
   "Image coming soon" placeholder.
