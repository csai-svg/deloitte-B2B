# CompanyStore B2B Store

Replacement for the Magento storefront at `b2b.companystore.gifts`.

Static frontend on GitHub Pages, Google Sheet as the database, Apps Script as the
API. No server, no framework, no build step.

---

## What is here

```
index.html      public catalogue landing
category.html   listing with subcategory filters
product.html    detail, size matrix, live tier calculator, MOQ gate
cart.html       cart grouped by parent SKU, MOQ enforcement
login.html      sign in + request password reset
reset.html      set a new password from an emailed link
checkout.html   gated: requester, context, evidence upload, addresses
status.html     requester order lookup and tracking
admin.html      CompanyStore.IO console: list, drawer, close with tracking

assets/brand/            the CompanyStore mark, extracted from CompanyStore merchandise
assets/products.json     the entire catalogue, 134 products (build artifact)
assets/products/*.webp   134 images, 0.6 MB total
assets/css/app.css       CompanyStore palette, all tokens in :root
assets/js/app.js         cart, pricing engine, API client, page chrome

apps-script/    the backend. Config, Auth, Orders, Mail, Api, Setup
sheet-seed/     CSVs to paste into the Sheet tabs
tools/          build + test scripts (not deployed)
```

## Catalogue figures

| | |
|---|---|
| Sellable products | 134 |
| Size variants | 280 |
| Products with a real photo | 126 |
| Placeholder tiles | 8 |
| Total image weight | 0.6 MB (from 8.7 MB) |
| Categories | Apparel, Drinkware, Travel, Utilities |

The 8 placeholders are products whose images could not be resolved on the live
Magento storefront. They render as branded "Image pending" tiles. Listed in
`tools/image_manifest.json` by omission.

---

## PRICING IS PLACEHOLDER

**Read this before showing the site to anyone at CompanyStore.**

The Magento export contains no tier prices and no MOQ values. Verified: zero of
the 423 rows carry tier data, `special_price` is empty on all of them, and
Magento keeps Advanced Pricing in a separate export.

The MOQ and tier ladder in `assets/products.json` and `sheet-seed/PriceTiers.csv`
were **generated** by `tools/build_catalog.py` from this rule:

* MOQ: Apparel/Caps/Mug/Sipper/Stationery 25, Bags 10, Accessories 50
* Breaks at 1×, 2×, 4× and 10× MOQ, at 0%, 7%, 12% and 18% off the base price
* Rounded to the nearest ₹5

GST is likewise a placeholder: 5% on apparel and bags, 18% on everything else.
The CSB012862 order shows the client running 5% on a ₹1,953 duffle bag and 18%
on drinkware and stationery, which does not follow the standard slabs. Confirm
every rate with finance.

To load the real numbers, replace `sheet-seed/PriceTiers.csv` and the `moq` and
`gst_rate` columns in `sheet-seed/Products.csv`, then re-run:

```
python3 tools/build_catalog.py
```

---

## Brand

CompanyStore palette, not CompanyStore.IO Core 5.

| Token | Value | Use |
|---|---|---|
| Cerulean | `#009CDE` | primary actions, accents, active states |
| Midnight | `#00153D` | body text, hero, dark surfaces |
| White | `#FFFFFF` | surfaces |
| Tint | `#E4F3FC` | callouts, active tier row |
| Off | `#F4F8FB` | page and image backgrounds |
| Line | `#DCE5EE` | borders |
| Grey / Muted | `#9AA6B8` / `#5B6A80` | secondary text |

Cerulean and Midnight are CompanyStore US's own brand values. Cerulean was independently
confirmed against the logo printed on CompanyStore merchandise: sampled at `#0A94D5`,
hue 199-202 degrees, across four product photos. There is no green in the CompanyStore
mark; an apparent green pixel on a low-resolution shirt photo turned out to be a
JPEG artifact, checked and discarded.

`assets/brand/logo.svg` (Cerulean) and `logo-white.svg` were lifted from
the mark printed on `B2BRSMON-0162`, matted on the red channel and cropped inside
the disc. They are the real trademark, not a redrawing, but they came off a
photograph, so **replace them with the official vector artwork before go-live.**
The original sits at `/media/logo/stores/12/logo_2x.png` on the Magento server,
which was offline when this was built.

Colours live in one place, `:root` in `assets/css/app.css`. The approval and
decision emails carry their own copy in `apps-script/Mail.gs`; change both.

---

## Deploy

### 1. Frontend on GitHub Pages

```
git init && git add -A && git commit -m "CompanyStore B2B store"
git remote add origin git@github.com:<you>/B2B-Website.git
git push -u origin main
```

Repository → Settings → Pages → Source: `main`, folder `/ (root)`.

`robots.txt` disallows everything and every page carries `noindex,nofollow`,
because the catalogue prices are public but should not be indexed.

### 2. Backend

1. Create a blank Google Sheet. Copy its id.
2. Create a Drive folder for evidence uploads. Copy its id.
3. Create an Apps Script project, paste in the six files from `apps-script/`.
4. Project Settings → Script Properties:

