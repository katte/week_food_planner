'use strict';

/*
 * Sezione «Spesa»: scontrini importati dal JSON di un'AI, articoli comprati con lo
 * storico dei prezzi e ingredienti delle ricette.
 *   #/spesa                    scontrini
 *   #/spesa/importa            importazione (prompt per l'AI, JSON con uno o più scontrini, revisione abbinamenti)
 *   #/spesa/scontrini/ID       uno scontrino, con gli abbinamenti modificabili
 *   #/spesa/articoli[/ID]      articoli e storico dei prezzi
 *   #/spesa/ingredienti        ingredienti e prezzo attuale
 * Usa lo stato e le funzioni di app.js e recipes.js, caricati prima.
 */

const PRODUCT_CATEGORIES = [
  { key: 'alimentari', name: 'Alimentari' },
  { key: 'bevande', name: 'Bevande' },
  { key: 'casa', name: 'Casa' },
  { key: 'igiene', name: 'Igiene' },
  { key: 'animali', name: 'Animali' },
  { key: 'altro', name: 'Altro' },
];

const spesa = {
  products: [],
  productFilter: { q: '', category: 'all', perPiece: false },
  ingredientQuery: '',
  editingIngredientId: null,
  // Importazione in corso: gli scontrini della risposta dell'AI, controllati uno alla volta.
  // { text, receipts, warnings, index, results (id salvato o null se saltato), source, preview, choices, error }
  import: null,
  prompt: '',
  promptTemplate: null,
  receipt: null,
  receiptChoices: null, // abbinamenti in modifica nello scontrino aperto
  product: null,
};

