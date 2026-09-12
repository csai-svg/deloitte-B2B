/*
  B2B view-only catalogue — ONE shared Apps Script Web App, bound to the
  master pricing spreadsheet, serving BOTH the Optum and Deloitte storefronts.
  There is one catalogue (one sheet, one source of truth); the caller says
  which brand it is on every request via ?brand=Optum|Deloitte (GET) or
  {brand:'Optum'|'Deloitte'} (POST), and this script tags the response and
  routes submissions accordingly. Two sheets would mean maintaining the same
  catalogue twice and letting it drift — deliberately not done here.

  Does TWO things and nothing else:

    doGet(?fn=catalog&brand=Optum)  -> live JSON of ONLY the public columns
                           (name, brand, description, gender, category, moq,
                           gst, price tiers, image). Cost Price + Margins are
                           NEVER read into the response, so the master sheet
                           can stay private and nothing internal is exposed.
    doPost {fn:'kit_request', brand:'Optum', ...} -> appends one row to that
                           brand's own "<Brand> Kit Requests" tab (created if
                           missing) so ASMs see cart/kit submissions per site,
                           without splitting the catalogue itself.
                           No login, no approval, no payment.

  Deploy (once): Extensions > Apps Script (from the master sheet) > paste
  this > Deploy > New deployment > Web app > Execute as: Me > Who has
  access: Anyone > copy the ONE /exec URL into BOTH sites' CONFIG.FEED_URL /
  CONFIG.API_URL (each site keeps its own CONFIG.BRAND — see assets/js/app.js).

  Redeploying after an edit: Deploy > Manage deployments > (pencil icon on
  the existing deployment) > Version: New version > Deploy. Editing the
  existing deployment keeps the same /exec URL so neither site needs to
  change its config.
*/

var CFG = {
  DEFAULT_BRAND: 'Optum',            // used only if a caller omits ?brand= / body.brand
  CATALOG_SHEET: 'Main Catalogue',   // tab name of the shared catalogue (edit to match)
  TOKEN: '',                         // optional shared secret; '' = open
  CACHE_SECS: 60,
};

/* Header-name -> column finder (tolerant: trims, lowercases, ignores spaces). */
function colMap_(header) {
  var m = {};
  header.forEach(function (h, i) { m[String(h).toLowerCase().replace(/\s+/g, ' ').trim()] = i; });
  return function (name) {
    var k = name.toLowerCase().replace(/\s+/g, ' ').trim();
    return (k in m) ? m[k] : -1;
  };
}

