'use strict';

/*
 * Ricette dei piatti e loro costo (pagina «I miei piatti»).
 * Il costo di ogni ingrediente usa il prezzo pieno del suo acquisto più recente, nell'unità
 * di prezzo dell'ingrediente (kg, litro o pezzo); gli ingredienti trascurabili non contano.
 * Usa lo stato e le funzioni di app.js, caricato prima.
 */

// Unità delle quantità => [unità di prezzo, fattore] (come AMOUNT_UNITS in lib/groceries.php).
const AMOUNT_UNITS = { g: ['kg', 0.001], kg: ['kg', 1], ml: ['l', 0.001], l: ['l', 1], pz: ['pz', 1] };
const ALL_UNITS = Object.keys(AMOUNT_UNITS);
// Unità proposta per dosare un ingrediente, secondo l'unità del prezzo.
const DEFAULT_UNIT = { kg: 'g', l: 'ml', pz: 'pz' };
const PRICE_UNIT_NAMES = { kg: 'al kg', l: 'al litro', pz: 'al pezzo' };
// Unità con cui dosare un ingrediente per usare il prezzo che ha.
const DOSE_UNITS = { kg: 'g o kg', l: 'ml o l', pz: 'pz' };

// Nelle ricette si può usare qualsiasi unità; propongo quella di cui c'è un prezzo,
// preferendo l'unità dell'ingrediente (così il costo si calcola subito).
function defaultUnitFor(ingredient) {
  if (!ingredient) return 'g';
  const priced = Object.keys(ingredient.prices || {});
  const unit = priced.includes(ingredient.unit) || !priced.length ? ingredient.unit : priced[0];
  return DEFAULT_UNIT[unit];
}

const ingredientById = (id) => state.ingredients.find((i) => i.id === id);

function ingredientByName(name) {
  const key = fold(String(name).trim());
  return key ? state.ingredients.find((i) => fold(i.name) === key) : undefined;
}

const priceLabel = (value, unit) => `${euro(value)}/${unit}`;

function unitOptions(units, selected) {
  return units.map((u) => `<option value="${u}"${u === selected ? ' selected' : ''}>${u}</option>`).join('');
}

// La riga entra nel costo? (l'eccezione nella ricetta vince su quanto indicato sull'ingrediente)
function countsInCost(line) {
  return !(line.negligible ?? ingredientById(line.ingredientId)?.negligible ?? false);
}

// Costo di una riga: { cost, price } se calcolabile, altrimenti { negligible } o { missing: motivo }.
function lineCost(line) {
  if (!countsInCost(line)) return { negligible: true };
  const quantity = parseDecimal(line.quantity);
  if (quantity === null) return { missing: 'Manca la quantità: scrivila, o togli «nel costo» se è trascurabile', qb: true };
  if (Number.isNaN(quantity)) return { missing: 'Quantità non valida' };
  const ingredient = ingredientById(line.ingredientId);
  if (!ingredient) return { missing: 'Ingrediente nuovo: ancora nessun prezzo' };
  const [priceUnit, factor] = AMOUNT_UNITS[line.unit];
  const price = ingredient.prices?.[priceUnit];
  if (!price) {
    const other = Object.keys(ingredient.prices || {});
    if (!other.length) return { missing: 'Nessun acquisto collegato a questo ingrediente' };
    const format = other.length === 1 && other[0] === 'pz' ? ", oppure indica il formato dell'articolo (tocca il nome dell'ingrediente)" : '';
    return {
      missing: `Ha solo il prezzo ${other.map((u) => PRICE_UNIT_NAMES[u]).join(' e ')}: dosalo in ${other.map((u) => DOSE_UNITS[u]).join(' o ')}${format}`,
    };
  }
  return { cost: quantity * factor * price.value, price, priceUnit };
}

