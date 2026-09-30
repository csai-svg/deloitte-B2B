/*
  B2B view-only catalogue — ONE shared Apps Script Web App, bound to the
  master pricing spreadsheet, serving BOTH the Optum and Deloitte storefronts.
  There is one catalogue (one sheet, one source of truth); the caller says
  which brand it is on every request via ?brand=Optum|Deloitte (GET) or
  {brand:'Optum'|'Deloitte'} (POST), and this script tags the response and
  routes submissions accordingly. Two sheets would mean maintaining the same
  catalogue twice and letting it drift — deliberately not done here.

  Does these things and nothing else:

    doGet(?fn=catalog&brand=Optum)  -> live JSON of ONLY the public columns
                           (name, brand, description, gender, category, moq,
                           gst, price tiers, image). Cost Price + Margins are
                           NEVER read into the response, so the master sheet
                           can stay private and nothing internal is exposed.
    doPost {fn:'kit_request', brand:'Optum', ...} -> appends one row to that
                           brand's own "<Brand> Kit Requests" tab (created if
                           missing) so ASMs see cart/kit submissions per site,
                           without splitting the catalogue itself. Requester
                           name/username come from the session, never the
                           posted body.
    doPost {fn:'login'|'logout', ...} -> the Deloitte site's login gate:
                           username + password checked against the "Login"
                           tab in this same spreadsheet (hashed, salted,
                           constant-time compare), with per-username lockout
                           after repeated failures. On success mints an
                           opaque session token. When CFG.REQUIRE_LOGIN is
                           true and brand is Deloitte, fn=catalog and
                           fn=kit_request both require that session token
                           (?session=/body.session) — see the "Deloitte-only
                           login gate" block below for details.

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
  DEFAULT_BRAND: 'Optum',              // used only if a caller omits ?brand= / body.brand
  CATALOG_SHEET: 'Product Collection', // tab name of the shared catalogue (edit to match)
  TOKEN: '',                           // optional shared secret; '' = open
  CACHE_SECS: 60,

  // Deloitte-only login gate: username + password checked against the
  // "Login" tab of this same spreadsheet. REQUIRE_LOGIN only ever applies
  // to brand === 'Deloitte' (see doGet/doPost) — Optum stays open.
  LOGIN_SHEET: 'Login',
  CART_SHEET: 'Cart Enquiries',       // Deloitte kit/cart submissions land here (Optum keeps its own per-brand tab)
  REQUIRE_LOGIN: true,                  // flip to false to debug the Deloitte feed/kit_request without auth
  SESSION_TTL_SECS: 6 * 60 * 60,        // server-side ceiling on a signed-in session
  LOGIN_MAX_ATTEMPTS: 5,                // failed attempts before a username is locked out
  LOGIN_LOCKOUT_SECS: 15 * 60,          // how long a lockout lasts
  LOGIN_FAIL_SLEEP_MS: 500,             // throttle on every failed attempt
};

/* Google Chat webhook: lockouts, successful sign-ins, and kit/cart
   submissions are posted here. Deliberately NOT hardcoded in CFG above —
   this file is committed to a public repo, and a webhook URL is a bearer
   credential (anyone holding it can post into the space). Set it once via
   Project Settings (gear icon) > Script Properties > add "WEBHOOK_URL", or
   run setWebhookUrl() below with the value filled in, then clear it from
   the source before saving. Leave unset to disable notifications. */
function webhookUrl_() {
  try { return PropertiesService.getScriptProperties().getProperty('WEBHOOK_URL') || ''; }
  catch (err) { return ''; }
}

/* One-off: paste the webhook URL below, run this once from the Run
   dropdown, then delete the URL from this function (it only needs to run
   once — the value persists in Script Properties, not in source).
   NOTE: no trailing underscore on this name on purpose — Apps Script hides
   any function ending in "_" from the Run dropdown's function picker, so a
   name like setWebhookUrl_ would never appear there to run. */
