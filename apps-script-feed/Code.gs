/*
  B2B view-only catalogue — single Apps Script Web App, bound to the master
  pricing spreadsheet. Does TWO things and nothing else:

    doGet(?fn=catalog)  -> live JSON of ONLY the public columns (name, brand,
                           description, gender, category, moq, gst, price
                           tiers, image). Cost Price + Margins are NEVER read
                           into the response, so the master sheet can stay
                           private and nothing internal is exposed.
    doPost {fn:'kit_request', ...} -> appends one row to the "Kit Requests"
                           tab (created if missing) so ASMs see cart/kit
                           submissions. No login, no approval, no payment.

  Deploy: Extensions > Apps Script (from the master sheet) > paste this >
  Deploy > New deployment > Web app > Execute as: Me > Who has access:
  Anyone > copy the /exec URL into the site's CONFIG.FEED_URL.
*/

var CFG = {
  BRAND: 'Deloitte',                 // set per deployment: 'Deloitte' | 'Optum'
  CATALOG_SHEET: 'Main Catalogue',   // tab name of the catalogue (edit to match)
  KIT_SHEET: 'Kit Requests',         // created if absent
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

/* Category rules mirror the build-time pipeline. Overrides win. */
var OVERRIDE = { 'CS0107': 'Apparel', 'CS0156': 'Tech', 'CS0194': 'Tech', 'CS0209': 'Tech',
  'CS0159': 'Utilities', 'CS0161': 'Utilities', 'CS0162': 'Utilities', 'CS0163': 'Utilities',
  'CS0164': 'Utilities', 'CS0165': 'Utilities', 'CS0201': 'Tech' };

function category_(sku, name, brand, desc) {
  if (OVERRIDE[sku]) return OVERRIDE[sku];
  var t = (name + ' ' + brand + ' ' + desc).toLowerCase(), n = name.toLowerCase();
  function has(a) { for (var i = 0; i < a.length; i++) if (t.indexOf(a[i]) >= 0) return true; return false; }
  if (n.indexOf('gift box') >= 0) return 'Gift Box';
  if (has(['polo', 't-shirt', 'tshirt', 't shirt', ' tee', 'shirt', 'hoodie', 'sweatshirt', 'jacket',
    'round neck', 'track top', 'track jacket', 'track suit', 'tracksuit', 'puffer', 'fleece', ' cap', 'shoes', 'bomber'])) return 'Apparel';
  if (has(['bottle', 'flask', 'mug', ' cup', 'tumbler', 'sipper', 'drinkware', 'vacuum flask', 'infuser', 'suction'])) return 'Drinkware';
  if (has(['power bank', 'powerbank', 'speaker', 'earbud', 'headphone', 'neckband', 'charging cable', 'charger',
    'wireless', 'blender', 'air fryer', 'airfryer', 'kettle', 'induction', 'juicer', 'steamer', 'cooktop', ' mop',
    'grinder', 'smartwatch', 'bluetooth', 'adapter', 'hand fan', 'soundbar', 'aavante'])) return 'Tech';
  if (has(['backpack', 'duffle', 'duffel', 'sling', 'trolley', 'luggage', 'suitcase', 'passport', 'messenger',
    'crossbody', 'tote', 'jute', 'overnighter', 'laptop bag', 'laptop sleeve', 'lunch bag', 'dopp kit', ' travel ',
    'folio', 'toiletry', 'toiletary', 'wayfarer', 'aviator', ' bag'])) return 'Travel';
  if (has(['pouch', 'organizer', 'organiser', 'wallet', 'stand ', 'desk', 'lunch box', 'lunchbox', 'glass lunch',
    'steel lunch', 'notebook', 'pen ', 'keychain'])) return 'Utilities';
  return 'Utilities';
}

function buildCatalog_() {
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
    var brand = String(row[ci.brand] || '').trim();
    var desc = String(row[ci.desc] || '').replace(/\s+/g, ' ').trim();
    var gst = parseInt(String(row[ci.tax]).replace(/[^0-9]/g, ''), 10) || 0;
    var moq = parseInt(String(row[ci.moq]).replace(/[^0-9]/g, ''), 10) || 20;
    var tiers = [];
    BANDS.forEach(function (b) {
      var p = b[0] >= 0 ? num_(row[b[0]]) : null;
      if (p) tiers.push({ min_qty: (b[1] === 20 ? moq : b[1]), max_qty: b[2], unit_price: p, gst_rate: gst });
    });
    var cat = category_(sku, name, brand, desc);
    products.push({
      sku: sku, name: name, category: cat, subcategory: brand || cat, brand: brand, description: desc,
      gender: String(row[ci.gender] || '').trim(), colors: colors_(desc), moq: moq, gst_rate: gst,
      tiers: tiers, base_price: tiers.length ? tiers[0].unit_price : 0, sizes: ['OS'], has_sizes: false,
      image: ci.img >= 0 ? String(row[ci.img] || '').trim() : '', active: true, related: [],
      event_tags: cat === 'Gift Box' ? ['kit'] : [],
    });
  }
  return {
    generated_at: new Date().toISOString(), brand: CFG.BRAND,
    categories: ['Apparel', 'Drinkware', 'Travel', 'Utilities', 'Tech'],
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
  var cache = CacheService.getScriptCache();
  var key = 'catalog_' + CFG.BRAND;
  var hit = cache.get(key);
  if (hit && !p.nocache) return jsonOut_(JSON.parse(hit), p.callback);
  var data = buildCatalog_();
  try { cache.put(key, JSON.stringify(data), CFG.CACHE_SECS); } catch (err) {}
  return jsonOut_(data, p.callback);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return jsonOut_({ ok: false, error: 'bad json' }); }
  if (CFG.TOKEN && body.token !== CFG.TOKEN) return jsonOut_({ ok: false, error: 'unauthorized' });
  if (body.fn !== 'kit_request') return jsonOut_({ ok: false, error: 'unknown fn' });
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG.KIT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CFG.KIT_SHEET);
    sh.appendRow(['Timestamp', 'Brand', 'Name', 'Work email', 'Notes / deadline', 'Items (summary)', 'Total qty', 'Items (JSON)']);
  }
  var items = body.items || [];
  var summary = items.map(function (it) { return it.qty + ' x ' + it.name + (it.sku ? ' [' + it.sku + ']' : ''); }).join('; ');
  var totalQty = items.reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
  sh.appendRow([new Date(), CFG.BRAND, body.name || '', body.email || '', body.notes || '', summary, totalQty, JSON.stringify(items)]);
  return jsonOut_({ ok: true });
}
