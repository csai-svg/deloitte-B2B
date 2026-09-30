# Deloitte B2B Store

Closed, view-only merchandise catalogue for Deloitte, published at
<https://csai-svg.github.io/deloitte-B2B/>.

Static frontend on GitHub Pages, one Google Sheet as the catalogue (and the
credential store), one Apps Script web app as the feed, login gate and
submission endpoint. No server, no framework, no build step.

There is **no signup, no self-service password reset, and no order
tracking**. A visitor signs in with a username/password an ASM issued them,
browses, builds a cart or a kit, and submits a request; that request lands as
one row on the `Cart Enquiries` tab for an ASM to pick up. There is no
approval workflow and no payment.

**The catalogue is genuinely gated, not client-side theatre.** No product or
price data is ever bundled into this repo (see `.gitignore`) — every page
loads the catalogue live from Code.gs, which itself refuses to return
anything without a valid session token. See "Login gate" below.

---

## What is here

```
login.html        username + password sign-in, the only unauthenticated page
index.html        landing: banner, categories, a featured strip
all.html          whole catalogue, search + filter rail
category.html     one category, subcategory filters
product.html      detail, colour/variant picker, tier calculator, MOQ gate
event-kits.html   one occasion (Sustainability, Festive Gift Kits)
preset-kits.html  the ready-made Gift Box products
kit.html          build-a-kit: headcount and budget in, a kit out
cart.html         cart, MOQ enforcement, submits the request
agent.html        Agent Merch: internal kit-builder + PDF quotation tool,
                  gated to CompanyStore sales agents only — see below

assets/taxonomy.json    per-SKU category override (hand-maintained)
assets/colorways.json   curated colour groups (hand-maintained)
assets/site.json        banner, logo, site copy and the PDF footer lines — no prices, safe to publish
assets/offices.json     Deloitte India delivery centres, for the request form
assets/kits/kits.json   occasion photography, keyed by slug
assets/css/app.css      Deloitte palette, all tokens in :root
assets/js/app.js        catalogue, pricing engine, filters, page chrome, auth
assets/js/agent.js      Agent Merch's kit generation, PDF export and quote history — not loaded outside agent.html

apps-script-feed/Code.gs   the backend: login gate, catalogue feed, request intake
scripts/                   image tooling (not deployed)
```

`robots.txt` disallows everything and every page carries `noindex,nofollow`.
There is no bundled catalogue snapshot — `assets/products.json` is gitignored
and must never be committed — so nothing about the products or prices is
reachable without signing in first.

---

## Login gate

The catalogue is closed. Every page except `login.html` carries a synchronous
head-guard that redirects to it the instant there is no `cs_session` token in
`sessionStorage` — nothing paints before that check runs.

```
username/password ──► Code.gs doPost({fn:'login'}) ──► Login sheet tab
                       (SHA-256(salt+password), constant-time compare)
                            │ ok
                            ▼
                    opaque session token, 6h TTL, in CacheService
                            │
              stored client-side in sessionStorage (cleared when the tab closes)
                            │
        every fn=catalog / fn=kit_request call carries it and is rejected without it
```

Credentials live in the **`Login`** tab of the same spreadsheet the catalogue
feed reads, next to `Cart Enquiries` (where submitted requests land). There
is no signup and no self-service reset: an ASM manages rows directly.

**Login tab columns:** `username | password | password_hash | salt | active | name | email | company | last_login | notes | agent_access`

**Adding a user (ASM workflow):** add a row, type a plain-text password into
`password`, set `active` to `TRUE`, then from the spreadsheet's
**Client Access > Hash new passwords** menu run the hash. That reads any row
with a plain password and no hash yet, generates a random salt, stores
`SHA-256(salt + password)` in `password_hash`, writes the salt, and clears the
plain `password` cell — nothing plain-text is left sitting in the sheet.
Setting `active` to `FALSE` disables a user immediately (same generic error
as a wrong password, so a disabled account can't be enumerated).

**Brute force:** 5 wrong passwords locks that username out for 15 minutes
(same generic error either way), plus a small delay on every failed attempt.
A Google Chat webhook (`CFG.WEBHOOK_URL` in `Code.gs`) posts on lockouts,
successful sign-ins, and every cart/kit submission.

## Agent Merch (internal, gated)

`agent.html` is a kit-builder + PDF-quotation tool for CompanyStore ASMs and
sales agents — not a customer-facing page. It builds kits/collections from
the same live Deloitte catalogue everyone else sees (no second data source),
at the agent's chosen quantity-per-kit tier price plus a markup they set, and
exports a branded PDF for a client. Every other Deloitte user must see **no
trace of it**: no nav link, no page, no data.

**Access control, three layers deep (a hidden nav link alone is not access
control):**

1. **Login tab flag.** A Login row needs `agent_access` set to `TRUE`. Blank,
   `FALSE`, or the column missing entirely all resolve to "no access" — adding
   the column is safe to do at any time, it never breaks a login.
2. **Nav.** `header()`/`openMenu()` in `app.js` only render the "Agent Merch"
   link when the signed-in user's `features.agentMerch` (set at login from the
   Login row) is true.