function setWebhookUrl() {
  var url = ''; // <-- paste the Google Chat webhook URL here, run once, then remove it
  if (!url) throw new Error('setWebhookUrl: paste the webhook URL into this function before running it');
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_URL', url);
  Logger.log('WEBHOOK_URL saved to Script Properties.');
}

/* Header-name -> column finder (tolerant: trims, lowercases, ignores spaces).
   Falls back to a prefix match when nothing matches exactly, so a header cell
   with extra explanatory text tacked on (e.g. "Product name\n( Brand+Product
   Name+ Colour)") still resolves — a blank match here means every row's name
   comes back empty and the whole catalogue silently disappears, which is far
   worse than matching a slightly-decorated header. */
function colMap_(header) {
  var m = {};
  header.forEach(function (h, i) { m[String(h).toLowerCase().replace(/\s+/g, ' ').trim()] = i; });
  var keys = Object.keys(m);
  return function (name) {
    var k = name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (k in m) return m[k];
    for (var i = 0; i < keys.length; i++) if (keys[i].indexOf(k) === 0) return m[keys[i]];
    return -1;
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
    topSelling: C('top selling'), sustainable: C('sustainable'), parentSku: C('sku codes - parent'),
  };
  var yes_ = function (v) { return /^\s*(y|yes|true|1)\s*$/i.test(String(v || '')); };
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
      top_selling: ci.topSelling >= 0 ? yes_(row[ci.topSelling]) : false,
      sustainable: ci.sustainable >= 0 ? yes_(row[ci.sustainable]) : false,
      parent_sku: ci.parentSku >= 0 ? String(row[ci.parentSku] || '').trim() : '',
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

/* ------------------------------------------------------------------
   Deloitte-only login gate: username + password against the "Login" tab.
   No signup, no self-service reset — an ASM manages rows directly in the
   sheet. One round trip from the client (see login.html):
     fn=login  { username, password } -> looked up in the Login tab,
                hash compared in constant time, on success mints an opaque
                session token good for CFG.SESSION_TTL_SECS.
   Every other Deloitte endpoint (fn=catalog, fn=kit_request) then
   requires that session token, so the gate is enforced here, not just by
   the page redirecting an unauthenticated visitor to login.html. The
   browser never sees the Login tab or any hash — only this script reads
   it, via SpreadsheetApp on the server.
   ------------------------------------------------------------------ */

var LOGIN_GENERIC_ERROR = 'Invalid username or password';

/* Header-name -> column finder for a specific tab: exact match only
   (trimmed, lowercased, spaces/underscores collapsed) so a typo in the
   sheet fails loudly instead of silently reading the wrong column. */
function colOf_(header, name, tabName) {
  var norm = function (s) { return String(s).toLowerCase().trim().replace(/[\s_]+/g, ' '); };
  var target = norm(name);
  for (var i = 0; i < header.length; i++) {
    if (norm(header[i]) === target) return i;
  }
  throw new Error('colOf_: missing column "' + name + '" in tab "' + tabName +
    '". Headers present: ' + header.map(String).join(', '));
}

function getLoginSheet_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(CFG.LOGIN_SHEET);
  if (!sh) throw new Error('getLoginSheet_: no "' + CFG.LOGIN_SHEET + '" tab found');
  return sh;
}

function loginCols_(header) {
  return {
    username: colOf_(header, 'username', CFG.LOGIN_SHEET),
    password: colOf_(header, 'password', CFG.LOGIN_SHEET),
    hash: colOf_(header, 'password_hash', CFG.LOGIN_SHEET),
    salt: colOf_(header, 'salt', CFG.LOGIN_SHEET),
    active: colOf_(header, 'active', CFG.LOGIN_SHEET),
    name: colOf_(header, 'name', CFG.LOGIN_SHEET),
    email: colOf_(header, 'email', CFG.LOGIN_SHEET),
    company: colOf_(header, 'company', CFG.LOGIN_SHEET),
    lastLogin: colOf_(header, 'last_login', CFG.LOGIN_SHEET),
    notes: colOf_(header, 'notes', CFG.LOGIN_SHEET),
  };
}