routes.push(
  { nav: 'spesa', re: /^#\/spesa\/?$/, show: showReceipts },
  { nav: 'spesa', re: /^#\/spesa\/importa\/?$/, show: showImport },
  { nav: 'spesa', re: /^#\/spesa\/scontrini\/(\d+)\/?$/, show: showReceipt },
  { nav: 'spesa', re: /^#\/spesa\/articoli\/?$/, show: showProducts },
  { nav: 'spesa', re: /^#\/spesa\/articoli\/(\d+)\/?$/, show: showProduct },
  { nav: 'spesa', re: /^#\/spesa\/ingredienti\/?$/, show: showIngredients },
);

// ---------------------------------------------------------------------------
// Pezzi comuni
// ---------------------------------------------------------------------------

const fmtLongDay = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const dateLabel = (key) => fmtLongDay.format(fromKey(key));
const productByName = (name) => {
  const key = fold(String(name).trim());
  return key ? spesa.products.find((p) => fold(p.name) === key) : undefined;
};

function spesaLayout(active, content) {
  const tabs = [
    ['scontrini', '#/spesa', 'Scontrini'],
    ['articoli', '#/spesa/articoli', 'Articoli'],
    ['ingredienti', '#/spesa/ingredienti', 'Ingredienti'],
  ];
  return `
    <div class="page page-wide">
      <header class="page-head">
        <div>
          <h1>Spesa</h1>
          <p class="lead">Scontrini, prezzi delle cose che compri e ingredienti delle ricette.</p>
        </div>
        <a class="btn btn-primary" href="#/spesa/importa">${ICONS.plus}Importa scontrino</a>
      </header>
      <nav class="tabs" aria-label="Sezioni della spesa">
        ${tabs.map(([key, href, label]) => `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
      </nav>
      ${content}
    </div>`;
}

function datalist(id, names) {
  return `<datalist id="${id}">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
}

function quantityLabel(line) {
  if (line.weightKg !== null && line.weightFromProduct) {
    return `≈ ${formatDecimal(line.weightKg)} kg <span class="muted" title="Peso ricavato dall'importo con il prezzo al kg della scheda dell'articolo">(da articolo)</span>`;
  }
  if (line.weightKg !== null) return `${formatDecimal(line.weightKg)} kg`;
  const times = line.quantity !== 1 ? `${formatDecimal(line.quantity)} × ` : '';
  if (line.packageSize !== null) {
    let source = '';
    if (line.packageFromProduct) {
      source = ' <span class="muted" title="Formato preso dalla scheda dell\'articolo">(da articolo)</span>';
    } else if (line.packageEstimated) {
      source = ' <span class="muted" title="Formato dedotto dall\'AI, non stampato sullo scontrino">(stimato)</span>';
    }
    return `${times}${formatDecimal(line.packageSize)} ${line.packageUnit}${source}`;
  }
  return `${formatDecimal(line.quantity)} pz`;
}

function priceCell(line) {
  if (!(line.discount > 0)) return euro(line.priceFull);
  return `${euro(line.priceFull)}<small title="sconto ${euro(line.discount)}, pagato ${euro(line.pricePaid)}">−${euro(line.discount)} → ${euro(line.pricePaid)}</small>`;
}

function refPriceCell(line) {
  if (line.refPriceFull === null) return '<span class="muted">—</span>';
  const paid = line.refPricePaid !== null && Math.abs(line.refPricePaid - line.refPriceFull) >= 0.005
    ? `<small>pagato ${priceLabel(line.refPricePaid, line.refUnit)}</small>`
    : '';
  return `${priceLabel(line.refPriceFull, line.refUnit)}${paid}`;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Senza HTTPS gli appunti moderni non sono disponibili: uso il metodo classico.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copia non riuscita: apri «Mostra il prompt» e copialo a mano.');
}

// ---------------------------------------------------------------------------
// Scontrini
// ---------------------------------------------------------------------------

async function showReceipts(match, token) {
  const receipts = await api('receipts');
  if (token !== renderToken) return;

  let content = emptyTemplate(
    'Nessuno scontrino',
    `Fai leggere uno scontrino a un'AI con il prompt che trovi in <a href="#/spesa/importa">Importa scontrino</a>
     e incolla qui il risultato: i prezzi finiscono nello storico e nel costo dei piatti.`,
  );
  if (receipts.length) {
    const months = new Map();
    for (const r of receipts) {
      const month = capitalize(fmtMonth.format(fromKey(r.date)));
      if (!months.has(month)) months.set(month, []);
      months.get(month).push(r);
    }
    content = [...months].map(([month, list]) => {
      const spent = list.reduce((sum, r) => sum + receiptSpent(r), 0);
      return `
        <h2 class="history-month">${month} <span class="month-total">${euro(spent)}</span></h2>
        <div class="card receipt-list">${list.map(receiptRow).join('')}</div>`;
    }).join('');
  }
  app.innerHTML = spesaLayout('scontrini', content);
  document.title = 'Scontrini · Menù della settimana';
}

const receiptSpent = (r) => r.total ?? r.paid - r.extraDiscount;

function receiptRow(r) {
  const saved = r.discounts + r.extraDiscount;
  return `
    <a class="receipt-row" href="#/spesa/scontrini/${r.id}">
      <span class="receipt-when">${esc(dateLabel(r.date))}${r.time ? ` · ${r.time}` : ''}</span>
      <span class="receipt-store">${esc(r.store)}</span>
      <span class="receipt-meta">${plural(r.items, 'riga', 'righe')}${r.unlinked ? ` · <span class="tag tag-warn">${r.unlinked} senza articolo</span>` : ''}</span>
      <span class="receipt-total">${euro(receiptSpent(r))}${saved > 0 ? `<small>risparmiati ${euro(saved)}</small>` : ''}</span>
    </a>`;
}

async function showReceipt(match, token) {
  const id = match[1];
  const [receipt, products, ingredients] = await Promise.all([
    api('receipt', { params: { id } }),
    api('products'),
    api('ingredients'),
  ]);
  if (token !== renderToken) return;
  spesa.receipt = receipt;
  spesa.products = products;
  state.ingredients = ingredients;
  spesa.receiptChoices = null;
  renderReceipt();
}

function renderReceipt() {
  const r = spesa.receipt;
  const editing = spesa.receiptChoices !== null;
  const saved = r.lines.reduce((sum, l) => sum + l.discount, 0) + r.extraDiscount;
  const linesHtml = editing
    ? `<div class="review-lines" data-mapping="receipt">
         ${r.lines.map((l) => mappingLine(l, spesa.receiptChoices[l.id], l.id, l.productId ? l.product : null)).join('')}
       </div>
       ${datalist('dl-products', spesa.products.map((p) => p.name))}
       ${datalist('dl-ingredients', state.ingredients.map((i) => i.name))}`
    : `<div class="review-lines">${r.lines.map(receiptLine).join('')}</div>`;

  app.innerHTML = spesaLayout('scontrini', `
    <a class="back-link" href="#/spesa">← Tutti gli scontrini</a>
    <section class="card receipt-head">
      <div>
        <h2>${esc(r.store)}</h2>
        <p class="muted">${esc(dateLabel(r.date))}${r.time ? ` · ${r.time}` : ''}${r.address ? ` · ${esc(r.address)}` : ''}</p>
      </div>
      <dl class="figures">
        <div><dt>Totale</dt><dd>${r.total === null ? '—' : euro(r.total)}</dd></div>
        <div><dt>Righe</dt><dd>${r.lines.length}</dd></div>
        <div><dt>Sconti</dt><dd>${euro(saved)}</dd></div>
      </dl>
    </section>
    ${r.warnings.length ? `<ul class="notice notice-warn">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <div class="section-bar">
      <h2 class="group-title">Righe</h2>
      <div class="section-actions">
        ${editing
          ? `<button type="button" class="btn btn-primary btn-sm" data-action="receipt-relink">Salva abbinamenti</button>
             <button type="button" class="btn btn-ghost btn-sm" data-action="receipt-edit-cancel">Annulla</button>`
          : '<button type="button" class="btn btn-sm" data-action="receipt-edit">Modifica abbinamenti</button>'}
      </div>
    </div>
    <div class="card lines-card">${linesHtml}</div>
    <div class="danger-zone">
      <button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="receipt-delete">Elimina scontrino</button>
    </div>`);
  document.title = `${r.store}, ${dateLabel(r.date)} · Menù della settimana`;
}

function receiptLine(line) {
  const product = line.productId
    ? `<a href="#/spesa/articoli/${line.productId}">${esc(line.product)}</a>`
    : '<span class="tag tag-warn">senza articolo</span>';
  const ingredient = line.ingredient ? ` <span class="tag">${esc(line.ingredient)}</span>` : '';
  return `
    <div class="review-line">
      <div class="rl-desc"><code>${esc(line.description)}</code><span>${product}${ingredient}</span></div>
      <div class="rl-qty">${quantityLabel(line)}</div>
      <div class="rl-price">${priceCell(line)}</div>
      <div class="rl-ref">${refPriceCell(line)}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Abbinamento righe → articolo e ingrediente (importazione e modifica di uno scontrino)
// ---------------------------------------------------------------------------

// $known: nome dell'articolo già abbinato a questa riga, per l'etichetta «riconosciuto».
function mappingLine(line, choice, key, known) {
  return `
    <div class="review-line is-mapping" data-key="${key}" data-known="${esc(known ?? '')}">
      <div class="rl-desc"><code>${esc(line.description)}</code>${line.name && line.name !== line.description ? `<span>${esc(line.name)}</span>` : ''}</div>
      <div class="rl-qty">${quantityLabel(line)}</div>
      <div class="rl-price">${priceCell(line)}</div>
      <div class="rl-ref">${refPriceCell(line)}</div>
      <label class="rl-field">
        <span>Articolo <span class="badge-slot" data-badge="product">${productBadge(choice.product, known)}</span></span>
        <input class="input" list="dl-products" value="${esc(choice.product)}" placeholder="non tracciare" maxlength="120"
          data-input="map-product" data-change="map-product-picked">
      </label>
      <label class="rl-field">
        <span>Ingrediente <span class="badge-slot" data-badge="ingredient">${ingredientBadge(choice.ingredient)}</span></span>
        <input class="input" list="dl-ingredients" value="${esc(choice.ingredient)}" placeholder="nessuno" maxlength="80"
          data-input="map-ingredient">
      </label>
    </div>`;
}

function productBadge(name, known) {
  if (!name.trim()) return '<span class="tag">non tracciato</span>';
  const product = productByName(name);
  if (!product) return '<span class="tag tag-new">nuovo</span>';
  return known && fold(known) === fold(product.name)
    ? '<span class="tag tag-ok">riconosciuto</span>'
    : '<span class="tag">esistente</span>';
}

function ingredientBadge(name) {
  if (!name.trim() || ingredientByName(name)) return '';
  return '<span class="tag tag-new">nuovo</span>';
}

function mappingContext(el) {
  const row = el.closest('.review-line');
  const choices = row.closest('[data-mapping]').dataset.mapping === 'import' ? spesa.import.choices : spesa.receiptChoices;
  return { row, choice: choices[row.dataset.key] };
}

function refreshBadges(row, choice) {
  row.querySelector('[data-badge="product"]').innerHTML = productBadge(choice.product, row.dataset.known);
  row.querySelector('[data-badge="ingredient"]').innerHTML = ingredientBadge(choice.ingredient);
}

Object.assign(inputHandlers, {
  'map-product': (el) => {
    const { row, choice } = mappingContext(el);
    choice.product = el.value;
    refreshBadges(row, choice);
  },
  'map-ingredient': (el) => {
    const { row, choice } = mappingContext(el);
    choice.ingredient = el.value;
    refreshBadges(row, choice);
  },
});

Object.assign(changeHandlers, {
  // Scelto un articolo esistente, propongo il suo ingrediente.
  'map-product-picked': (el) => {
    const { row, choice } = mappingContext(el);
    const product = productByName(el.value);
    if (product?.ingredient) {
      choice.ingredient = product.ingredient;
      row.querySelector('[data-input="map-ingredient"]').value = product.ingredient;
      refreshBadges(row, choice);
    }
  },
});

// ---------------------------------------------------------------------------
// Importazione
// ---------------------------------------------------------------------------

async function buildPrompt() {
  if (spesa.promptTemplate === null) {
    const res = await fetch('prompt-scontrino.txt', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Non riesco a caricare il prompt (prompt-scontrino.txt).');
    spesa.promptTemplate = await res.text();
  }
  const names = state.ingredients.map((i) => `   - ${i.name}`).join('\n');
  return spesa.promptTemplate.replace('{{INGREDIENTI}}', names || '   (nessuno per ora: proponi tu un nome generico)');
}

async function showImport(match, token) {
  const [ingredients, products] = await Promise.all([api('ingredients'), api('products')]);
  state.ingredients = ingredients;
  spesa.products = products;
  const prompt = await buildPrompt();
  if (token !== renderToken) return;
  spesa.prompt = prompt;

  app.innerHTML = spesaLayout('scontrini', `
    <a class="back-link" href="#/spesa">← Tutti gli scontrini</a>
    <section class="card import-step">
      <h2 class="step-title"><span class="step">1</span>Fai leggere gli scontrini a un'AI</h2>
      <p>Apri ChatGPT, Claude o Gemini, allega le foto e incolla questo prompt. Puoi allegare più scontrini insieme,
        e più foto dello stesso scontrino se è lungo. Il prompt contiene già l'elenco dei tuoi ingredienti,
        così l'AI li usa per gli abbinamenti.</p>
      <div class="step-actions">
        <button type="button" class="btn" data-action="copy-prompt">Copia il prompt</button>
      </div>
      <details class="prompt-details">
        <summary>Mostra il prompt</summary>
        <pre class="prompt-text">${esc(prompt)}</pre>
      </details>
    </section>
    <section class="card import-step">
      <h2 class="step-title"><span class="step">2</span>Incolla la risposta dell'AI</h2>
      <form data-submit="import-read" autocomplete="off">
        <textarea name="json" class="input json-input" spellcheck="false" required
          placeholder='{ "scontrini": [ { "negozio": "…", "data": "…", "righe": [ … ] } ] }'>${esc(spesa.import?.text ?? '')}</textarea>
        <p id="import-error" class="form-error" hidden></p>
        <button type="submit" class="btn btn-primary">Leggi gli scontrini</button>
      </form>
    </section>
    <div id="import-review">${spesa.import ? reviewTemplate() : ''}</div>`);
  document.title = 'Importa scontrino · Menù della settimana';
}

// Blocchi JSON ({…} o […]) nel testo: la risposta dell'AI può avere testo o ``` attorno, o più blocchi.
// truncated: l'ultimo blocco non si chiude, cioè la risposta si è interrotta.
function jsonBlocks(text) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = depth > 0;
    } else if (c === '{' || c === '[') {
      if (depth++ === 0) start = i;
    } else if ((c === '}' || c === ']') && depth > 0) {
      if (--depth === 0) blocks.push(text.slice(start, i + 1));
    }
  }
  return { blocks, truncated: depth > 0 };
}

// Scontrini nella risposta dell'AI: { "scontrini": [ … ] }, una lista o un solo scontrino (prompt precedente).
function readAiReply(text) {
  const { blocks, truncated } = jsonBlocks(text);
  const values = [];
  let parseError = null;
  for (const block of blocks) {
    try {
      values.push(JSON.parse(block));
    } catch (err) {
      parseError ??= err;
    }
  }
  if (!values.length) {
    if (parseError) throw new Error(`Il JSON non è valido (${parseError.message}). Chiedi all'AI di restituire solo il JSON.`);
    if (truncated) throw new Error("Il JSON è incompleto: la risposta dell'AI si è interrotta. Chiedile di continuare, o manda meno foto per volta.");
    throw new Error("Non trovo il JSON: incolla tutta la risposta dell'AI.");
  }

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const receipts = [];
  const warnings = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      receipts.push(...value.filter(isObject));
    } else if (isObject(value) && Array.isArray(value.scontrini)) {
      receipts.push(...value.scontrini.filter(isObject));
      if (Array.isArray(value.avvisi)) warnings.push(...value.avvisi.filter((w) => typeof w === 'string' && w.trim()));
    } else if (isObject(value)) {
      receipts.push(value);
    }
  }
  if (truncated) warnings.push("La risposta dell'AI sembra interrotta: l'ultimo scontrino potrebbe mancare.");
  if (!receipts.length) throw new Error(['Nel JSON non ci sono scontrini.', ...warnings].join(' '));
  return { receipts, warnings };
}

async function readImport(form) {
  const text = form.elements.json.value;
  const error = document.getElementById('import-error');
  const button = form.querySelector('button[type="submit"]');
  error.hidden = true;
  button.disabled = true;
  try {
    const { receipts, warnings } = readAiReply(text);
    spesa.import = { text, receipts, warnings, index: 0, results: [] };
    await loadImportReceipt();
  } catch (err) {
    spesa.import = null;
    const review = document.getElementById('import-review');
    if (review) review.innerHTML = '';
    if (err instanceof AuthError) return;
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

// Revisione dello scontrino numero imp.index. L'anteprima si chiede solo adesso, così riconosce
// gli articoli e gli abbinamenti degli scontrini appena salvati.
async function loadImportReceipt() {
  const imp = spesa.import;
  Object.assign(imp, { source: imp.receipts[imp.index], preview: null, choices: null, error: null });
  try {
    const [preview, products, ingredients] = await Promise.all([
      api('receipt-preview', { body: { receipt: imp.source } }),
      api('products'),
      api('ingredients'),
    ]);
    spesa.products = products;
    state.ingredients = ingredients;
    // Proposta iniziale: l'articolo riconosciuto, altrimenti uno nuovo con il nome dato dall'AI.
    const choices = {};
    for (const line of preview.lines) {
      choices[line.index] = line.match
        ? { product: line.match.product, ingredient: line.match.ingredient ?? line.suggestedIngredient }
        : { product: line.name, ingredient: line.suggestedIngredient };
    }
    Object.assign(imp, { preview, choices });
  } catch (err) {
    // Con più scontrini, uno che non si riesce a leggere si salta senza perdere gli altri.
    if (err instanceof AuthError || imp.receipts.length === 1) throw err;
    imp.error = err.message;
  }
  const review = document.getElementById('import-review');
  if (spesa.import !== imp || !review) return;
  review.innerHTML = reviewTemplate();
  review.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function nextImportReceipt(imp) {
  imp.index += 1;
  if (imp.index < imp.receipts.length) {
    await loadImportReceipt();
    return;
  }
  spesa.import = null;
  const saved = imp.results.filter(Boolean);
  if (imp.receipts.length === 1) {
    location.hash = `#/spesa/scontrini/${saved[0]}`;
  } else if (saved.length) {
    toast(plural(saved.length, 'scontrino salvato', 'scontrini salvati'));
    location.hash = '#/spesa';
  } else {
    route();
  }
}

const receiptDay = (key) => (/^\d{4}-\d{2}-\d{2}$/.test(key ?? '') && !Number.isNaN(fromKey(key).getTime()) ? dateLabel(key) : null);

// Gli scontrini trovati nella risposta dell'AI, con quelli già salvati o saltati.
function batchTemplate(imp) {
  const rows = imp.receipts.map((r, i) => {
    const result = imp.results[i];
    const lines = Array.isArray(r.righe) ? r.righe.length : 0;
    const label = [
      typeof r.negozio === 'string' && r.negozio.trim() ? r.negozio.trim() : 'Negozio non letto',
      receiptDay(r.data) ?? 'data non letta',
      typeof r.totale === 'number' ? euro(r.totale) : null,
      plural(lines, 'riga', 'righe'),
    ].filter(Boolean).join(' · ');
    const status = result ? `<a class="tag tag-ok" href="#/spesa/scontrini/${result}">salvato</a>`
      : result === null ? '<span class="tag">saltato</span>'
      : i === imp.index ? '<span class="tag tag-new">da controllare</span>'
      : '';
    return `<li${i === imp.index ? ' aria-current="step"' : ''}><span class="ib-num">${i + 1}</span>
      <span class="ib-label">${esc(label)}</span>${status}</li>`;
  });
  return `<ol class="import-batch">${rows.join('')}</ol>`;
}

function importButtons(imp, canSave) {
  const many = imp.receipts.length > 1;
  const more = imp.index < imp.receipts.length - 1;
  return `
    <div class="review-actions">
      ${canSave ? `<button type="button" class="btn btn-primary" data-action="import-save">${more ? 'Salva e vai al prossimo' : 'Salva scontrino'}</button>` : ''}
      ${many ? `<button type="button" class="btn" data-action="import-skip">Salta questo scontrino</button>` : ''}
      <button type="button" class="btn btn-ghost" data-action="import-reset">${imp.results.some(Boolean) ? 'Annulla i rimanenti' : 'Annulla'}</button>
    </div>`;
}

function reviewTemplate() {
  const imp = spesa.import;
  const { source, preview, choices } = imp;
  if (!preview && !imp.error) return '';
  const many = imp.receipts.length > 1;
  const head = `
      <h2 class="step-title"><span class="step">3</span>Controlla e salva
        ${many ? `<span class="step-count">scontrino ${imp.index + 1} di ${imp.receipts.length}</span>` : ''}</h2>
      ${imp.warnings.length ? `<ul class="notice notice-warn">${imp.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${many ? batchTemplate(imp) : ''}`;
  if (imp.error) {
    return `
    <section class="card import-step">${head}
      <p class="notice notice-warn">Non riesco a leggere questo scontrino: ${esc(imp.error)}</p>
      ${importButtons(imp, false)}
    </section>`;
  }
  const known = (line) => (line.match?.via === 'alias' ? line.match.product : null);
  return `
    <section class="card import-step">${head}
      <div class="review-head">
        <label class="field"><span>Negozio</span>
          <input class="input" value="${esc(source.negozio ?? preview.store)}" maxlength="80" data-input="import-store"></label>
        <label class="field"><span>Data</span>
          <input class="input" type="date" value="${preview.date ?? ''}" required data-input="import-date"></label>
        <label class="field"><span>Ora</span>
          <input class="input" type="time" value="${preview.time ?? ''}" data-input="import-time"></label>
        <dl class="figures">
          <div><dt>Totale scontrino</dt><dd>${preview.total === null ? '—' : euro(preview.total)}</dd></div>
          <div><dt>Somma righe</dt><dd>${euro(preview.sum)}</dd></div>
        </dl>
      </div>
      ${preview.duplicateOf
        ? `<p class="notice notice-warn">Sembra già importato: <a href="#/spesa/scontrini/${preview.duplicateOf}">apri lo scontrino uguale</a>.</p>`
        : ''}
      ${preview.warnings.length ? `<ul class="notice notice-warn">${preview.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <p class="review-help">Ogni riga diventa un <b>articolo</b>, di cui segui il prezzo nel tempo; se è un alimento,
        collegalo all'<b>ingrediente</b> delle ricette. Lascia vuoto l'articolo per non tracciare una riga.</p>
      <div class="review-lines" data-mapping="import">
        ${preview.lines.map((l) => mappingLine(l, choices[l.index], l.index, known(l))).join('')}
      </div>
      ${datalist('dl-products', spesa.products.map((p) => p.name))}
      ${datalist('dl-ingredients', state.ingredients.map((i) => i.name))}
      ${importButtons(imp, true)}
    </section>`;
}

async function saveImport(button) {
  const imp = spesa.import;
  const { source, preview, choices } = imp;
  if (!source.data && !preview.date) {
    toast('Indica la data dello scontrino', 'error');
    app.querySelector('[data-input="import-date"]')?.focus();
    return;
  }
  if (preview.duplicateOf && !confirm('Questo scontrino sembra già importato. Vuoi salvarlo comunque?')) return;
  button.disabled = true;
  try {
    const { id } = await api('receipt-save', { body: { receipt: source, choices } });
    imp.results[imp.index] = id;
    toast('Scontrino salvato');
    await nextImportReceipt(imp);
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function skipImport(button) {
  const imp = spesa.import;
  button.disabled = true;
  imp.results[imp.index] = null;
  try {
    await nextImportReceipt(imp);
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

Object.assign(inputHandlers, {
  'import-store': (el) => { spesa.import.source.negozio = el.value; },
  'import-date': (el) => { spesa.import.source.data = el.value; },
  'import-time': (el) => { spesa.import.source.ora = el.value; },
});

// ---------------------------------------------------------------------------
// Articoli
// ---------------------------------------------------------------------------

async function showProducts(match, token) {
  const products = await api('products');
  if (token !== renderToken) return;
  spesa.products = products;
  app.innerHTML = spesaLayout('articoli', `
    <div class="toolbar">
      <input class="input" type="search" placeholder="Cerca un articolo…" aria-label="Cerca un articolo"
        value="${esc(spesa.productFilter.q)}" data-input="product-search">
      <div id="product-filters" class="filters" role="group" aria-label="Filtra per categoria"></div>
    </div>
    <div id="product-list"></div>`);
  renderProductList();
  document.title = 'Articoli · Menù della settimana';
}

// Articoli di cui si conosce solo il prezzo a pezzo: con il formato avrebbero anche quello al kg / litro.
const hasOnlyPiecePrice = (p) => p.last?.refUnit === 'pz' && p.packageSize === null;

function renderProductList() {
  const container = document.getElementById('product-list');
  if (!container) return;
  const { q, category, perPiece } = spesa.productFilter;
  const products = spesa.products;
  const perPieceCount = products.filter(hasOnlyPiecePrice).length;

  document.getElementById('product-filters').innerHTML = [{ key: 'all', name: 'Tutti' }, ...PRODUCT_CATEGORIES]
    .map((c) => {
      const n = c.key === 'all' ? products.length : products.filter((p) => p.category === c.key).length;
      if (!n && c.key !== 'all') return '';
      return `<button type="button" class="filter" data-action="product-filter" data-category="${c.key}"
        aria-pressed="${category === c.key}">${c.name}<span class="n">${n}</span></button>`;
    })
    .join('') + (perPieceCount ? `
      <button type="button" class="filter filter-flag" data-action="product-per-piece" aria-pressed="${perPiece}"
        title="Articoli con il solo prezzo a pezzo">Senza formato<span class="n">${perPieceCount}</span></button>` : '');

  if (!products.length) {
    container.innerHTML = emptyTemplate('Ancora nessun articolo', 'Gli articoli nascono importando gli scontrini.',
      '<a class="btn btn-primary" href="#/spesa/importa">Importa uno scontrino</a>');
    return;
  }
  const fq = fold(q.trim());
  const visible = products.filter((p) => (category === 'all' || p.category === category)
    && (!perPiece || hasOnlyPiecePrice(p))
    && (!fq || fold(p.name).includes(fq) || fold(p.ingredient ?? '').includes(fq) || fold(p.brand).includes(fq)));
  const help = perPiece
    ? `<p class="review-help">Di questi articoli conosci solo il prezzo a pezzo. Apri la scheda e indica il formato
        (es. 1 kg, 400 g, 750 ml), o il prezzo al kg se li compri a peso: il prezzo al kg o al litro si calcola anche
        per gli acquisti passati.</p>`
    : '';
  if (!visible.length) {
    container.innerHTML = help + emptyTemplate('Nessun articolo trovato', 'Prova a cambiare la ricerca o i filtri.');
    return;
  }
  container.innerHTML = help + PRODUCT_CATEGORIES.map((cat) => {
    const items = visible.filter((p) => p.category === cat.key);
    if (!items.length) return '';
    return `
      <section class="dish-group">
        <h2 class="group-title">${cat.name} <span class="count-pill">${items.length}</span></h2>
        <div class="card product-list">${items.map(productRow).join('')}</div>
      </section>`;
  }).join('');
}

function productRow(p) {
  const last = p.last;
  return `
    <a class="product-row" href="#/spesa/articoli/${p.id}">
      <span class="pr-name">${highlight(p.name, spesa.productFilter.q)}${p.brand ? ` <small>${esc(p.brand)}</small>` : ''}</span>
      <span class="pr-ingredient">${p.ingredient ? `<span class="tag">${esc(p.ingredient)}</span>` : ''}</span>
      <span class="pr-price">${last ? `${euro(last.priceFull)} · ${refPriceCell(last)}` : '—'}
        ${last ? `<small>${shortDate(last.date)} · ${esc(last.store)}</small>` : ''}</span>
      <span class="pr-count">${plural(p.purchases, 'acquisto', 'acquisti')}</span>
    </a>`;
}

async function showProduct(match, token) {
  const [product, products, ingredients] = await Promise.all([
    api('product', { params: { id: match[1] } }),
    api('products'),
    api('ingredients'),
  ]);
  if (token !== renderToken) return;
  spesa.product = product;
  spesa.products = products;
  state.ingredients = ingredients;
  renderProduct();
}

function renderProduct() {
  const p = spesa.product;
  const unit = p.last?.refUnit;
  const comparable = p.history.filter((h) => h.refPriceFull !== null && h.refUnit === unit).map((h) => h.refPriceFull);
  const others = spesa.products.filter((o) => o.id !== p.id);
  const sizeUnits = ['', ...Object.keys(AMOUNT_UNITS)];
  const byWeight = p.pricePerKg !== null;

  app.innerHTML = spesaLayout('articoli', `
    <a class="back-link" href="#/spesa/articoli">← Tutti gli articoli</a>
    <form class="card product-form" data-submit="product-save" autocomplete="off">
      <label class="field field-wide"><span>Nome</span>
        <input name="name" class="input" required maxlength="120" value="${esc(p.name)}"></label>
      <label class="field"><span>Marca</span>
        <input name="brand" class="input" maxlength="60" value="${esc(p.brand)}"></label>
      <label class="field"><span>Categoria</span>
        <select name="category" class="input">${PRODUCT_CATEGORIES.map((c) => `<option value="${c.key}"${c.key === p.category ? ' selected' : ''}>${c.name}</option>`).join('')}</select></label>
      <label class="field"><span>Ingrediente</span>
        <input name="ingredient" class="input" list="dl-ingredients" maxlength="80" placeholder="nessuno" value="${esc(p.ingredient ?? '')}"></label>
      <label class="field"><span>Si compra</span>
        <select name="sold" class="input" data-change="product-sold">
          <option value="pack"${byWeight ? '' : ' selected'}>in confezione</option>
          <option value="weight"${byWeight ? ' selected' : ''}>a peso, al banco</option>
        </select></label>
      <label class="field" data-sold="pack"${byWeight ? ' hidden' : ''}><span>Formato della confezione</span>
        <span class="inline-inputs">
          <input name="packageSize" class="input" inputmode="decimal" placeholder="es. 500" value="${p.packageSize === null ? '' : formatDecimal(p.packageSize)}">
          <select name="packageUnit" class="input" aria-label="Unità del formato">${sizeUnits.map((u) => `<option value="${u}"${u === (p.packageUnit ?? '') ? ' selected' : ''}>${u || '—'}</option>`).join('')}</select>
        </span></label>
      <label class="field" data-sold="weight"${byWeight ? '' : ' hidden'}><span>Prezzo al kg</span>
        <input name="pricePerKg" class="input" inputmode="decimal" placeholder="es. 13,50" value="${p.pricePerKg === null ? '' : formatDecimal(p.pricePerKg)}"></label>
      ${p.pricePerKg !== null ? `
        <label class="check product-reprice" data-sold="weight"${byWeight ? '' : ' hidden'}><input type="checkbox" name="repriceAll"> Nuovo prezzo anche agli acquisti passati</label>` : ''}
      <button type="submit" class="btn btn-primary">Salva</button>
    </form>
    <p class="review-help" data-sold="pack"${byWeight ? ' hidden' : ''}>Il <b>formato</b> (es. 1 kg, 400 g, 750 ml, 6 pz) vale per
      gli acquisti in cui lo scontrino non lo riporta: con quello si calcola il prezzo al kg o al litro, anche degli acquisti passati.
      Per salumi, formaggi o pesce presi al banco scegli «a peso».</p>
    <p class="review-help" data-sold="weight"${byWeight ? '' : ' hidden'}>Per le cose pesate al banco, di cui lo scontrino riporta
      solo l'importo, il <b>prezzo al kg</b> serve a ricavare il peso di ogni acquisto (es. 2,70 € a 13,50 €/kg = 0,2 kg).
      Se il prezzo cambia, gli acquisti passati tengono quello di allora, a meno di spuntare la casella.</p>
    ${datalist('dl-ingredients', state.ingredients.map((i) => i.name))}

    ${p.last ? `
      <dl class="figures figures-wide card">
        <div><dt>Ultimo prezzo pieno</dt><dd>${refPriceCell(p.last)}</dd></div>
        <div><dt>Minimo</dt><dd>${comparable.length ? priceLabel(Math.min(...comparable), unit) : '—'}</dd></div>
        <div><dt>Massimo</dt><dd>${comparable.length ? priceLabel(Math.max(...comparable), unit) : '—'}</dd></div>
        <div><dt>Acquisti</dt><dd>${p.purchases}</dd></div>
      </dl>` : ''}

    <h2 class="group-title">Acquisti</h2>
    ${p.history.length ? `
      <div class="table-wrap card">
        <table class="history-table">
          <thead><tr><th>Data</th><th>Negozio</th><th>Quantità</th><th>Prezzo pieno</th><th>Pagato</th><th>Prezzo pieno per unità</th></tr></thead>
          <tbody>${p.history.map((h) => `
            <tr>
              <td><a href="#/spesa/scontrini/${h.receiptId}">${esc(shortDate(h.date))}</a></td>
              <td>${esc(h.store)}</td>
              <td>${quantityLabel(h)}</td>
              <td>${euro(h.priceFull)}</td>
              <td>${euro(h.pricePaid)}${h.discount > 0 ? ` <span class="tag tag-ok">−${euro(h.discount)}</span>` : ''}</td>
              <td>${h.refPriceFull === null ? '—' : priceLabel(h.refPriceFull, h.refUnit)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<p class="muted">Nessun acquisto collegato.</p>'}

    ${p.aliases.length ? `
      <h2 class="group-title">Riconosciuto sugli scontrini come</h2>
      <ul class="alias-list">${p.aliases.map((a) => `<li><code>${esc(a.description)}</code> <span class="muted">${esc(a.store)}</span></li>`).join('')}</ul>` : ''}

    <section class="card merge-box">
      <form data-submit="product-merge" autocomplete="off">
        <label class="field"><span>È lo stesso articolo di…</span>
          <input name="into" class="input" list="dl-other-products" required placeholder="scegli un altro articolo"></label>
        <button type="submit" class="btn">Unisci</button>
      </form>
      <p class="muted">Unendoli, acquisti e descrizioni di «${esc(p.name)}» passano all'altro articolo e questo sparisce.</p>
      ${datalist('dl-other-products', others.map((o) => o.name))}
    </section>
    <div class="danger-zone">
      <button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="product-delete">Elimina articolo</button>
    </div>`);
  document.title = `${p.name} · Menù della settimana`;
}

async function saveProduct(form) {
  const { sold, ...data } = Object.fromEntries(new FormData(form));
  // Vale solo il campo del modo scelto: confezione (formato) oppure a peso (prezzo al kg).
  if (sold === 'weight') Object.assign(data, { packageSize: '', packageUnit: '' });
  else data.pricePerKg = '';
  try {
    spesa.product = await api('product-update', { params: { id: spesa.product.id }, body: data });
    state.ingredients = await api('ingredients');
    renderProduct();
    toast('Articolo salvato');
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  }
}

async function mergeProduct(form) {
  const target = productByName(form.elements.into.value);
  if (!target || target.id === spesa.product.id) {
    toast('Scegli un articolo esistente dall\'elenco', 'error');
    return;
  }
  if (!confirm(`Unire «${spesa.product.name}» in «${target.name}»?\n\nGli acquisti passano a «${target.name}» e «${spesa.product.name}» viene eliminato.`)) return;
  try {
    await api('product-merge', { params: { id: spesa.product.id }, body: { into: target.id } });
    toast(`Uniti in «${target.name}»`);
    location.hash = `#/spesa/articoli/${target.id}`;
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Ingredienti
// ---------------------------------------------------------------------------

async function showIngredients(match, token) {
  const ingredients = await api('ingredients');
  if (token !== renderToken) return;
  state.ingredients = ingredients;
  spesa.editingIngredientId = null;
  app.innerHTML = spesaLayout('ingredienti', `
    <form class="card ingredient-form" data-submit="ingredient-add" autocomplete="off">
      <label class="field"><span>Nuovo ingrediente</span>
        <input name="name" class="input" required maxlength="80" placeholder="es. pomodori pelati"></label>
      <label class="field"><span>Prezzo</span>
        <select name="unit" class="input">${priceUnitOptions('kg')}</select></label>
      <label class="check"><input type="checkbox" name="negligible"> Trascurabile</label>
      <button type="submit" class="btn btn-primary">${ICONS.plus}Aggiungi</button>
    </form>
    <p class="review-help">Gli ingredienti <b>trascurabili</b> (sale, olio, spezie…) compaiono nelle ricette ma non nel costo;
      in una singola ricetta puoi comunque farli contare. Il prezzo arriva dagli articoli collegati, importando gli scontrini.</p>
    <div class="toolbar">
      <input class="input" type="search" placeholder="Cerca un ingrediente…" aria-label="Cerca un ingrediente"
        value="${esc(spesa.ingredientQuery)}" data-input="ingredient-search">
    </div>
    <div id="ingredient-list"></div>`);
  renderIngredientList();
  document.title = 'Ingredienti · Menù della settimana';
}

function priceUnitOptions(selected) {
  return Object.entries(PRICE_UNIT_NAMES)
    .map(([unit, label]) => `<option value="${unit}"${unit === selected ? ' selected' : ''}>${label}</option>`)
    .join('');
}

function renderIngredientList() {
  const container = document.getElementById('ingredient-list');
  if (!container) return;
  if (!state.ingredients.length) {
    container.innerHTML = emptyTemplate('Ancora nessun ingrediente',
      'Nascono aggiungendoli qui, nelle ricette dei piatti o importando gli scontrini.');
    return;
  }
  const fq = fold(spesa.ingredientQuery.trim());
  const visible = state.ingredients.filter((i) => !fq || fold(i.name).includes(fq));
  container.innerHTML = visible.length
    ? `<ul class="dish-rows">${visible.map((i) => (i.id === spesa.editingIngredientId ? ingredientEditRow(i) : ingredientRow(i))).join('')}</ul>`
    : emptyTemplate('Nessun ingrediente trovato', 'Prova a cambiare la ricerca.');
}

function ingredientRow(i) {
  const price = i.prices[i.unit];
  const others = Object.entries(i.prices).filter(([unit]) => unit !== i.unit);
  const priceText = price
    ? `${priceLabel(price.value, i.unit)} · ${esc(shortDate(price.date))}, ${esc(price.store)} <span class="muted">(${esc(price.product)})</span>`
    : `<span class="muted">Nessun prezzo ${PRICE_UNIT_NAMES[i.unit]}</span>`;
  const otherText = others.length
    ? ` · <span class="muted">comprato anche ${others.map(([unit, p]) => `${PRICE_UNIT_NAMES[unit]} (${priceLabel(p.value, unit)})`).join(', ')}</span>`
    : '';
  return `
    <li class="dish-row ingredient-row${i.negligible ? ' is-negligible' : ''}" data-id="${i.id}">
      <div>
        <span class="dish-name">${highlight(i.name, spesa.ingredientQuery)}</span>
        <span class="dish-notes">${priceText}${otherText}</span>
      </div>
      <span class="dish-stats">${plural(i.dishes, 'ricetta', 'ricette')} · ${plural(i.products, 'articolo', 'articoli')}</span>
      <div class="dish-actions">
        <label class="check check-sm"><input type="checkbox" data-change="ingredient-negligible"${i.negligible ? ' checked' : ''}> trascurabile</label>
        <button type="button" class="btn btn-ghost btn-sm" data-action="ingredient-edit">Modifica</button>
        <button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="ingredient-delete">Elimina</button>
      </div>
    </li>`;
}

function ingredientEditRow(i) {
  return `
    <li class="dish-row is-editing" data-id="${i.id}">
      <form class="ingredient-edit-form" data-submit="ingredient-save" data-escape="ingredient-edit-cancel" autocomplete="off">
        <input name="name" class="input" required maxlength="80" value="${esc(i.name)}" aria-label="Nome dell'ingrediente">
        <select name="unit" class="input" aria-label="Unità del prezzo">${priceUnitOptions(i.unit)}</select>
        <div class="dish-actions">
          <button type="submit" class="btn btn-primary btn-sm">Salva</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="ingredient-edit-cancel">Annulla</button>
        </div>
      </form>
    </li>`;
}

function replaceIngredient(updated) {
  state.ingredients = state.ingredients.map((i) => (i.id === updated.id ? updated : i));
}

async function addIngredient(form) {
  const data = Object.fromEntries(new FormData(form));
  try {
    const ingredient = await api('ingredient-create', { body: { ...data, negligible: Boolean(data.negligible) } });
    state.ingredients = [...state.ingredients, ingredient].sort((a, b) => a.name.localeCompare(b.name, 'it'));
    form.reset();
    form.elements.name.focus();
    renderIngredientList();
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  }
}

async function saveIngredient(form) {
  const id = form.closest('.dish-row').dataset.id;
  const current = state.ingredients.find((i) => i.id === id);
  const data = Object.fromEntries(new FormData(form));
  try {
    replaceIngredient(await api('ingredient-update', { params: { id }, body: { ...data, negligible: current.negligible } }));
    spesa.editingIngredientId = null;
    renderIngredientList();
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  }
}

async function deleteIngredient(id) {
  const i = state.ingredients.find((x) => x.id === id);
  const consequences = [
    i.dishes ? `Verrà tolto da ${plural(i.dishes, 'ricetta', 'ricette')}.` : '',
    i.products ? `${plural(i.products, 'articolo resterà', 'articoli resteranno')} senza ingrediente.` : '',
  ].filter(Boolean).join('\n');
  if (!confirm(`Eliminare l'ingrediente «${i.name}»?${consequences ? `\n\n${consequences}` : ''}`)) return;
  try {
    await api('ingredient-delete', { params: { id }, post: true });
    state.ingredients = state.ingredients.filter((x) => x.id !== id);
    renderIngredientList();
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------------

Object.assign(actions, {
  'copy-prompt': async () => {
    try {
      await copyText(spesa.prompt);
      toast("Prompt copiato: incollalo nella chat con l'AI insieme alle foto");
    } catch (err) {
      toast(err.message, 'error');
    }
  },
  'import-save': (el) => saveImport(el),
  'import-skip': (el) => skipImport(el),
  'import-reset': () => {
    const saved = spesa.import?.results.filter(Boolean) ?? [];
    spesa.import = null;
    if (!saved.length) {
      route();
      return;
    }
    toast(plural(saved.length, 'scontrino salvato', 'scontrini salvati'));
    location.hash = '#/spesa';
  },
  'receipt-edit': () => {
    spesa.receiptChoices = Object.fromEntries(
      spesa.receipt.lines.map((l) => [l.id, { product: l.product ?? '', ingredient: l.ingredient ?? '' }]),
    );
    renderReceipt();
  },
  'receipt-edit-cancel': () => {
    spesa.receiptChoices = null;
    renderReceipt();
  },
  'receipt-relink': async (el) => {
    const changed = spesa.receipt.lines
      .filter((l) => {
        const c = spesa.receiptChoices[l.id];
        return c.product !== (l.product ?? '') || c.ingredient !== (l.ingredient ?? '');
      })
      .map((l) => ({ id: l.id, ...spesa.receiptChoices[l.id] }));
    if (!changed.length) {
      actions['receipt-edit-cancel']();
      return;
    }
    el.disabled = true;
    try {
      spesa.receipt = await api('receipt-relink', { params: { id: spesa.receipt.id }, body: { lines: changed } });
      spesa.products = await api('products');
      spesa.receiptChoices = null;
      renderReceipt();
      toast(`${plural(changed.length, 'riga aggiornata', 'righe aggiornate')}`);
    } catch (err) {
      el.disabled = false;
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    }
  },
  'receipt-delete': async () => {
    const r = spesa.receipt;
    if (!confirm(`Eliminare lo scontrino ${r.store} del ${dateLabel(r.date)}?\n\nI prezzi delle sue righe spariscono dallo storico; gli abbinamenti imparati restano.`)) return;
    try {
      await api('receipt-delete', { params: { id: r.id }, post: true });
      toast('Scontrino eliminato');
      location.hash = '#/spesa';
    } catch (err) {
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    }
  },
  'product-filter': (el) => {
    spesa.productFilter.category = el.dataset.category;
    renderProductList();
  },
  'product-per-piece': () => {
    spesa.productFilter.perPiece = !spesa.productFilter.perPiece;
    renderProductList();
  },
  'product-delete': async () => {
    const p = spesa.product;
    if (!confirm(`Eliminare l'articolo «${p.name}»?\n\nLe righe degli scontrini restano, ma senza articolo.`)) return;
    try {
      await api('product-delete', { params: { id: p.id }, post: true });
      toast('Articolo eliminato');
      location.hash = '#/spesa/articoli';
    } catch (err) {
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    }
  },
  'ingredient-edit': (el) => {
    spesa.editingIngredientId = el.closest('.dish-row').dataset.id;
    renderIngredientList();
    app.querySelector('.ingredient-edit-form input[name="name"]')?.focus();
  },
  'ingredient-edit-cancel': () => {
    spesa.editingIngredientId = null;
    renderIngredientList();
  },
  'ingredient-delete': (el) => deleteIngredient(el.closest('.dish-row').dataset.id),
});

Object.assign(formHandlers, {
  'import-read': readImport,
  'product-save': saveProduct,
  'product-merge': mergeProduct,
  'ingredient-add': addIngredient,
  'ingredient-save': saveIngredient,
});

Object.assign(inputHandlers, {
  'product-search': (el) => {
    spesa.productFilter.q = el.value;
    renderProductList();
  },
  'ingredient-search': (el) => {
    spesa.ingredientQuery = el.value;
    renderIngredientList();
  },
});

Object.assign(changeHandlers, {
  // Scheda articolo: mostra il formato o il prezzo al kg, secondo come si compra.
  'product-sold': (el) => {
    for (const part of app.querySelectorAll('[data-sold]')) part.hidden = part.dataset.sold !== el.value;
  },
  'ingredient-negligible': async (el) => {
    const id = el.closest('.dish-row').dataset.id;
    const i = state.ingredients.find((x) => x.id === id);
    try {
      replaceIngredient(await api('ingredient-update', { params: { id }, body: { name: i.name, unit: i.unit, negligible: el.checked } }));
      el.closest('.dish-row').classList.toggle('is-negligible', el.checked);
    } catch (err) {
      el.checked = !el.checked;
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    }
  },
});