// missing: righe che non entrano nel costo e perché ({ name, reason }).
function recipeCost(lines, servings) {
  let total = 0;
  let counted = 0;
  const missing = [];
  for (const line of lines) {
    const result = lineCost(line);
    if (result.cost !== undefined) {
      total += result.cost;
      counted += 1;
    } else if (result.missing) {
      missing.push({ name: line.name ?? ingredientById(line.ingredientId)?.name ?? '?', reason: result.missing });
    }
  }
  return { total, perServing: total / Math.max(1, servings || 1), counted, missing };
}

// Riga del costo sotto il nome del piatto, nell'elenco, con l'avviso degli ingredienti che non contano.
function dishCostLabel(dish) {
  if (!dish.recipe.length) return '<span class="dish-cost is-empty">Ricetta da inserire</span>';
  const c = recipeCost(dish.recipe, dish.servings);
  const warn = c.missing.length ? `
    <span class="dish-warn" title="${esc(c.missing.map((m) => `${m.name}: ${m.reason}`).join('\n'))}">${ICONS.warn}
      Non valorizzati: ${esc(c.missing.map((m) => m.name).join(', '))}</span>` : '';
  if (!c.counted) return `<span class="dish-cost is-empty">Costo non ancora disponibile</span>${warn}`;
  return `<span class="dish-cost">${euro(c.total)}<span class="muted"> · ${euro(c.perServing)} a porzione</span></span>${warn}`;
}

// ---------------------------------------------------------------------------
// Modifica della ricetta (pannello sotto il piatto)
// ---------------------------------------------------------------------------

function openRecipe(dishId) {
  const dish = state.dishes.find((d) => d.id === dishId);
  state.editingDishId = null;
  state.recipeDishId = dishId;
  state.recipeDraft = {
    servings: dish.servings,
    lines: dish.recipe.map((line) => ({
      ingredientId: line.ingredientId,
      name: ingredientById(line.ingredientId)?.name ?? '?',
      quantity: line.quantity === null ? '' : formatDecimal(line.quantity),
      unit: line.unit,
      negligible: line.negligible,
    })),
  };
  renderDishList();
  app.querySelector('.recipe-add input[name="name"]')?.focus();
}

function closeRecipe() {
  state.recipeDishId = null;
  state.recipeDraft = null;
  renderDishList();
}

function recipePanel(dish) {
  const draft = state.recipeDraft;
  return `
    <li class="recipe-panel" data-id="${dish.id}">
      <form id="recipe-form" data-submit="recipe-save" autocomplete="off">
        <div class="recipe-head">
          <label class="recipe-servings">Ricetta per
            <input class="input" type="number" min="1" max="50" value="${draft.servings}" data-input="recipe-servings" aria-label="Porzioni">
            porzioni</label>
          <span id="recipe-total" class="recipe-total">${recipeTotalHtml()}</span>
        </div>
        <p id="recipe-groups" class="recipe-groups">${recipeGroupsHtml()}</p>
        <div id="recipe-lines" class="recipe-lines">${recipeLinesHtml()}</div>
      </form>
      <form class="recipe-add" data-submit="recipe-add" autocomplete="off">
        <div class="suggest">
          <input name="name" class="input" required maxlength="80" placeholder="Aggiungi un ingrediente…"
            data-input="recipe-new-name" aria-label="Ingrediente da aggiungere"
            role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ingredient-suggest">
          <ul id="ingredient-suggest" class="suggest-list" role="listbox" aria-label="Ingredienti" hidden></ul>
        </div>
        <input name="quantity" class="input" inputmode="decimal" placeholder="Quantità" aria-label="Quantità">
        <select name="unit" class="input" aria-label="Unità">${unitOptions(ALL_UNITS, 'g')}</select>
        <button type="submit" class="btn btn-sm">${ICONS.plus}Aggiungi</button>
      </form>
      <div class="recipe-actions">
        <button type="submit" form="recipe-form" class="btn btn-primary btn-sm">Salva ricetta</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="recipe-close">Annulla</button>
        <a class="recipe-link" href="#/spesa/ingredienti">Ingredienti e prezzi</a>
      </div>
    </li>`;
}