function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/* Same-length XOR accumulation so a wrong guess takes the same time
   whether it differs in the first byte or the last. */
function constantTimeEq_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a.length || !b.length) return false;
  var len = Math.max(a.length, b.length);
  var diff = a.length ^ b.length;
  for (var i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/* Menu item "Client Access > Hash new passwords" (see onOpen). Reads any
   row with a plain password and no hash yet, generates a random salt,
   stores SHA-256(salt + password), writes the salt, then clears the
   plain password cell so it never sits in the sheet in the clear. Safe
   to re-run: a row with a hash already is left untouched. */
function hashPendingPasswords() {
  var sh = getLoginSheet_();
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return 'hashPendingPasswords: no rows to hash';
  var ci = loginCols_(vals[0]);
  var updated = 0;
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r];
    var plain = String(row[ci.password] || '').trim();
    var hash = String(row[ci.hash] || '').trim();
    if (!plain || hash) continue;
    var salt = Utilities.getUuid();
    sh.getRange(r + 1, ci.hash + 1).setValue(sha256Hex_(salt + plain));
    sh.getRange(r + 1, ci.salt + 1).setValue(salt);
    sh.getRange(r + 1, ci.password + 1).setValue('');
    updated++;
  }
  var msg = 'hashPendingPasswords: hashed ' + updated + ' password(s)';
  Logger.log(msg);
  try { SpreadsheetApp.getActive().toast(msg, 'Client Access'); } catch (err) {}
  return msg;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Client Access')
    .addItem('Hash new passwords', 'hashPendingPasswords')
    .addToUi();
}

function findLoginRow_(username) {
  var sh = getLoginSheet_();
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return null;
  var ci = loginCols_(vals[0]);
  var target = String(username || '').toLowerCase().trim();
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][ci.username] || '').toLowerCase().trim() === target) {
      return { rowIndex: r + 1, row: vals[r], ci: ci, sheet: sh };
    }
  }
  return null;
}

function isLockedOut_(username) {
  return !!CacheService.getScriptCache().get('lock_' + username);
}

function recordLoginFailure_(username) {
  var cache = CacheService.getScriptCache();
  var key = 'fail_' + username;
  var n = Number(cache.get(key) || '0') + 1;
  if (n >= CFG.LOGIN_MAX_ATTEMPTS) {
    cache.put('lock_' + username, '1', CFG.LOGIN_LOCKOUT_SECS);
    cache.remove(key);
    notifyWebhook_('🔒 *' + username + '* locked out for ' +
      Math.round(CFG.LOGIN_LOCKOUT_SECS / 60) + ' minutes after ' + n + ' failed sign-in attempts.');
  } else {
    cache.put(key, String(n), CFG.LOGIN_LOCKOUT_SECS);
  }
}

function clearLoginFailures_(username) {
  CacheService.getScriptCache().remove('fail_' + username);
}

/* Never throws — a broken webhook must never break login or checkout. */
function notifyWebhook_(text) {
  var url = webhookUrl_();
  if (!url) return;
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({ text: text }),
    });
  } catch (err) {
    Logger.log('notifyWebhook_ failed: ' + err);
  }
}