3. **Page + backend.** `agent.html` carries the usual session head-guard plus
   a second check: a session without `features.agentMerch` is redirected to
   `index.html` silently, no error shown. Separately, and this is the part
   that actually matters if someone bypasses the UI, `Code.gs`'s
   `fn=agent_log` endpoint calls `requireAgentSession_`, which checks the
   *session's* `agentAccess` flag (minted server-side at login, not anything
   the client can assert) and returns the same generic `{error:'unauthorized'}`
   used everywhere else — a non-agent's token gets rejected even if they call
   the endpoint directly from devtools.

**Where things live:**

- `agent_access` (and no other new column) on the `Login` tab, resolved by
  `colOfOptional_` in `Code.gs` — unlike `colOf_`, it returns `-1` instead of
  throwing when the column is absent, so this stays backward-compatible.
- `fn=agent_log` (`Code.gs`) — the only new endpoint. Writes one row per
  generate/manual-add/status/PDF-export event to an auto-created **`Agent
  Capture`** sheet tab (`Timestamp, Username, Name, Company, Event, QuoteId,
  ClientName, Payload`), with identity columns taken from the session, never
  from the request body. Only a `pdf_export` event also pings the Google Chat
  webhook — every other event is capture-only.
- `assets/site.json`'s `settings.pdfFooter` — the six disclaimer lines printed
  on every exported PDF (GST, branding/logo setup charges, freight, custom
  design MOQ, lead time). Edit this file to change the wording; no code
  change needed.
- Product images in the PDF are converted to base64 before jsPDF touches them
  (a cross-origin image drawn straight into a canvas would taint it): the
  logo and other same-origin assets are fetched directly, Drive-hosted
  product photos go through the public `images.weserv.nl` proxy. That proxy
  only ever sees a product photo URL, never a price or a client name.

**Redeploy note:** the `agent_access` column and `fn=agent_log` endpoint only
take effect after `Code.gs` is redeployed — see "Backend" under Deploy below;
editing the Apps Script source alone does not update the live `/exec` URL.

## The catalogue feed

One Google Sheet is the source of truth, read live on every page load —
there is no bundled snapshot:

```
Google Sheet ──► Code.gs doGet(?fn=catalog&brand=Deloitte&session=…) ──► JSONP, cached 60s server-side
```

`loadCatalogueJSON()` in `app.js` calls this once per browser session (cached
in `sessionStorage` for the rest of the tab) and refreshes it in the
background on every navigation after that. A feed that is unreachable or
answers `unauthorized` never falls back to stale or local data — it shows
"Unable to load catalogue, please retry" (or, for an expired session,
redirects to `login.html`).

### Two overrides layered on top

Both are hand-maintained static files, applied client-side after the live
catalogue loads:

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

`apps-script-feed/Code.gs` is bound to this brand's own pricing spreadsheet.
Optum runs a separate deployment and sheet (`optum-B2B/apps-script-feed/Code.gs`)
— the two are independent scripts and no longer share a backend, a catalogue
tab, or a `/exec` URL, so a change here needs no Optum compatibility check.

To change it: Extensions → Apps Script from this spreadsheet → paste in the
new `Code.gs` → if the `Login` tab is new, run `hashPendingPasswords` once
from the Run dropdown (authorises the script and hashes any seed rows) →
Deploy → Manage deployments → pencil → Version: New version → Deploy. Editing
the existing deployment keeps the same `/exec` URL, so the site needs no
config change — but the web app **must** be redeployed with a new version for
`fn=login` (or any other new/changed endpoint, including `fn=agent_log`) to
actually take effect; saving alone is not enough.

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
which is the JSONP timeout in `refreshFeedCache`. On the *first* page of a
session, `loadCatalogueJSON` blocks on the feed (12s timeout) since there is
no snapshot to fall back to; a slow/failed feed shows "Unable to load
catalogue, please retry" rather than a blank or stale page. A timed-out
*background* refresh on a later navigation is silent and harmless — the next
navigation retries.

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