function recipeTotalHtml() {
  const { lines, servings } = state.recipeDraft;
  if (!lines.length) return '';
  const c = recipeCost(lines, servings);
  if (!c.counted) return '<span class="muted">Costo non disponibile: nessun ingrediente ha ancora un prezzo</span>';
  const missing = c.missing.length ? `<span class="muted"> · ${plural(c.missing.length, 'ingrediente non valorizzato', 'ingredienti non valorizzati')}</span>` : '';
  return `<b>${euro(c.total)}</b> · ${euro(c.perServing)} a porzione${missing}`;
}

function recipeLinesHtml() {
  const { lines } = state.recipeDraft;
  if (!lines.length) {
    return `<p class="recipe-empty">Nessun ingrediente: aggiungili qui sotto con le quantità per tutta la ricetta.
      Sale, olio e simili puoi lasciarli fuori dal costo.</p>`;
  }
  return lines.map(recipeLineHtml).join('');
}

function recipeLineHtml(line, index) {
  const ingredient = ingredientById(line.ingredientId);
  const counts = countsInCost(line);
  const name = ingredient
    ? `<button type="button" class="ingredient-link" data-action="ingredient-card" title="Prezzi e dati dell'ingrediente">${esc(line.name)}</button>`
    : `${esc(line.name)} <span class="tag tag-new">nuovo</span>`;
  return `
    <div class="recipe-line${counts ? '' : ' is-negligible'}" data-index="${index}">
      <span class="recipe-name">${name}<span class="recipe-group-slot">${lineGroupHtml(line)}</span></span>
      <span class="recipe-qty">
        <input class="input" inputmode="decimal" value="${esc(line.quantity)}" placeholder="q.b." data-input="recipe-qty"
          aria-label="Quantità di ${esc(line.name)}">
        <select class="input" data-change="recipe-unit" aria-label="Unità di ${esc(line.name)}">${unitOptions(ALL_UNITS, line.unit)}</select>
      </span>
      <span class="recipe-cost">${lineCostHtml(line)}</span>
      <label class="recipe-counts" title="Togli la spunta per non farlo entrare nel costo (es. sale, olio)">
        <input type="checkbox" data-change="recipe-counts"${counts ? ' checked' : ''}> nel costo</label>
      <button type="button" class="icon-x" data-action="recipe-remove" aria-label="Togli ${esc(line.name)}">${ICONS.close}</button>
      ${lineHintHtml(line)}
    </div>`;
}

// Sotto la riga (anche da telefono, dove i title non si vedono): da dove viene il prezzo,
// o perché la riga non entra nel costo.
function lineHintHtml(line) {
  const { missing, price, priceUnit } = lineCost(line);
  if (missing) return `<span class="recipe-hint">${ICONS.warn}${esc(missing)}</span>`;
  if (price) return `<span class="recipe-hint is-source">${priceSourceHtml(price, priceUnit)}</span>`;
  return '<span class="recipe-hint" hidden></span>';
}

// Il prezzo per unità e l'acquisto da cui viene: articolo, negozio, data e su cosa è calcolato
// (peso dello scontrino, formato della confezione, prezzo al kg della scheda, pezzi).
function priceSourceHtml(price, unit) {
  const p = price.purchase;
  const basis = p ? ` · ${quantityLabel(p)} a ${euro(p.priceFull)}` : '';
  return `<b>${priceLabel(price.value, unit)}</b> · ${esc(price.product)}, ${esc(price.store)} ${esc(shortDate(price.date))}${basis}`;
}

function lineCostHtml(line) {
  const result = lineCost(line);
  if (result.negligible) return '<span class="muted">trascurabile</span>';
  if (result.missing) return `<span class="muted" title="${esc(result.missing)}">${result.qb ? 'q.b.' : 'senza prezzo'}</span>`;
  const p = result.price;
  const title = `${priceLabel(p.value, result.priceUnit)} · ${p.product}, ${shortDate(p.date)} (${p.store})`;
  return `<span title="${esc(title)}">${euro(result.cost)}</span>`;
}