function num_(v) {
  if (v === '' || v == null) return null;
  var n = Number(String(v).replace(/[^0-9.]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
}

function colors_(desc) {
  var m = /(?:available in|colou?rs?\s*variants?|colou?rs?\s*available|available colou?rs?)\s*[:\-]?\s*([^.]+)/i.exec(desc || '');
  if (!m) return [];
  return m[1].split(/,| and /).map(function (s) { return s.trim().replace(/\.$/, ''); })
    .filter(function (s) { return s && s.length < 30; }).slice(0, 12);
}

/* Brand normaliser: only 'Optum' and 'Deloitte' are known; anything else
   (missing/misspelled param) falls back to CFG.DEFAULT_BRAND so a bad ?brand=
   never serves a made-up tab name or a blank-labelled catalogue. */
function normalizeBrand_(raw) {
  var b = String(raw || '').trim();
  if (/^optum$/i.test(b)) return 'Optum';
  if (/^deloitte$/i.test(b)) return 'Deloitte';
  return CFG.DEFAULT_BRAND;
}

/* ------------------------------------------------------------------
   classify_(): assigns BOTH a top-level category and a real sub-category
   from the product name + description. Ordered rules, first match wins.
   MUST stay identical to classify.py used to build assets/products.json,
   so the live feed and the bundled snapshot group products the same way.
   ------------------------------------------------------------------ */
var NEUTRALIZE = [
  /bottle (pocket|pockets|holder|holders|sleeve|compartment|cage|opener)/g,
  /(screw|flip|flip-top|flip top|leak-?proof|spill-?proof|stylish|sipper|push-?button|press|one-press|twist|sliding|as sliding) (lid|cap)/g,
  /bottle cap/g,
  /pen (loop|loops|holder|pocket|slot)/g,
  /shoe (pouch|pocket|compartment|bag)/g,
  /(luggage|trolley) (mount|strap|straps|sleeve|pass-?through|pass|tag|handle)/g,
  /bottle green/g
];
var RULES = [
  [/gift box/, 'Gift Box', 'Gift Box'],
  [/lunch ?box/, 'Utilities', 'Accessories'],
  [/\bbottle|\bflask|\bsipper|sports bottle|\bthermos\b|insulated (bottle|flask)/, 'Drinkware', 'Bottles'],
  [/\bcap\b|\bcaps\b|beanie|bucket hat|\bvisor\b/, 'Apparel', 'Headwear'],
  [/hoodie|sweat ?shirt|half-?zip|quarter-?zip|hooded/, 'Apparel', 'Hoodies'],
  [/\bjacket|\bpuffer|\bfleece|\bbomber|track top|track jacket|track suit|tracksuit|windcheater|\bgilet/, 'Apparel', 'Jackets'],
  [/\bpolo|t-?shirt|\bt shirt|\btee\b|round neck|round-neck|crew neck|henley/, 'Apparel', 'T-Shirts'],
  [/formal shirt|dress shirt|\bshirt/, 'Apparel', 'Shirts'],
  [/\bshoes\b|sneaker|running shoes|sports shoes|footwear/, 'Apparel', 'Footwear'],
  [/sound ?bar|aavante|\bspeaker|earbud|ear ?phone|head ?phone|neckband|smart ?watch|\bear ?buds?\b/, 'Tech', 'Audio & Wearables'],
  [/power ?bank|wireless charg|charging (station|dock|cable)|multi-?charging|\bcharger\b|\badapter\b|charging cable/, 'Tech', 'Power & Charging'],
  [/air ?fryer|\bkettle\b|induction|cook ?top|\bblender|\bjuicer|\bgrinder|garment steamer|\bsteamer\b|vacuum cleaner|cordless vacuum|car vacuum|\bmixer|hand fan|\bmop\b/, 'Tech', 'Appliances'],
  [/frappe/, 'Drinkware', 'Frappe Mug'],
  [/tumbler|travel mug|coffee mug|ceramic (mug|cup)|\bmug\b|\bmugs\b|suction cup|\bcup\b/, 'Drinkware', 'Mugs & tumblers'],
  [/trolley|suit ?case|luggage|\bcabin\b|wayfarer|aviator|polycarbonate|polypropylene|hard ?top|hard-?shell|hard-?sided|travel gear|spinner wheel|telescopic/, 'Travel', 'Trolley bags'],
  [/laptop backpack|\bbackpack\b|back pack|rucksack|daypack/, 'Travel', 'Backpack'],
  [/\bduffle|\bduffel|weekender|gym bag/, 'Travel', 'Duffle bag'],
  [/\btote\b|\bjute\b|cotton tote|shopper|shopping bag/, 'Travel', 'Tote bags'],
  [/laptop sleeve|laptop bag|\bmessenger|\bsling|crossbody|work folio|\bfolio\b|file case|briefcase/, 'Travel', 'Laptop handbag'],
  [/passport|dopp kit|toiletry|toiletary|neck pillow|travel set|lunch bag|packing/, 'Travel', 'Travel accessories'],
  [/\bcoaster/, 'Utilities', 'Coasters'],
  [/twist-mechanism pen|ball ?point|roller ?ball|stylus pen|\bpen\b(?! ?(loop|holder|stand|pocket|slot))|\bpens\b/, 'Utilities', 'Pens'],
  [/note ?book|\bdiary\b|journal|notepad|organizer diary/, 'Utilities', 'Notebook'],
  [/wallet|key ?chain|card holder|\bpouch|organiz|\bstand\b|desk|lunch ?box|tech organizer/, 'Utilities', 'Accessories']
];

function classify_(sku, name, brand, desc) {
  if (String(name).toLowerCase().indexOf('gift box') >= 0) return ['Gift Box', 'Gift Box'];
  var t = (name + ' ' + brand + ' ' + desc).toLowerCase();
  for (var k = 0; k < NEUTRALIZE.length; k++) t = t.replace(NEUTRALIZE[k], ' ');
  for (var i = 0; i < RULES.length; i++) {
    if (RULES[i][0].test(t)) return [RULES[i][1], RULES[i][2]];
  }
  return ['Utilities', 'Accessories'];
}

/* Builds the (single, shared) catalogue and stamps it with whichever brand
   asked for it. The products themselves never differ by brand — only this
   top-level `brand` field does, so each site's header/footer/nav can read
   it if it ever needs to. */
function buildCatalog_(brand) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG.CATALOG_SHEET) || ss.getSheets()[0];
  var vals = sh.getDataRange().getValues();
  var header = vals[0], C = colMap_(header);
  var ci = {
    name: C('product name'), brand: C('brand'), desc: C('description'), gender: C('style(gender)'),
    tax: C('tax'), moq: C('moq'), sr: C('sr no'), img: C('image url'),
    t1: C('b2b moq price upto 100'), t2: C('100-200'), t3: C('200-500'), t4: C('500-1000'), t5: C('1000+'),
  };
  var BANDS = [[ci.t1, 20, 100], [ci.t2, 101, 200], [ci.t3, 201, 500], [ci.t4, 501, 1000], [ci.t5, 1001, null]];
  var products = [];
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r];
    var name = String(row[ci.name] || '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    var sr = String(row[ci.sr] || r).replace(/[^0-9]/g, '') || String(r);
    var sku = 'CS' + ('0000' + sr).slice(-4);
    var itemBrand = String(row[ci.brand] || '').trim();
    var desc = String(row[ci.desc] || '').replace(/\s+/g, ' ').trim();
    var gst = parseInt(String(row[ci.tax]).replace(/[^0-9]/g, ''), 10) || 0;
    var moq = parseInt(String(row[ci.moq]).replace(/[^0-9]/g, ''), 10) || 20;
    var tiers = [];
    BANDS.forEach(function (b) {
      var p = b[0] >= 0 ? num_(row[b[0]]) : null;
      if (p) tiers.push({ min_qty: (b[1] === 20 ? moq : b[1]), max_qty: b[2], unit_price: p, gst_rate: gst });
    });
    var cls = classify_(sku, name, itemBrand, desc);
    var cat = cls[0], sub = cls[1];
    products.push({
      sku: sku, name: name, category: cat, subcategory: sub, brand: itemBrand, description: desc,
      gender: String(row[ci.gender] || '').trim(), colors: colors_(desc), moq: moq, gst_rate: gst,
      tiers: tiers, base_price: tiers.length ? tiers[0].unit_price : 0, sizes: ['OS'], has_sizes: false,
      image: ci.img >= 0 ? String(row[ci.img] || '').trim() : '', active: true, related: [],
      event_tags: cat === 'Gift Box' ? ['kit'] : [],
    });
  }
  return {
    generated_at: new Date().toISOString(), brand: brand,
    categories: ['Apparel', 'Drinkware', 'Travel', 'Tech', 'Utilities'],
    products: products, event_kits: products.filter(function (p) { return p.category === 'Gift Box'; }).map(function (p) { return p.sku; }),
  };
}