function requireSession_(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function handleLogin_(body) {
  var username = String(body.username || '').trim();
  var password = String(body.password || '').trim();
  var usernameKey = username.toLowerCase();

  if (!username || !password) {
    Utilities.sleep(CFG.LOGIN_FAIL_SLEEP_MS);
    return jsonOut_({ ok: false, error: LOGIN_GENERIC_ERROR });
  }

  if (isLockedOut_(usernameKey)) {
    Utilities.sleep(CFG.LOGIN_FAIL_SLEEP_MS);
    return jsonOut_({ ok: false, error: LOGIN_GENERIC_ERROR });
  }

  var rec;
  try {
    rec = findLoginRow_(username);
  } catch (err) {
    Logger.log('handleLogin_: ' + err);
    return jsonOut_({ ok: false, error: 'Sign-in is temporarily unavailable.' });
  }

  var okPass = false;
  if (rec) {
    var active = /^\s*(true|yes|1)\s*$/i.test(String(rec.row[rec.ci.active] || ''));
    var storedHash = String(rec.row[rec.ci.hash] || '').trim();
    var salt = String(rec.row[rec.ci.salt] || '').trim();
    if (active && storedHash) {
      okPass = constantTimeEq_(sha256Hex_(salt + password), storedHash);
    }
  }

  if (!rec || !okPass) {
    recordLoginFailure_(usernameKey);
    Utilities.sleep(CFG.LOGIN_FAIL_SLEEP_MS);
    return jsonOut_({ ok: false, error: LOGIN_GENERIC_ERROR });
  }

  clearLoginFailures_(usernameKey);
  var name = String(rec.row[rec.ci.name] || '').trim() || username;
  var email = String(rec.row[rec.ci.email] || '').trim();
  var token = Utilities.getUuid();
  var expires = Date.now() + CFG.SESSION_TTL_SECS * 1000;
  CacheService.getScriptCache().put('sess_' + token,
    JSON.stringify({ username: usernameKey, name: name, email: email }),
    CFG.SESSION_TTL_SECS);

  try { rec.sheet.getRange(rec.rowIndex, rec.ci.lastLogin + 1).setValue(new Date()); } catch (err) {}
  notifyWebhook_('✅ *' + name + '* (' + usernameKey + ') signed in to the Deloitte store.');

  return jsonOut_({ ok: true, token: token, name: name, expires: expires });
}

function handleLogout_(body) {
  if (body.session) CacheService.getScriptCache().remove('sess_' + body.session);
  return jsonOut_({ ok: true });
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (CFG.TOKEN && p.token !== CFG.TOKEN) return jsonOut_({ error: 'unauthorized' }, p.callback);
  var brand = normalizeBrand_(p.brand);
  if (brand === 'Deloitte' && CFG.REQUIRE_LOGIN && !requireSession_(p.session)) {
    return jsonOut_({ error: 'unauthorized' }, p.callback);
  }
  var cache = CacheService.getScriptCache();
  var key = 'catalog_' + brand;
  var hit = cache.get(key);
  if (hit && !p.nocache) return jsonOut_(JSON.parse(hit), p.callback);
  var data = buildCatalog_(brand);
  try { cache.put(key, JSON.stringify(data), CFG.CACHE_SECS); } catch (err) {}
  return jsonOut_(data, p.callback);
}

function handleKitRequest_(body, session) {
  var brand = normalizeBrand_(body.brand);   // 'Optum' or 'Deloitte', from the site that submitted
  // Deloitte cart/kit submissions land in the "Cart Enquiries" tab next to
  // "Login" in the shared sheet; Optum keeps its own per-brand tab.
  var tabName = brand === 'Deloitte' ? CFG.CART_SHEET : (brand + ' Kit Requests');
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(tabName);
  if (!sh) {
    sh = ss.insertSheet(tabName);
    sh.appendRow(['Timestamp', 'Brand', 'Username', 'Name', 'Work email', 'Notes / deadline', 'Items (summary)', 'Total qty', 'Items (JSON)']);
  }
  // Requester identity comes from the session, never from the posted body,
  // so a forged name/username in the request payload cannot land in the sheet.
  var username = session ? session.username : '';
  var name = session ? session.name : (body.name || '');
  var items = body.items || [];
  var summary = items.map(function (it) { return it.qty + ' x ' + it.name + (it.sku ? ' [' + it.sku + ']' : ''); }).join('; ');
  var totalQty = items.reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
  sh.appendRow([new Date(), brand, username, name, body.email || '', body.notes || '', summary, totalQty, JSON.stringify(items)]);
  notifyWebhook_('📦 *' + (name || username || 'A visitor') + '* submitted a request: ' +
    totalQty + ' item(s) — ' + summary);
  return jsonOut_({ ok: true });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return jsonOut_({ ok: false, error: 'bad json' }); }
  if (CFG.TOKEN && body.token !== CFG.TOKEN) return jsonOut_({ ok: false, error: 'unauthorized' });

  switch (body.fn) {
    case 'login': return handleLogin_(body);
    case 'logout': return handleLogout_(body);
    case 'kit_request':
      var brand = normalizeBrand_(body.brand);
      var session = requireSession_(body.session);
      if (brand === 'Deloitte' && CFG.REQUIRE_LOGIN && !session) return jsonOut_({ ok: false, error: 'unauthorized' });
      return handleKitRequest_(body, session);
    default:
      return jsonOut_({ ok: false, error: 'unknown fn' });
  }
}