// Aggiorna costi e totale senza ridisegnare i campi (il cursore resta dov'è).
function refreshRecipeCosts() {
  for (const row of app.querySelectorAll('.recipe-line')) {
    const line = state.recipeDraft.lines[Number(row.dataset.index)];
    row.querySelector('.recipe-cost').innerHTML = lineCostHtml(line);
    row.querySelector('.recipe-group-slot').innerHTML = lineGroupHtml(line);
    row.querySelector('.recipe-hint').outerHTML = lineHintHtml(line);
    row.classList.toggle('is-negligible', !countsInCost(line));
  }
  document.getElementById('recipe-total').innerHTML = recipeTotalHtml();
  document.getElementById('recipe-groups').innerHTML = recipeGroupsHtml();
}

function renderRecipeLines() {
  document.getElementById('recipe-lines').innerHTML = recipeLinesHtml();
  document.getElementById('recipe-total').innerHTML = recipeTotalHtml();
  document.getElementById('recipe-groups').innerHTML = recipeGroupsHtml();
}

// Le righe della ricetta in modifica, con le quantità come numeri (come quelle salvate).
const draftRecipe = () => state.recipeDraft.lines.map((l) => ({ ...l, quantity: parseDecimal(l.quantity) }));

// Gruppo alimentare della riga, per la pagella: «poca» se a porzione ce n'è troppo poca per contare.
function lineGroupHtml(line) {
  const found = lineFoodGroup({ ...line, quantity: parseDecimal(line.quantity) }, state.recipeDraft.servings);
  if (!found) return '';
  const g = FOOD_GROUP[found.group];
  if (found.counts) {
    return `<span class="recipe-group fg fg-${g.key}" title="Nella pagella della settimana il piatto conta come ${g.name.toLowerCase()}">${g.name}</span>`;
  }
  return `<span class="recipe-group fg fg-${g.key} is-off"
    title="Troppo poca per la pagella: ${Math.round(found.grams)} g a porzione, ne servono almeno ${g.grams}">${g.name}: poca</span>`;
}

// Come conta il piatto nella pagella, mentre si scrive la ricetta.
function recipeGroupsHtml() {
  const dish = state.dishes.find((d) => d.id === state.recipeDishId);
  if (dish.foodGroups) {
    const chosen = new Set(dish.foodGroups);
    return `Per la pagella: ${chosen.size ? foodGroupChips(chosen) : 'nessun gruppo'} <span class="muted">(scelti con Modifica)</span>`;
  }
  const groups = autoDishGroups({ name: dish.name, servings: state.recipeDraft.servings, recipe: draftRecipe() });
  return groups.size
    ? `Per la pagella: ${foodGroupChips(groups)}`
    : '<span class="muted">Per la pagella: nessun gruppo riconosciuto dal nome o dagli ingredienti</span>';
}

const draftLine = (el) => state.recipeDraft.lines[Number(el.closest('.recipe-line').dataset.index)];

// Scegliendo un ingrediente esistente, propongo l'unità di cui c'è un prezzo.
function proposeUnit(input) {
  const ingredient = ingredientByName(input.value);
  if (ingredient) input.form.elements.unit.value = defaultUnitFor(ingredient);
}

function addRecipeLine(form) {
  const { name, quantity, unit } = form.elements;
  const text = name.value.trim();
  if (!text) return;
  const ingredient = ingredientByName(text);
  state.recipeDraft.lines.push({
    ingredientId: ingredient?.id ?? null,
    name: ingredient?.name ?? text,
    quantity: quantity.value.trim(),
    unit: unit.value,
    negligible: null,
  });
  renderRecipeLines();
  form.reset();
  hideSuggestions(name);
  name.focus();
}