| Property | Value |
|---|---|
| `SHEET_ID` | the spreadsheet id |
| `FOLDER_ID` | the evidence folder id |
| `API_TOKEN` | any random string; must match `CONFIG.API_TOKEN` in `app.js` |
| `PEPPER` | a long random string. Never share it. Changing it invalidates every password |
| `ADMIN_PASS` | password for `admin.html` |
| `SENDER_ALIAS` | `store@companystore.io` |
| `SITE_URL` | `https://<you>.github.io/B2B-Website` |

5. Run `setupBackend()` once. It creates all eleven tabs with headers.
6. Import each CSV from `sheet-seed/` into its matching tab
   (File → Import → Append to current sheet).
7. Fill the `Users` tab. Add a temporary `initial_password` column, put a
   plaintext password in each row, run `seedPasswords()`, then delete that column.
8. Fill the `Approvers` tab. For testing, one row with `roger@companystore.io`.
9. Run `healthCheck()` and read the log. It will name anything still missing,
   including any product with no tier rows.
10. Deploy → New deployment → Web app. Execute as **Me**, access **Anyone**.
11. Paste the `/exec` URL into `CONFIG.API_URL` at the top of `assets/js/app.js`,
    and set `CONFIG.API_TOKEN` to the same value as the Script Property. Commit.

---

## How pricing works

The rule, applied identically in `app.js` and `apps-script/Orders.gs`:

1. Group cart lines by **parent SKU**.
2. Sum quantity across every size in that group.
3. Pick the highest tier whose `min_qty` is at or below that sum.
4. Apply that unit price to **every** line in the group.
5. Block the order if the group total is under the product MOQ.

Worked example, Arrow Formal Shirt, MOQ 25:

| Line | Qty |
|---|---|
| `_M` | 10 |
| `_L` | 12 |
| `_XL` | 8 |

Group total 30 → the 25-49 band → all three lines price at ₹1,650. Without the
rollup each line would sit under the MOQ and the order could not be placed.

`OrderLines` stores the resolved `group_qty` and `tier_applied` rather than
recalculating them, so editing the tier table later cannot silently reprice an
order that was already approved.

The browser's total is sent to the server but never trusted. `priceOrder()`
recomputes everything from the Sheet and rejects a mismatch over ₹1.

---

## How approval works

The old system used one static code, `CompanyStore$2025JN`, hardcoded in `WebApp.js`,
identical for every order and every approver, with no record of who acted. That
is gone.

On submission the script mints one signed link **per approver**:

```
sig = HMAC_SHA256(PEPPER, orderId + "|" + approverEmail + "|" + expiry)
```

The approve and reject links carry `orderId`, `act`, `who`, `exp` and `sig`. The
script recomputes the signature, checks the expiry, checks the order is still
pending, then writes `decided_by` from the token payload. No code to type, no
code to leak, and every decision is attributable.

Links expire after 14 days. `adminResend` mints fresh ones.

Order IDs continue the Magento sequence from `CSB013682`. The last live Magento
order was `CSB013681` on 15 June 2026.

---

## Tests

```
node tools/test_pricing.js     # 24 unit tests on the tier and MOQ engine
node tools/mock_api.js &       # local stand-in for the Apps Script backend
python3 tools/e2e.py           # 24 browser checks over the whole flow
```

`tools/mock_api.js` mirrors the response shapes of the real handlers so the
frontend can be exercised before the Sheet exists. It is a test fixture, not
part of the deployment.

The e2e suite covers: MOQ gate, size rollup, one price across sizes, checkout
gating, form prefill, mandatory evidence, submission, cart clearing, status
display, approval, admin close with tracking, and the rejection path.

---

## Known limitations, stated deliberately

**Password hashing.** Salted SHA-256 with a server-side pepper, not bcrypt or
Argon2. Apps Script has no native bcrypt and a real PBKDF2 iteration count will
not finish inside the 6 minute execution limit. Proportionate for ~30 internal
users on an internal catalogue. On the hardening list for Cloudways.

**The API token is visible.** It sits in `app.js` and anyone can read it in
view-source. It stops casual abuse, not a determined attacker. In production,
front the Apps Script with a Cloudflare Worker holding the real token, the same
pattern already used for `pft-mcp` and `ots-mcp`.

**Sheets is not a database.** No transactions, no foreign keys. Every write goes
through `LockService`. Fine at three orders a month. Past roughly 50 a month,
move `Orders` and `OrderLines` to a real database.

**CORS.** Apps Script cannot answer a preflight `OPTIONS`. Every browser POST
must send `Content-Type: text/plain` with a JSON string body. Do not "fix" this
to `application/json`; every write will start failing.

**Mail deliverability.** Approvals go to `@companystore.io`, a Microsoft tenant.
Confirm SPF and DMARC alignment for the `store@companystore.io` alias before
go-live.

**Apps Script quotas.** 6 min per execution, 90 min/day, 1,500 mail recipients
per day, 20,000 UrlFetch per day. At three orders a month this is not a
constraint. Do not engineer around it.

---

## Still open

1. Real MOQ and tier price table. This is the only true blocker.
2. Confirmed GST rate per product.
3. The production approver list.
4. The full CompanyStore user list. The order export yields only 11 requesters.
5. Whether approved orders should push into Zoho CRM as a Sales Order.
6. The Table Rate shipping matrix, if shipping is to be quoted in-app rather
   than after approval.