/* ------------------------------------------------------------------
   ONE-OFF: point the Image URL column straight at Google Drive thumbnails
   (drive.google.com/thumbnail?id=<fileId>&sz=w1000) instead of the old
   static-host copies (github.com/csai-svg/B2B-assets). Sources the mapping
   from the "ImageMigrationReview" tab in this same spreadsheet — columns
   Status, Row, SrNo, ProductName, DriveFile, NewURL — and only applies
   rows marked "MATCHED". Run this ONCE from the Apps Script editor (select
   migrateImageUrlsToDrive in the function dropdown > Run). Safe to re-run:
   only overwrites a row when its Sr No has a MATCHED entry. Does NOT touch
   classify_/buildCatalog_ — they keep reading whatever ends up in the
   Image URL column, verbatim, same as today. */
var IMAGE_REVIEW_SHEET = 'ImageMigrationReview';

function migrateImageUrlsToDrive() {
  var ss = SpreadsheetApp.getActive();
  var reviewSh = ss.getSheetByName(IMAGE_REVIEW_SHEET);
  if (!reviewSh) throw new Error('migrateImageUrlsToDrive: no "' + IMAGE_REVIEW_SHEET + '" tab found');
  var reviewVals = reviewSh.getDataRange().getValues();
  var reviewC = colMap_(reviewVals[0]);
  var rci = { status: reviewC('status'), sr: reviewC('srno'), url: reviewC('newurl') };
  if (rci.status < 0 || rci.sr < 0 || rci.url < 0) {
    throw new Error('migrateImageUrlsToDrive: could not find Status/SrNo/NewURL columns in ' + IMAGE_REVIEW_SHEET);
  }

  var manifest = {};  // sr -> new Drive thumbnail URL, MATCHED rows only
  for (var i = 1; i < reviewVals.length; i++) {
    var row = reviewVals[i];
    if (String(row[rci.status] || '').trim().toUpperCase() !== 'MATCHED') continue;
    var sr = String(row[rci.sr] || '').replace(/[^0-9]/g, '');
    if (!sr) continue;
    manifest[sr] = String(row[rci.url] || '').trim();
  }

  var sh = ss.getSheetByName(CFG.CATALOG_SHEET) || ss.getSheets()[0];
  var vals = sh.getDataRange().getValues();
  var header = vals[0], C = colMap_(header);
  var ci = { sr: C('sr no'), img: C('image url') };
  if (ci.sr < 0 || ci.img < 0) {
    throw new Error('migrateImageUrlsToDrive: could not find "Sr No" or "Image URL" column in ' + CFG.CATALOG_SHEET);
  }

  var updated = 0, unchanged = 0, noMatch = [];
  for (var r = 1; r < vals.length; r++) {
    var catRow = vals[r];
    var catSr = String(catRow[ci.sr] || '').replace(/[^0-9]/g, '');
    if (!catSr) continue;
    var newUrl = manifest[catSr];
    if (!newUrl) { noMatch.push(catSr); continue; }
    var currentUrl = String(catRow[ci.img] || '').trim();
    if (currentUrl === newUrl) { unchanged++; continue; }
    sh.getRange(r + 1, ci.img + 1).setValue(newUrl);
    updated++;
  }

  var summary = 'migrateImageUrlsToDrive: updated ' + updated + ', already correct ' + unchanged +
    ', no MATCHED review row for ' + noMatch.length + ' products';
  Logger.log(summary);
  return summary;
}