// ---------------------------------------------------------------------------
// Suggerimenti degli ingredienti mentre si scrive
// ---------------------------------------------------------------------------
// Al posto di <datalist>, che su molti telefoni non mostra niente: prima i nomi che iniziano con
// quanto scritto, poi quelli che lo contengono. Frecce e Invio da tastiera, tocco o clic.

const SUGGEST_MAX = 8;
let suggestActive = -1; // suggerimento evidenziato con le frecce

function ingredientSuggestions(text) {
  const q = fold(text.trim());
  if (!q) return [];
  const names = state.ingredients.map((i) => i.name).filter((n) => fold(n) !== q);
  const starts = names.filter((n) => fold(n).startsWith(q));
  const contains = names.filter((n) => !fold(n).startsWith(q) && fold(n).includes(q));
  return [...starts, ...contains].slice(0, SUGGEST_MAX);
}

function showSuggestions(input) {
  const list = document.getElementById('ingredient-suggest');
  const names = ingredientSuggestions(input.value);
  suggestActive = -1;
  list.innerHTML = names.map((n, i) => `
    <li id="ingredient-suggest-${i}" role="option" data-action="suggest-pick" data-name="${esc(n)}">${highlight(n, input.value)}</li>`).join('');
  list.hidden = !names.length;
  input.setAttribute('aria-expanded', String(names.length > 0));
  input.removeAttribute('aria-activedescendant');
  if (!names.length) return;
  // Sul telefono, se sotto il campo resta poco spazio (c'è la tastiera), l'elenco va sopra.
  const height = window.visualViewport?.height ?? window.innerHeight;
  const r = input.getBoundingClientRect();
  list.classList.toggle('is-above', height - r.bottom < 220 && r.top > height - r.bottom);
}

function hideSuggestions(input) {
  const list = document.getElementById('ingredient-suggest');
  if (list) list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  suggestActive = -1;
}

function pickSuggestion(input, name) {
  input.value = name;
  hideSuggestions(input);
  proposeUnit(input);
  input.form.elements.quantity.focus();
}

function moveSuggestion(input, step) {
  const items = [...document.querySelectorAll('#ingredient-suggest li')];
  const states = items.length + 1; // i suggerimenti più «nessuno» (-1)
  suggestActive = ((suggestActive + 1 + step + states) % states) - 1;
  items.forEach((li, i) => li.classList.toggle('is-active', i === suggestActive));
  if (suggestActive < 0) input.removeAttribute('aria-activedescendant');
  else input.setAttribute('aria-activedescendant', items[suggestActive].id);
}

