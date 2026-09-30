/* Agent Merch — internal kit-builder + PDF quotation tool for CompanyStore
   sales agents. Loaded only by agent.html, which is itself gated (session +
   features.agentMerch) before this file ever runs. Sources its product pool
   from the same Catalog the storefront uses (Catalog.allProducts) — there is
   no second data path and no bundled catalogue file. */

const AgentApp = (function () {
  const TAGS = ['Top Selling', 'Sustainable'];
  const COLLECTION_PAGE_SIZE = 16;

  const state = {
    kits: [],
    requiredProducts: [],   // array of sku
    lastConfig: null,
    usedCombos: new Set(),
    showOnlySelected: false,
    currentQuoteId: '',
    currentQuoteClient: '',
  };

  /* --------------------------------------------------------------- pricing */

  function sellPrice(p, qtyPerKit, markupPct) {
    const base = unitAt(p, qtyPerKit);
    return base * (1 + (Number(markupPct) || 0) / 100);
  }

  function priced(p, cfg) {
    return Object.assign({}, p, {
      _uid: p.sku + ':' + Math.random().toString(36).slice(2, 8),
      _price: sellPrice(p, cfg.qtyPerKit, cfg.markupPct),
    });
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    renderCategoryChecks();
    renderTagChecks();
    renderEventTagChecks();
    renderRequiredList();
    renderHistory();

    document.getElementById('btnGenerate').addEventListener('click', onGenerate);
    document.getElementById('btnCollections').addEventListener('click', onCollections);
    document.getElementById('btnManualKit').addEventListener('click', onManualKit);
    document.getElementById('btnReset').addEventListener('click', onReset);
    document.getElementById('btnPickRequired').addEventListener('click', onPickRequired);
    document.getElementById('btnSelectAll').addEventListener('click', () => setAllIncluded(true));
    document.getElementById('btnDeselectAll').addEventListener('click', () => setAllIncluded(false));
    document.getElementById('btnShowSelected').addEventListener('click', toggleShowSelected);
    document.getElementById('btnLoadMore').addEventListener('click', onLoadMore);
    document.getElementById('btnExportPdf').addEventListener('click', exportToPdf);
    document.getElementById('btnClearHistory').addEventListener('click', clearAllHistory);
  }

  function readConfig() {
    const num = id => Number(document.getElementById(id).value) || 0;
    const checked = sel => Array.from(document.querySelectorAll(sel + ' input:checked')).map(i => i.value);
    return {
      budget: num('cfgBudget'),
      minKitPrice: num('cfgMinPrice'),
      maxKitPrice: num('cfgMaxPrice'),
      kitCount: num('cfgKitCount'),
      productsPerKit: num('cfgProductsPerKit'),
      qtyPerKit: Math.max(1, num('cfgQtyPerKit') || 1),
      markupPct: num('cfgMarkup'),
      maxMOQ: num('cfgMaxMOQ'),
      hidePrices: document.getElementById('cfgHidePrices').checked,
      catMode: document.getElementById('cfgCatMode').checked ? 'AND' : 'OR',
      categories: checked('#cfgCategories'),
      tags: checked('#cfgTags'),
      eventTags: checked('#cfgEventTags'),
    };
  }

  function renderCategoryChecks() {
    const wrap = document.getElementById('cfgCategories');
    wrap.innerHTML = '';
    Catalog.categories.forEach(c => {
      wrap.appendChild(el('label', {}, el('input', { type: 'checkbox', value: c.slug }), c.label));
    });
  }
  function renderTagChecks() {
    const wrap = document.getElementById('cfgTags');
    wrap.innerHTML = '';
    TAGS.forEach(t => wrap.appendChild(el('label', {}, el('input', { type: 'checkbox', value: t }), t)));
  }
  function renderEventTagChecks() {
    const wrap = document.getElementById('cfgEventTags');
    wrap.innerHTML = '';
    const tags = new Set();
    Catalog.allProducts.forEach(p => (p.event_tags || []).forEach(t => tags.add(t)));
    if (!tags.size) { wrap.appendChild(el('span', { class: 'small muted' }, 'No event-tagged products in the catalogue yet.')); return; }
    [...tags].sort().forEach(t => wrap.appendChild(el('label', {}, el('input', { type: 'checkbox', value: t }), t)));
  }

  /* -------------------------------------------------------- required products */

  function renderRequiredList() {
    const wrap = document.getElementById('requiredProductsList');
    wrap.innerHTML = '';
    if (!state.requiredProducts.length) {
      wrap.appendChild(el('span', { class: 'small muted' }, 'None selected.'));
      return;
    }
    state.requiredProducts.forEach(sku => {
      const p = Catalog.bySku(sku);
      if (!p) return;
      wrap.appendChild(el('div', { class: 'am-req-chip' },
        p.name,
        el('button', { type: 'button', onclick: () => { state.requiredProducts = state.requiredProducts.filter(s => s !== sku); renderRequiredList(); } }, '×')));
    });
  }

  function onPickRequired() {
    openProductPicker({
      title: 'Select required products',
      onPick(p) {
        if (!state.requiredProducts.includes(p.sku)) state.requiredProducts.push(p.sku);
        renderRequiredList();
      },
    });
  }

  /* ---------------------------------------------------------- product pool */

  function basePool(cfg) {
    let pool = Catalog.allProducts.filter(hasPrice);
    if (cfg.maxMOQ) pool = pool.filter(p => p.moq <= cfg.maxMOQ);
    if (cfg.tags.length) {
      pool = pool.filter(p =>
        (cfg.tags.includes('Top Selling') && p.top_selling) ||
        (cfg.tags.includes('Sustainable') && p.sustainable));
    }
    if (cfg.eventTags.length) pool = pool.filter(p => (p.event_tags || []).some(t => cfg.eventTags.includes(t)));
    if (cfg.categories.length && cfg.catMode === 'OR') pool = pool.filter(p => cfg.categories.includes(p.category));
    return pool.map(p => priced(p, cfg));
  }

  /* ------------------------------------------------------------ generation */

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildSingleKit(pool, budget, maxProd, forcedCats) {
    const usedCats = new Set();
    const items = [];
    let spent = 0;

    for (const cat of forcedCats) {
      const candidates = shuffle(pool.filter(p => p.category === cat && !usedCats.has(p.category) && spent + p._price <= budget));
      if (!candidates.length) return null;
      const pick = candidates[0];
      items.push(pick); usedCats.add(pick.category); spent += pick._price;
    }

    const remainingSlots = Math.max(0, maxProd - items.length);
    for (let i = 0; i < remainingSlots; i++) {
      const candidates = shuffle(pool.filter(p => !usedCats.has(p.category) && spent + p._price <= budget)).slice(0, 5);
      if (!candidates.length) break;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      items.push(pick); usedCats.add(pick.category); spent += pick._price;
    }

    return items.length ? { products: items, total: spent } : null;
  }

  function comboKey(items) { return items.map(p => p.sku).sort().join('|'); }

  function createOptimalKits(pool, budget, kitCount, productsPerKit, forcedCats, usedCombos) {
    const targetCount = kitCount || 10;
    const targetSize = productsPerKit || Math.min(8, Math.max(3, Math.round(pool.length / Math.max(1, targetCount))));
    const out = [];
    const attempts = targetCount * 60;
    for (let i = 0; i < attempts && out.length < targetCount; i++) {
      const kit = buildSingleKit(pool, budget || Infinity, targetSize, forcedCats);
      if (!kit) continue;
      const key = comboKey(kit.products);
      if (usedCombos.has(key)) continue;
      usedCombos.add(key);
      out.push(kit);
    }
    out.sort((a, b) => b.products.length - a.products.length || b.total - a.total);
    return out;
  }

  function nextKitName() { return 'Kit ' + (state.kits.length + 1); }

  function finalizeKit(products, cfg, opts) {
    return Object.assign({
      id: 'k' + Date.now() + Math.random().toString(36).slice(2, 6),
      name: nextKitName(),
      products,
      includeInPdf: true,
      isCollection: false,
      isManual: false,
      visibleCount: COLLECTION_PAGE_SIZE,
      sel: new Set(),
    }, opts || {});
  }

  function kitTotal(kit) { return kit.products.reduce((s, p) => s + (p._price || 0), 0); }

  function onGenerate() {
    const cfg = readConfig();
    if (!cfg.budget && !cfg.maxKitPrice) { toast('Enter a budget per kit or a max kit price.', 'error'); return; }
    const ceiling = cfg.budget || cfg.maxKitPrice;

    const reqProducts = state.requiredProducts.map(sku => {
      const p = Catalog.bySku(sku);
      return p ? priced(p, cfg) : null;
    }).filter(Boolean);
    const reqCost = reqProducts.reduce((s, p) => s + p._price, 0);
    if (reqCost > ceiling) { toast('Required products alone exceed the budget.', 'error'); return; }

    const remainingBudget = ceiling - reqCost;
    const effectiveProductsPerKit = cfg.productsPerKit ? Math.max(1, cfg.productsPerKit - reqProducts.length) : 0;
    const forcedCats = cfg.catMode === 'AND' ? cfg.categories : [];
    const reqSkus = new Set(reqProducts.map(p => p.sku));
    const available = basePool(cfg).filter(p => !reqSkus.has(p.sku));

    state.usedCombos = new Set();
    const fillers = createOptimalKits(available, remainingBudget, cfg.kitCount, effectiveProductsPerKit, forcedCats, state.usedCombos);

    let kits = fillers.map(k => finalizeKit([...reqProducts, ...k.products], cfg));
    if (cfg.minKitPrice || cfg.maxKitPrice) {
      kits = kits.filter(k => {
        const t = kitTotal(k);
        return (!cfg.minKitPrice || t >= cfg.minKitPrice) && (!cfg.maxKitPrice || t <= cfg.maxKitPrice);
      });
    }
    if (!kits.length && reqProducts.length) kits = [finalizeKit(reqProducts, cfg, { name: 'Required Items Kit' })];

    if (!kits.length) {
      toast('No combination fits those filters — try relaxing budget, categories, or MOQ.', 'error');
      return;
    }

    kits.forEach((k, i) => { k.name = 'Kit ' + (i + 1); });
    state.kits = kits;
    state.lastConfig = cfg;
    render();
    addToHistory(cfg);
    logEvent('generate', { kit_count: kits.length, budget: ceiling, qty_per_kit: cfg.qtyPerKit, markup_pct: cfg.markupPct });
  }

  function onLoadMore() {
    if (!state.lastConfig) return;
    const cfg = state.lastConfig;
    const ceiling = cfg.budget || cfg.maxKitPrice;
    const reqSkus = new Set(state.requiredProducts);
    const reqProducts = state.requiredProducts.map(sku => Catalog.bySku(sku)).filter(Boolean).map(p => priced(p, cfg));
    const reqCost = reqProducts.reduce((s, p) => s + p._price, 0);
    const remainingBudget = ceiling - reqCost;
    const effectiveProductsPerKit = cfg.productsPerKit ? Math.max(1, cfg.productsPerKit - reqProducts.length) : 0;
    const forcedCats = cfg.catMode === 'AND' ? cfg.categories : [];
    const available = basePool(cfg).filter(p => !reqSkus.has(p.sku));

    const more = createOptimalKits(available, remainingBudget, 5, effectiveProductsPerKit, forcedCats, state.usedCombos)
      .map(k => finalizeKit([...reqProducts, ...k.products], cfg));
    if (!more.length) { toast('No further unique combinations found.', 'info'); return; }
    state.kits = state.kits.concat(more);
    // Number only the generatable kits, sequentially among themselves —
    // using their raw position in state.kits (which also holds any manual
    // kit or collection interleaved by the agent) produced gaps/skips in
    // the visible "Kit N" numbering as soon as anything else was mixed in.
    let n = 0;
    state.kits.forEach(k => {
      if (k.isCollection || k.isManual) return;
      n++;
      if (k.name.startsWith('Kit ')) k.name = 'Kit ' + n;
    });
    render();
  }

  function onCollections() {
    const cfg = readConfig();
    const pool = basePool(cfg);
    const cats = cfg.categories.length ? cfg.categories : Catalog.categories.map(c => c.slug);
    const kits = cats.map(cat => {
      const items = pool.filter(p => p.category === cat).sort((a, b) => a._price - b._price);
      if (!items.length) return null;
      return finalizeKit(items, cfg, { name: cat + ' Collection', isCollection: true });
    }).filter(Boolean);
    if (!kits.length) { toast('No products match those filters.', 'error'); return; }
    state.kits = kits;
    state.lastConfig = cfg;
    render();
    addToHistory(cfg);
    logEvent('generate', { kit_count: kits.length, mode: 'collections' });
  }

  function onManualKit() {
    const cfg = readConfig();
    const kit = finalizeKit([], cfg, { name: 'Manual Kit', isManual: true });
    state.kits.push(kit);
    render();
  }

  function onReset() {
    if (state.kits.length && !confirm('Clear all generated kits?')) return;
    state.kits = [];
    state.requiredProducts = [];
    state.lastConfig = null;
    state.usedCombos = new Set();
    renderRequiredList();
    render();
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    const section = document.getElementById('resultsSection');
    const list = document.getElementById('kitList');
    const loadMoreBtn = document.getElementById('btnLoadMore');
    section.style.display = state.kits.length ? '' : 'none';
    list.innerHTML = '';
    if (!state.kits.length) return;

    const hasGeneratable = state.kits.some(k => !k.isCollection && !k.isManual);
    loadMoreBtn.style.display = hasGeneratable ? '' : 'none';

    const total = state.kits.length;
    const selected = state.kits.filter(k => k.includeInPdf).length;
    document.getElementById('resultsSummary').textContent =
      total + ' kit(s) generated, ' + selected + ' selected for PDF.';

    // Hiding prices is a pure display toggle, independent of the prices
    // computed at generation time — read it live (once per render, shared
    // by every kit card) so flipping the checkbox takes effect immediately
    // with no need to regenerate the kits.
    const cfg = Object.assign({}, state.lastConfig || readConfig(), { hidePrices: isHidePricesOn() });
    state.kits.forEach((kit, idx) => {
      if (state.showOnlySelected && !kit.includeInPdf) return;
      list.appendChild(renderKitCard(kit, idx, cfg));
    });
  }

  function isHidePricesOn() { return document.getElementById('cfgHidePrices').checked; }

  function renderKitCard(kit, idx, cfg) {
    const products = kit.isCollection ? kit.products.slice(0, kit.visibleCount) : kit.products;

    const card = el('div', { class: 'am-kit' },
      el('div', { class: 'am-kit-head' },
        el('div', { class: 'row', style: 'gap:10px' },
          el('label', { class: 'row small', style: 'gap:6px' },
            el('input', {
              type: 'checkbox', checked: kit.includeInPdf ? 'checked' : null,
              onchange: e => { kit.includeInPdf = e.target.checked; render(); },
            }), 'Include in PDF'),
          el('span', {
            class: 'am-kit-name', onclick: () => {
              const name = prompt('Rename kit', kit.name);
              if (name && name.trim()) { kit.name = name.trim(); render(); }
            },
          }, kit.name)),
        el('div', { class: 'am-kit-actions' },
          el('button', { type: 'button', title: 'Move up', onclick: () => moveKit(idx, -1) }, '↑'),
          el('button', { type: 'button', title: 'Move down', onclick: () => moveKit(idx, 1) }, '↓'),
          el('button', { type: 'button', onclick: () => openAddProduct(kit) }, 'Add product'),
          el('button', { type: 'button', onclick: () => openManualProduct(kit) }, 'Add manual product'),
          el('button', { type: 'button', onclick: () => { state.kits.splice(idx, 1); render(); } }, 'Delete kit'))));

    if (kit.sel.size) {
      card.appendChild(el('div', { class: 'am-bulkbar' },
        kit.sel.size + ' selected',
        el('button', { type: 'button', onclick: () => bulkReplace(kit) }, 'Replace selected'),
        el('button', { type: 'button', onclick: () => bulkDelete(kit) }, 'Delete selected'),
        el('button', { type: 'button', onclick: () => { kit.products = kit.products.filter(p => kit.sel.has(p._uid)); kit.sel = new Set(); render(); } }, 'Keep only selected'),
        el('button', { type: 'button', onclick: () => { kit.sel = new Set(); render(); } }, 'Clear selection')));
    }

    card.appendChild(el('div', { class: 'am-product-grid' }, products.map(p => renderProductCard(p, kit, cfg))));

    if (kit.isCollection && kit.products.length > kit.visibleCount) {
      card.appendChild(el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', style: 'margin-top:10px',
        onclick: () => { kit.visibleCount += COLLECTION_PAGE_SIZE; render(); },
      }, 'Load more products'));
    }

    if (!kit.isCollection && !cfg.hidePrices) {
      card.appendChild(el('div', { class: 'am-kit-total' }, 'Total: ' + money(kitTotal(kit)) + ' + GST + Freight'));
    }
    return card;
  }

  function renderProductCard(p, kit, cfg) {
    const siblingCount = (p.colorway && p.colorway.siblings ? p.colorway.siblings.length : 0);
    return el('div', { class: 'am-pcard' + (p._pending ? ' pending' : '') },
      p._pending ? el('span', { class: 'am-badge-pending' }, 'PENDING') : null,
      el('input', {
        type: 'checkbox', class: 'sel', checked: kit.sel.has(p._uid) ? 'checked' : null,
        onchange: e => { if (e.target.checked) kit.sel.add(p._uid); else kit.sel.delete(p._uid); render(); },
      }),
      el('img', { src: imgAt(p.image, 300), alt: p.name }),
      el('div', { class: 'name' }, p.name),
      el('div', { class: 'meta' }, (p.sku || 'MANUAL') + ' · MOQ ' + qty(p.moq || 0)),
      p._isManual && p.description ? el('div', { class: 'meta' }, p.description) : null,
      cfg.hidePrices ? null : el('div', { class: 'price' }, money(p._price)),
      el('div', { class: 'row' },
        siblingCount ? el('button', { type: 'button', onclick: () => openVariants(p, kit) }, 'Show Variants (' + siblingCount + ')') : null,
        p._pending ? null : el('button', { type: 'button', onclick: () => replaceProduct(p, kit) }, 'Replace'),
        el('button', { type: 'button', onclick: () => { kit.products = kit.products.filter(x => x._uid !== p._uid); kit.sel.delete(p._uid); render(); } }, 'Delete')));
  }

  function moveKit(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= state.kits.length) return;
    [state.kits[idx], state.kits[j]] = [state.kits[j], state.kits[idx]];
    render();
  }

  function setAllIncluded(val) { state.kits.forEach(k => { k.includeInPdf = val; }); render(); }
  function toggleShowSelected() { state.showOnlySelected = !state.showOnlySelected; render(); }

  function bulkReplace(kit) {
    const cfg = state.lastConfig || readConfig();
    const cats = new Set(kit.products.filter(p => kit.sel.has(p._uid)).map(p => p.category));
    // Tracks SKUs already spoken for — both the kit's untouched products and
    // whatever this pass has already handed out — so two selected slots in
    // the same category can never be assigned the same replacement (which
    // would also leave them sharing one _uid, since map() would otherwise
    // reuse the very same pool object reference for both).
    const usedSkus = new Set(kit.products.filter(p => !kit.sel.has(p._uid)).map(p => p.sku));
    const pool = basePool(cfg).filter(p => cats.has(p.category));
    kit.products = kit.products.map(p => {
      if (!kit.sel.has(p._uid)) return p;
      const candidates = pool.filter(x => x.category === p.category && !usedSkus.has(x.sku));
      if (!candidates.length) return p;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      usedSkus.add(pick.sku);
      return priced(pick, cfg); // fresh copy + fresh _uid, never the shared pool reference
    });
    kit.sel = new Set();
    render();
  }
  function bulkDelete(kit) {
    kit.products = kit.products.filter(p => !kit.sel.has(p._uid));
    kit.sel = new Set();
    render();
  }
  function replaceProduct(p, kit) {
    const cfg = state.lastConfig || readConfig();
    const pool = basePool(cfg).filter(x => x.category === p.category && !kit.products.some(k => k.sku === x.sku));
    if (!pool.length) { toast('No other product available in this category.', 'info'); return; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    kit.products = kit.products.map(x => x._uid === p._uid ? pick : x);
    render();
  }

  function openVariants(p, kit) {
    const siblings = (p.colorway.siblings || []).map(s => Catalog.bySku(s.sku)).filter(Boolean);
    openModal('Variants of ' + p.name, siblings, sib => {
      const cfg = state.lastConfig || readConfig();
      kit.products = kit.products.map(x => x._uid === p._uid ? priced(sib, cfg) : x);
      closeModal(); render();
    });
  }

  /* ------------------------------------------------------------- pickers */

  function openAddProduct(kit) {
    openProductPicker({
      title: 'Add product to ' + kit.name,
      excludeSkus: kit.products.map(p => p.sku),
      onPick(p) {
        const cfg = state.lastConfig || readConfig();
        kit.products.push(priced(p, cfg));
        closeModal();
        render();
      },
    });
  }

  function openProductPicker(opts) {
    const exclude = new Set(opts.excludeSkus || []);
    let pool = Catalog.allProducts.filter(p => !exclude.has(p.sku));
    openModal(opts.title, pool, opts.onPick);
  }

  let modalEl = null;
  function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }

  function openModal(title, products, onPick) {
    closeModal();
    let q = '', catFilter = '';
    const grid = el('div', { class: 'am-modal-grid' });
    const paint = () => {
      grid.innerHTML = '';
      const filtered = products.filter(p =>
        (!q || p.name.toLowerCase().includes(q.toLowerCase())) &&
        (!catFilter || p.category === catFilter));
      filtered.slice(0, 200).forEach(p => {
        grid.appendChild(el('button', { type: 'button', class: 'am-modal-pcard', onclick: () => onPick(p) },
          el('img', { src: imgAt(p.image, 200), alt: p.name }),
          el('div', { class: 'small', style: 'font-weight:700' }, p.name),
          el('div', { class: 'small muted' }, p.sku + ' · MOQ ' + qty(p.moq))));
      });
      if (!filtered.length) grid.appendChild(el('p', { class: 'muted small' }, 'No products match.'));
    };
    const cats = [...new Set(products.map(p => p.category))].sort();
    const overlay = el('div', {
      class: 'am-modal-overlay', onclick: e => { if (e.target === overlay) closeModal(); },
    }, el('div', { class: 'am-modal' },
      el('div', { class: 'am-modal-head' },
        el('h3', { style: 'margin:0' }, title),
        el('button', { type: 'button', onclick: closeModal }, '×')),
      el('div', { class: 'row', style: 'gap:10px;margin-bottom:12px;flex-wrap:wrap' },
        el('input', { type: 'text', placeholder: 'Search…', style: 'max-width:220px', oninput: debounce_(e => { q = e.target.value; paint(); }, 200) }),
        el('select', { onchange: e => { catFilter = e.target.value; paint(); } },
          el('option', { value: '' }, 'All categories'),
          cats.map(c => el('option', { value: c }, c)))),
      grid));
    document.body.appendChild(overlay);
    modalEl = overlay;
    paint();
  }

  /* ------------------------------------------------------------ manual product */

  function openManualProduct(kit) {
    closeModal();
    const nameI = el('input', { type: 'text', placeholder: 'Product name' });
    const moqI = el('input', { type: 'number', min: '0', value: '20' });
    const descI = el('textarea', { placeholder: 'Description', rows: '2' });
    const imgI = el('input', { type: 'text', placeholder: 'Image URL (optional)' });
    const priceI = el('input', { type: 'number', min: '0', placeholder: 'Price (optional)' });
    const overlay = el('div', { class: 'am-modal-overlay', onclick: e => { if (e.target === overlay) closeModal(); } },
      el('div', { class: 'am-modal', style: 'max-width:480px' },
        el('div', { class: 'am-modal-head' },
          el('h3', { style: 'margin:0' }, 'Add manual product'),
          el('button', { type: 'button', onclick: closeModal }, '×')),
        el('p', { class: 'small muted' }, 'Added to this deck only and flagged pending review. It is not added to the catalogue.'),
        el('label', { class: 'field' }, el('span', {}, 'Name'), nameI),
        el('label', { class: 'field' }, el('span', {}, 'MOQ'), moqI),
        el('label', { class: 'field' }, el('span', {}, 'Description'), descI),
        el('label', { class: 'field' }, el('span', {}, 'Image URL'), imgI),
        el('label', { class: 'field' }, el('span', {}, 'Price'), priceI),
        el('button', {
          class: 'btn btn-block', type: 'button', onclick: () => {
            const name = nameI.value.trim();
            if (!name) { toast('Enter a product name.', 'error'); return; }
            const manual = {
              sku: '', name, moq: Number(moqI.value) || 0, category: 'Custom', description: descI.value.trim(),
              image: imgI.value.trim() || PLACEHOLDER_IMG, tiers: [], base_price: Number(priceI.value) || 0,
              _uid: 'manual:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8),
              _price: Number(priceI.value) || 0, _pending: true, _isManual: true,
            };
            kit.products.push(manual);
            closeModal(); render();
            logEvent('manual_add', { product_name: name, moq: manual.moq, has_price: !!manual._price });
          },
        }, 'Add to kit')));
    document.body.appendChild(overlay);
    modalEl = overlay;
  }

  /* --------------------------------------------------------------------- PDF */

  const imageCache = new Map();
  function fetchWithTimeout(url, timeout) {
    return Promise.race([
      fetch(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
    ]);
  }
  async function readAsDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  /* Drive/other remote images are cross-origin without CORS headers, which
     would taint a canvas if drawn directly — routing through images.weserv.nl
     (permissive CORS) and converting to base64 sidesteps that without needing
     a new gated Apps Script endpoint. Any failure — timeout, bad URL, network
     — falls back to a blank placeholder rather than aborting the export. */
  async function getImageBase64(url) {
    if (!url) return null;
    if (imageCache.has(url)) return imageCache.get(url);
    if (url.startsWith('data:')) { imageCache.set(url, url); return url; }
    // Same-origin assets (the logo, a placeholder) never need the proxy —
    // and weserv can't resolve a relative path anyway — so fetch those
    // directly; only cross-origin product photos (Drive) go through it.
    const isSameOrigin = !/^https?:\/\//i.test(url) || url.startsWith(location.origin);
    try {
      let resp;
      if (isSameOrigin) {
        resp = await fetchWithTimeout(url, 10000);
      } else {
        const proxied = 'https://images.weserv.nl/?w=500&h=500&fit=contain&output=png&url=' + encodeURIComponent(url.replace(/^https?:\/\//, ''));
        resp = await fetchWithTimeout(proxied, 10000);
      }
      if (!resp.ok) throw new Error('bad status');
      const blob = await resp.blob();
      const b64 = await readAsDataURL(blob);
      imageCache.set(url, b64);
      return b64;
    } catch (err) {
      imageCache.set(url, null);
      return null;
    }
  }

  function newQuoteId() {
    const d = new Date();
    const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    return 'Q-' + ymd + '-' + suffix;
  }

  function fmtPdf(n) { return 'Rs. ' + Math.round(n).toLocaleString('en-IN'); }

  async function exportToPdf() {
    const selectedKits = state.kits.filter(k => k.includeInPdf);
    if (!selectedKits.length) { toast('Select at least one kit to include in the PDF.', 'error'); return; }
    const clientName = document.getElementById('clientNameInput').value.trim();
    if (!clientName) { toast('Enter a client name before exporting.', 'error'); return; }
    const title = document.getElementById('pdfTitleInput').value.trim() || 'Kit Suggestions';
    const includeLogo = document.getElementById('includeLogoCheckbox').checked;
    const cfg = state.lastConfig || readConfig();
    // Read live, same reasoning as render() — it's a display toggle, not
    // something that requires regenerating the kits to take effect.
    const noPrice = isHidePricesOn();

    if (!state.currentQuoteId) state.currentQuoteId = newQuoteId();
    state.currentQuoteClient = clientName;
    const quoteId = state.currentQuoteId;

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 15;
    const contentW = pageW - margin * 2;
    const footerLines = Site.get('pdfFooter', []);
    let logoB64 = null;
    // Fetch every distinct product image in parallel before laying out any
    // page — getImageBase64 already caches by URL, so a serial await inside
    // the nested kit/product loop below would make export time scale with
    // product count x network latency instead of the slowest single fetch.
    const distinctUrls = new Set();
    selectedKits.forEach(k => k.products.forEach(p => { if (p.image) distinctUrls.add(p.image); }));
    const prefetch = [...distinctUrls].map(url => getImageBase64(url));
    if (includeLogo) prefetch.push(getImageBase64(Site.get('logo_url', 'assets/brand/logo.png')).then(b64 => { logoB64 = b64; }));
    await Promise.all(prefetch);

    let page = 1;
    function addHeader(kitTitle) {
      if (logoB64) { try { pdf.addImage(logoB64, 'PNG', margin, 10, 42, 10); } catch (e) {} }
      pdf.setFontSize(14); pdf.setTextColor(60); pdf.setFont(undefined, 'bold');
      pdf.text(title, pageW - margin, 14, { align: 'right' });
      pdf.setFontSize(9); pdf.setFont(undefined, 'normal'); pdf.setTextColor(100);
      pdf.text('Quote ' + quoteId + '  ·  ' + new Date().toLocaleDateString('en-IN'), pageW - margin, 19, { align: 'right' });
      pdf.text('Prepared for: ' + clientName + '  ·  Prepared by: ' + ((Auth.user() || {}).name || ''), margin, 19);
      pdf.setFillColor(128, 128, 128); pdf.rect(margin, 32, contentW, 10, 'F');
      pdf.setTextColor(255); pdf.setFontSize(12); pdf.setFont(undefined, 'bold');
      pdf.text(kitTitle, pageW / 2, 39, { align: 'center' });
      pdf.setTextColor(0); pdf.setFont(undefined, 'normal');
    }
    function addFooter() {
      pdf.setDrawColor(220); pdf.line(margin, pageH - 40, pageW - margin, pageH - 40);
      pdf.setFontSize(7.5); pdf.setTextColor(110);
      footerLines.forEach((line, i) => pdf.text(String(line), margin, pageH - 35 + i * 4));
      pdf.setFontSize(8); pdf.text('Page ' + page, pageW - margin, pageH - 8, { align: 'right' });
      pdf.setTextColor(0);
    }

    const cardW = 85, cardH = 80, gapX = 10, gapY = 10, imgH = 55;
    for (let ki = 0; ki < selectedKits.length; ki++) {
      const kit = selectedKits[ki];
      addHeader(kit.name);
      let col = 0, row = 0, rowY = 50;
      for (let pi = 0; pi < kit.products.length; pi++) {
        const p = kit.products[pi];
        if (col === 2) { col = 0; row++; }
        if (row === 2) {
          addFooter(); pdf.addPage(); page++;
          addHeader(kit.name); row = 0; col = 0; rowY = 50;
        }
        const x = margin + col * (cardW + gapX);
        const y = rowY + row * (cardH + gapY);
        pdf.setDrawColor(228); pdf.setFillColor(255, 255, 255);
        pdf.roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
        const b64 = await getImageBase64(p.image);
        if (b64) { try { pdf.addImage(b64, 'PNG', x + 5, y + 4, cardW - 10, imgH - 8); } catch (e) {} }
        pdf.setDrawColor(228); pdf.line(x + 4, y + imgH, x + cardW - 4, y + imgH);
        pdf.setFontSize(9); pdf.setFont(undefined, 'bold');
        const nameLines = pdf.splitTextToSize(p.name, cardW - 10);
        pdf.text(nameLines[0] || '', x + 5, y + imgH + 6);
        pdf.setFont(undefined, 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(120);
        pdf.text((p.sku || 'Manual') + ' · MOQ ' + (p.moq || 0), x + 5, y + imgH + 11);
        pdf.setTextColor(0);
        if (!noPrice) {
          pdf.setFont(undefined, 'bold'); pdf.setTextColor(38, 137, 13);
          pdf.text(fmtPdf(p._price), x + 5, y + imgH + 17);
          pdf.setTextColor(0); pdf.setFont(undefined, 'normal');
        }
        col++;
      }
      if (!kit.isCollection && !noPrice) {
        const total = kitTotal(kit);
        const usedRows = row + 1;
        let totalY = rowY + usedRows * (cardH + gapY) + 4;
        // A kit whose last page is fully packed leaves no room for the
        // total line — rather than silently dropping it, give it a fresh
        // page rather than let it collide with (or hide behind) the footer.
        if (totalY >= pageH - 45) {
          addFooter(); pdf.addPage(); page++;
          addHeader(kit.name);
          totalY = 50;
        }
        pdf.setFont(undefined, 'bold'); pdf.setFontSize(10);
        pdf.text('Total: ' + fmtPdf(total) + '/- + GST + FREIGHT', pageW / 2, totalY, { align: 'center' });
        pdf.setFont(undefined, 'normal');
      }
      addFooter();
      if (ki < selectedKits.length - 1) { pdf.addPage(); page++; }
    }

    pdf.save('Deloitte-' + clientName.replace(/[^a-z0-9]+/gi, '-') + '-' + quoteId + '.pdf');

    const totalValue = selectedKits.filter(k => !k.isCollection).reduce((s, k) => s + kitTotal(k), 0);
    const hasManual = selectedKits.some(k => k.products.some(p => p._isManual));
    logEvent('pdf_export', {
      quoteId, clientName, kit_count: selectedKits.length,
      no_price: noPrice, markup_pct: cfg.markupPct, has_manual: hasManual,
      total_value: noPrice ? '' : totalValue,
    });
    markQuoteStatus(quoteId, 'recommended', clientName);
  }

  /* ----------------------------------------------------------------- history */

  function historyKey() {
    const u = Auth.user();
    return 'am_history_' + ((u && u.username) || 'unknown');
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(historyKey()) || '[]'); } catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(historyKey(), JSON.stringify(list.slice(0, 50))); } catch (e) {}
  }

  function addToHistory(cfg) {
    if (!state.currentQuoteId) state.currentQuoteId = newQuoteId();
    const list = loadHistory();
    list.unshift({
      id: Date.now(), quoteId: state.currentQuoteId, status: 'draft',
      clientName: state.currentQuoteClient || '', timestamp: new Date().toISOString(),
      budget: cfg.budget || cfg.maxKitPrice, kitCount: state.kits.length,
      kits: state.kits.map(k => ({ name: k.name, total: kitTotal(k), productCount: k.products.length, isCollection: k.isCollection })),
    });
    saveHistory(list);
    renderHistory();
  }

  function markQuoteStatus(quoteId, status, clientName) {
    const list = loadHistory();
    const item = list.find(h => h.quoteId === quoteId);
    if (item) { item.status = status; item.clientName = clientName || item.clientName; saveHistory(list); renderHistory(); }
  }

  function setQuoteStatus(id, status) {
    const list = loadHistory();
    const item = list.find(h => h.id === id);
    if (!item) return;
    if (status === 'rejected') item.rejectReason = prompt('Reason for rejection (optional):') || '';
    item.status = status;
    saveHistory(list);
    renderHistory();
    logEvent(status, { quote_id: item.quoteId, client_name: item.clientName });
  }

  function renameHistoryItem(id) {
    const list = loadHistory();
    const item = list.find(h => h.id === id);
    if (!item) return;
    const label = prompt('Rename this quote', item.label || item.clientName || item.quoteId);
    if (label != null) { item.label = label; saveHistory(list); renderHistory(); }
  }

  function deleteHistoryItem(id) {
    saveHistory(loadHistory().filter(h => h.id !== id));
    renderHistory();
  }

  function clearAllHistory() {
    if (!confirm('Clear all saved quote history?')) return;
    saveHistory([]);
    renderHistory();
  }

  function renderHistory() {
    const wrap = document.getElementById('historyList');
    if (!wrap) return;
    wrap.innerHTML = '';
    const list = loadHistory();
    if (!list.length) { wrap.appendChild(el('p', { class: 'muted' }, 'No saved quotes yet.')); return; }
    list.forEach(item => {
      wrap.appendChild(el('div', { class: 'am-history-row' },
        el('div', {},
          el('strong', {}, item.label || item.clientName || item.quoteId),
          el('div', { class: 'small muted' },
            item.quoteId + ' · ' + item.kitCount + ' kit(s) · ' + (item.status || 'draft') +
            (item.rejectReason ? ' (' + item.rejectReason + ')' : '') + ' · ' + new Date(item.timestamp).toLocaleString('en-IN'))),
        el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
          el('button', { type: 'button', onclick: () => setQuoteStatus(item.id, 'sent') }, 'Sent'),
          el('button', { type: 'button', onclick: () => setQuoteStatus(item.id, 'converted') }, 'Won'),
          el('button', { type: 'button', onclick: () => setQuoteStatus(item.id, 'rejected') }, 'Lost'),
          el('button', { type: 'button', onclick: () => renameHistoryItem(item.id) }, 'Rename'),
          el('button', { type: 'button', onclick: () => deleteHistoryItem(item.id) }, 'Delete'))));
    });
  }

  /* ------------------------------------------------------------------- log */

  function logEvent(event, data) {
    api('agent_log', Object.assign({ event }, data || {})).catch(() => {});
  }

  return { init };
})();