function jsonOut_(obj, cb) {
  var s = JSON.stringify(obj);
  if (cb) return ContentService.createTextOutput(cb + '(' + s + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (CFG.TOKEN && p.token !== CFG.TOKEN) return jsonOut_({ error: 'unauthorized' }, p.callback);
  var brand = normalizeBrand_(p.brand);
  var cache = CacheService.getScriptCache();
  var key = 'catalog_' + brand;
  var hit = cache.get(key);
  if (hit && !p.nocache) return jsonOut_(JSON.parse(hit), p.callback);
  var data = buildCatalog_(brand);
  try { cache.put(key, JSON.stringify(data), CFG.CACHE_SECS); } catch (err) {}
  return jsonOut_(data, p.callback);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return jsonOut_({ ok: false, error: 'bad json' }); }
  if (CFG.TOKEN && body.token !== CFG.TOKEN) return jsonOut_({ ok: false, error: 'unauthorized' });
  if (body.fn !== 'kit_request') return jsonOut_({ ok: false, error: 'unknown fn' });

  var brand = normalizeBrand_(body.brand);   // 'Optum' or 'Deloitte', from the site that submitted
  var tabName = brand + ' Kit Requests';     // per-brand tab, created on demand
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(tabName);
  if (!sh) {
    sh = ss.insertSheet(tabName);
    sh.appendRow(['Timestamp', 'Brand', 'Name', 'Work email', 'Notes / deadline', 'Items (summary)', 'Total qty', 'Items (JSON)']);
  }
  var items = body.items || [];
  var summary = items.map(function (it) { return it.qty + ' x ' + it.name + (it.sku ? ' [' + it.sku + ']' : ''); }).join('; ');
  var totalQty = items.reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
  sh.appendRow([new Date(), brand, body.name || '', body.email || '', body.notes || '', summary, totalQty, JSON.stringify(items)]);
  return jsonOut_({ ok: true });
}
