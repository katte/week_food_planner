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
    const format = other.length === 1 && other[0] === 'pz' ? ", oppure indica il formato nella scheda dell'articolo" : '';
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
        <div id="recipe-lines" class="recipe-lines">${recipeLinesHtml()}</div>
      </form>
      <form class="recipe-add" data-submit="recipe-add" autocomplete="off">
        <input name="name" class="input" list="dl-ingredients" required maxlength="80" placeholder="Aggiungi un ingrediente…"
          data-input="recipe-new-name" aria-label="Ingrediente da aggiungere">
        <input name="quantity" class="input" inputmode="decimal" placeholder="Quantità" aria-label="Quantità">
        <select name="unit" class="input" aria-label="Unità">${unitOptions(ALL_UNITS, 'g')}</select>
        <button type="submit" class="btn btn-sm">${ICONS.plus}Aggiungi</button>
      </form>
      <datalist id="dl-ingredients">${state.ingredients.map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>
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
  return `
    <div class="recipe-line${counts ? '' : ' is-negligible'}" data-index="${index}">
      <span class="recipe-name">${esc(line.name)}${ingredient ? '' : ' <span class="tag tag-new">nuovo</span>'}</span>
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

// Perché la riga non entra nel costo, sotto la riga (anche da telefono, dove i title non si vedono).
function lineHintHtml(line) {
  const { missing } = lineCost(line);
  return `<span class="recipe-hint"${missing ? '' : ' hidden'}>${ICONS.warn}${esc(missing ?? '')}</span>`;
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
    row.querySelector('.recipe-hint').outerHTML = lineHintHtml(line);
    row.classList.toggle('is-negligible', !countsInCost(line));
  }
  document.getElementById('recipe-total').innerHTML = recipeTotalHtml();
}

function renderRecipeLines() {
  document.getElementById('recipe-lines').innerHTML = recipeLinesHtml();
  document.getElementById('recipe-total').innerHTML = recipeTotalHtml();
}

const draftLine = (el) => state.recipeDraft.lines[Number(el.closest('.recipe-line').dataset.index)];

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
  name.focus();
}

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

Object.assign(actions, {
  'recipe-toggle': (el) => {
    const id = el.closest('.dish-row').dataset.id;
    if (state.recipeDishId === id) closeRecipe();
    else openRecipe(id);
  },
  'recipe-close': closeRecipe,
  'recipe-remove': (el) => {
    state.recipeDraft.lines.splice(Number(el.closest('.recipe-line').dataset.index), 1);
    renderRecipeLines();
  },
});

Object.assign(formHandlers, {
  'recipe-add': addRecipeLine,
  'recipe-save': saveRecipeDraft,
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
  // Scegliendo un ingrediente esistente, propongo l'unità di cui c'è un prezzo.
  'recipe-new-name': (el) => {
    const ingredient = ingredientByName(el.value);
    if (ingredient) el.form.elements.unit.value = defaultUnitFor(ingredient);
  },
});

Object.assign(changeHandlers, {
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