app.addEventListener('keydown', (e) => {
  const input = e.target.closest?.('[data-input="recipe-new-name"]');
  const list = document.getElementById('ingredient-suggest');
  if (!input || !list || list.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSuggestion(input, e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter' && suggestActive >= 0) {
    e.preventDefault(); // sceglie il suggerimento invece di aggiungere la riga
    pickSuggestion(input, list.children[suggestActive].dataset.name);
  } else if (e.key === 'Escape') {
    hideSuggestions(input);
  }
});

// Il campo resta attivo toccando un suggerimento (sul telefono la tastiera non si chiude).
app.addEventListener('mousedown', (e) => {
  if (e.target.closest('.suggest-list')) e.preventDefault();
});

app.addEventListener('focusout', (e) => {
  const input = e.target.closest?.('[data-input="recipe-new-name"]');
  if (input) setTimeout(() => { if (document.activeElement !== input) hideSuggestions(input); }, 150);
});

async function saveRecipeDraft() {
  const dishId = state.recipeDishId;
  const { servings, lines } = state.recipeDraft;
  const invalid = lines.find((l) => Number.isNaN(parseDecimal(l.quantity)));
  if (invalid) {
    toast(`Quantità non valida per «${invalid.name}»`, 'error');
    return;
  }
  const payload = lines.map((l) => ({
    ingredientId: l.ingredientId,
    ingredientName: l.ingredientId ? undefined : l.name,
    quantity: parseDecimal(l.quantity),
    unit: l.unit,
    negligible: l.negligible,
  }));
  try {
    const dish = await api('dish-recipe', { params: { id: dishId }, body: { servings, lines: payload } });
    if (payload.some((l) => !l.ingredientId)) state.ingredients = await api('ingredients');
    state.dishes = state.dishes.map((d) => (d.id === dishId ? dish : d));
    closeRecipe();
    toast(`Ricetta di «${dish.name}» salvata`);
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Scheda dell'ingrediente (finestra aperta dal suo nome nella ricetta)
// ---------------------------------------------------------------------------
// Da dove viene il prezzo, e i dati da correggere al volo senza lasciare la ricetta in modifica:
// l'ingrediente e, per gli articoli collegati, il formato della confezione o il prezzo al kg.

const ingredientCard = {
  dialog: document.getElementById('ingredient-card'),
  body: document.getElementById('ingredient-card-body'),
  id: null,
  products: [],
  changed: false, // salvato qualcosa: alla chiusura si aggiornano i costi dei piatti
};

async function openIngredientCard(id) {
  Object.assign(ingredientCard, { id, products: [], changed: false });
  document.getElementById('ingredient-card-title').textContent = ingredientById(id)?.name ?? '';
  ingredientCard.body.innerHTML = '<p class="loading">Caricamento…</p>';
  ingredientCard.dialog.showModal();
  await reloadIngredientCard();
}

// Ricarica sempre prezzi e articoli: possono essere cambiati da un'altra pagina.
async function reloadIngredientCard() {
  const card = ingredientCard;
  try {
    const [ingredients, products] = await Promise.all([api('ingredients'), api('products')]);
    state.ingredients = ingredients;
    card.products = products.filter((p) => p.ingredientId === card.id);
    if (state.recipeDraft) {
      for (const line of state.recipeDraft.lines) line.name = ingredientById(line.ingredientId)?.name ?? line.name;
      renderRecipeLines();
    }
    if (card.dialog.open) renderIngredientCard();
  } catch (err) {
    if (!(err instanceof AuthError)) card.body.innerHTML = `<p class="login-error">${esc(err.message)}</p>`;
  }
}

function renderIngredientCard() {
  const i = ingredientById(ingredientCard.id);
  document.getElementById('ingredient-card-title').textContent = i?.name ?? '';
  if (!i) {
    ingredientCard.body.innerHTML = '<p class="picker-empty">Questo ingrediente non esiste più.</p>';
    return;
  }
  // Prima il prezzo nell'unità dell'ingrediente, poi gli altri.
  const units = Object.keys(i.prices).sort((a, b) => (b === i.unit) - (a === i.unit));
  const prices = units.length
    ? `<ul class="card-prices">${units.map((u) => `
        <li>${priceSourceHtml(i.prices[u], u)}<small>Nelle ricette dosalo in ${DOSE_UNITS[u]}.</small></li>`).join('')}</ul>`
    : '<p class="muted">Ancora nessun prezzo: arriva dagli scontrini, con un articolo collegato a questo ingrediente.</p>';
  const products = ingredientCard.products.length
    ? `<p class="card-help">Per gli acquisti in cui lo scontrino non riporta né peso né formato, il prezzo al kg o al litro
        si calcola dal <b>formato</b> della confezione, o dal <b>prezzo al kg</b> per le cose prese al banco.</p>
      ${ingredientCard.products.map(cardProductForm).join('')}`
    : '<p class="muted">Nessun articolo collegato: si collegano dagli scontrini o dalla scheda di un articolo.</p>';

  ingredientCard.body.innerHTML = `
    <p id="ingredient-card-message" class="card-message" role="status" hidden></p>
    <section class="card-section">
      <h3>Prezzo usato nelle ricette</h3>
      ${prices}
    </section>
    <section class="card-section">
      <h3>Articoli collegati</h3>
      ${products}
    </section>
    <section class="card-section">
      <h3>Ingrediente</h3>
      <form class="card-ingredient" data-submit="card-ingredient-save" autocomplete="off">
        <label class="field"><span>Nome</span>
          <input name="name" required maxlength="80" value="${esc(i.name)}"></label>
        <label class="field"><span>Prezzo</span>
          <select name="unit">${priceUnitOptions(i.unit)}</select></label>
        <label class="field card-ingredient-group"><span>Gruppo alimentare, per la pagella della settimana</span>
          <select name="foodGroup">${foodGroupOptions(i)}</select></label>
        <label class="check"><input type="checkbox" name="negligible"${i.negligible ? ' checked' : ''}> Trascurabile, fuori dal costo</label>
        <button type="submit" class="btn btn-sm">Salva</button>
      </form>
    </section>`;
}

function cardProductForm(p) {
  const byWeight = p.pricePerKg !== null;
  const hidden = (sold) => ((sold === 'weight') === byWeight ? '' : ' hidden');
  return `
    <form class="card-product" data-submit="card-product-save" data-id="${p.id}" autocomplete="off">
      <a class="card-product-name" href="#/spesa/articoli/${p.id}" target="_blank" rel="noopener"
        title="Scheda completa dell'articolo, in un'altra scheda del browser">${esc(p.name)}</a>
      <span class="muted">${p.brand ? `${esc(p.brand)} · ` : ''}${plural(p.purchases, 'acquisto', 'acquisti')}</span>
      <div class="card-product-fields">
        <select name="sold" class="input" data-change="card-product-sold" aria-label="Come si compra ${esc(p.name)}">
          <option value="pack"${byWeight ? '' : ' selected'}>in confezione</option>
          <option value="weight"${byWeight ? ' selected' : ''}>a peso, al banco</option>
        </select>
        <span class="inline-inputs" data-sold="pack"${hidden('pack')}>
          <input name="packageSize" class="input" inputmode="decimal" placeholder="formato" aria-label="Formato della confezione"
            value="${p.packageSize === null ? '' : formatDecimal(p.packageSize)}">
          <select name="packageUnit" class="input" aria-label="Unità del formato">${['', ...ALL_UNITS]
            .map((u) => `<option value="${u}"${u === (p.packageUnit ?? '') ? ' selected' : ''}>${u || '—'}</option>`).join('')}</select>
        </span>
        <span class="inline-inputs" data-sold="weight"${hidden('weight')}>
          <input name="pricePerKg" class="input" inputmode="decimal" placeholder="es. 13,50" aria-label="Prezzo al kg"
            value="${byWeight ? formatDecimal(p.pricePerKg) : ''}"><span class="unit-after">€/kg</span>
        </span>
        <button type="submit" class="btn btn-sm">Salva</button>
      </div>
      ${byWeight ? `<label class="check check-sm" data-sold="weight"><input type="checkbox" name="repriceAll">
        Nuovo prezzo anche agli acquisti passati</label>` : ''}
    </form>`;
}

async function saveCardProduct(form) {
  const p = ingredientCard.products.find((x) => x.id === form.dataset.id);
  const { sold, packageSize = '', packageUnit = '', pricePerKg = '', repriceAll } = Object.fromEntries(new FormData(form));
  const byWeight = sold === 'weight';
  await saveFromCard(form, `«${p.name}» salvato: prezzi ricalcolati`, () => api('product-update', {
    params: { id: p.id },
    body: {
      name: p.name,
      brand: p.brand,
      category: p.category,
      ingredient: p.ingredient,
      // Vale solo il campo del modo scelto, come nella scheda dell'articolo.
      packageSize: byWeight ? '' : packageSize,
      packageUnit: byWeight ? '' : packageUnit,
      pricePerKg: byWeight ? pricePerKg : '',
      repriceAll: Boolean(repriceAll),
    },
  }));
}

async function saveCardIngredient(form) {
  const { name, unit, negligible, foodGroup } = Object.fromEntries(new FormData(form));
  await saveFromCard(form, 'Ingrediente salvato', () => api('ingredient-update', {
    params: { id: ingredientCard.id },
    body: { name, unit, negligible: Boolean(negligible), foodGroup: foodGroupValue(foodGroup) },
  }));
}

// I messaggi stanno nella finestra: i toast resterebbero sotto, coperti.
async function saveFromCard(form, message, save) {
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await save();
    ingredientCard.changed = true;
    await reloadIngredientCard();
    showCardMessage(message);
    // Finestra chiusa mentre si salvava: l'elenco dei piatti si aggiorna adesso.
    if (!ingredientCard.dialog.open) renderDishList();
  } catch (err) {
    button.disabled = false;
    if (!(err instanceof AuthError)) showCardMessage(err.message, true);
  }
}

function showCardMessage(text, isError = false) {
  const el = document.getElementById('ingredient-card-message');
  if (!el) return;
  el.textContent = text;
  el.className = isError ? 'card-message login-error' : 'card-message login-note';
  el.hidden = false;
}

// La finestra sta fuori da #app: i suoi eventi vanno agli stessi gestori.
ingredientCard.dialog.addEventListener('click', (e) => {
  if (e.target === ingredientCard.dialog) return ingredientCard.dialog.close(); // clic sullo sfondo
  const el = e.target.closest('[data-action]');
  if (el) actions[el.dataset.action]?.(el, e);
});
ingredientCard.dialog.addEventListener('submit', (e) => {
  e.preventDefault();
  formHandlers[e.target.dataset.submit]?.(e.target, e);
});
ingredientCard.dialog.addEventListener('change', (e) => changeHandlers[e.target.dataset.change]?.(e.target, e));
ingredientCard.dialog.addEventListener('close', () => {
  if (ingredientCard.changed) renderDishList();
});

Object.assign(actions, {
  'ingredient-card': (el) => openIngredientCard(draftLine(el).ingredientId),
  'ingredient-card-close': () => ingredientCard.dialog.close(),
  'recipe-toggle': (el) => {
    const id = el.closest('.dish-row').dataset.id;
    if (state.recipeDishId === id) closeRecipe();
    else openRecipe(id);
  },
  'recipe-close': closeRecipe,
  'suggest-pick': (el) => pickSuggestion(app.querySelector('[data-input="recipe-new-name"]'), el.dataset.name),
  'recipe-remove': (el) => {
    state.recipeDraft.lines.splice(Number(el.closest('.recipe-line').dataset.index), 1);
    renderRecipeLines();
  },
});

Object.assign(formHandlers, {
  'recipe-add': addRecipeLine,
  'recipe-save': saveRecipeDraft,
  'card-product-save': saveCardProduct,
  'card-ingredient-save': saveCardIngredient,
});

Object.assign(inputHandlers, {
  'recipe-qty': (el) => {
    draftLine(el).quantity = el.value;
    refreshRecipeCosts();
  },
  'recipe-servings': (el) => {
    const n = Math.round(Number(el.value));
    if (n >= 1 && n <= 50) {
      state.recipeDraft.servings = n;
      refreshRecipeCosts();
    }
  },
  'recipe-new-name': (el) => {
    proposeUnit(el);
    showSuggestions(el);
  },
});

Object.assign(changeHandlers, {
  'card-product-sold': (el) => {
    for (const part of el.form.querySelectorAll('[data-sold]')) part.hidden = part.dataset.sold !== el.value;
  },
  'recipe-unit': (el) => {
    draftLine(el).unit = el.value;
    refreshRecipeCosts();
  },
  'recipe-counts': (el) => {
    const line = draftLine(el);
    const byDefault = !(ingredientById(line.ingredientId)?.negligible ?? false);
    // Salvo un'eccezione solo se diversa da quanto indicato sull'ingrediente.
    line.negligible = el.checked === byDefault ? null : !el.checked;
    refreshRecipeCosts();
  },
});