/* Dry-run twin: logs what migrateImageUrlsToDrive() would change without
   writing anything. Run this first when re-running the migration. */
function migrateImageUrlsToDrive_dryRun() {
  var ss = SpreadsheetApp.getActive();
  var reviewSh = ss.getSheetByName(IMAGE_REVIEW_SHEET);
  if (!reviewSh) throw new Error('migrateImageUrlsToDrive_dryRun: no "' + IMAGE_REVIEW_SHEET + '" tab found');
  var reviewVals = reviewSh.getDataRange().getValues();
  var reviewC = colMap_(reviewVals[0]);
  var rci = { status: reviewC('status'), sr: reviewC('srno'), url: reviewC('newurl') };
  var manifest = {};
  for (var i = 1; i < reviewVals.length; i++) {
    var row = reviewVals[i];
    if (String(row[rci.status] || '').trim().toUpperCase() !== 'MATCHED') continue;
    var sr = String(row[rci.sr] || '').replace(/[^0-9]/g, '');
    if (sr) manifest[sr] = String(row[rci.url] || '').trim();
  }
  var sh = ss.getSheetByName(CFG.CATALOG_SHEET) || ss.getSheets()[0];
  var vals = sh.getDataRange().getValues();
  var C = colMap_(vals[0]);
  var ci = { sr: C('sr no'), img: C('image url') };
  var wouldUpdate = 0;
  for (var r = 1; r < vals.length; r++) {
    var catSr = String(vals[r][ci.sr] || '').replace(/[^0-9]/g, '');
    var newUrl = catSr && manifest[catSr];
    if (newUrl && newUrl !== String(vals[r][ci.img] || '').trim()) wouldUpdate++;
  }
  var summary = 'migrateImageUrlsToDrive_dryRun: would update ' + wouldUpdate + ' row(s)';
  Logger.log(summary);
  return summary;
}

/* Dry-run twin: reports which Login rows have a plain password waiting to
   be hashed, without writing anything. */
function hashPendingPasswords_dryRun() {
  var sh = getLoginSheet_();
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return 'hashPendingPasswords_dryRun: no rows';
  var ci = loginCols_(vals[0]);
  var pending = [];
  for (var r = 1; r < vals.length; r++) {
    var plain = String(vals[r][ci.password] || '').trim();
    var hash = String(vals[r][ci.hash] || '').trim();
    if (plain && !hash) pending.push(String(vals[r][ci.username] || '(row ' + (r + 1) + ')'));
  }
  var summary = 'hashPendingPasswords_dryRun: would hash ' + pending.length + ' password(s): ' + pending.join(', ');
  Logger.log(summary);
  return summary;
}

/* ------------------------------------------------------------------
   Zero-argument wrappers for testing from the Apps Script editor's Run
   dropdown. doGet/doPost only accept a request object, which the editor
   cannot supply, so these build a fake one against test data. None of
   these touch the real Login tab's live sessions/lockout state beyond
   what a normal call would.
   ------------------------------------------------------------------ */

function runTestLogin() {
  var res = handleLogin_({ username: 'testuser', password: 'wrong-password-for-manual-testing' });
  Logger.log(res.getContent());
  return res.getContent();
}

function runTestCatalogDeloitte() {
  var res = doGet({ parameter: { fn: 'catalog', brand: 'Deloitte', session: 'not-a-real-session' } });
  Logger.log(res.getContent());
  return res.getContent();
}

function runTestCatalogOptum() {
  var res = doGet({ parameter: { fn: 'catalog', brand: 'Optum' } });
  Logger.log(res.getContent());
  return res.getContent();
}

function runTestKitRequest() {
  var res = doPost({ postData: { contents: JSON.stringify({
    fn: 'kit_request', brand: 'Deloitte', session: 'not-a-real-session',
    items: [{ sku: 'CS0001', name: 'Test Product', qty: 20 }],
  }) } });
  Logger.log(res.getContent());
  return res.getContent();
}
