'use strict';

/*
 * Pagella della settimana: quanto il menù segue le frequenze della dieta mediterranea.
 * Ogni piatto ha dei gruppi alimentari (verdura, pesce, legumi…): li riconosce il sito dal nome
 * del piatto e dagli ingredienti della ricetta, oppure li sceglie l'utente. Si contano i pasti
 * della settimana che contengono ogni gruppo e si confrontano con le frequenze consigliate.
 * Nessun dato esterno: solo un dizionario di parole, come per i reparti della spesa.
 * Usa lo stato e le funzioni di app.js e shopping.js, caricati prima.
 */

// Gruppi (le chiavi sono anche in api.php), con le frequenze a settimana della piramide della
// dieta mediterranea (Fondazione Dieta Mediterranea, 2010): verdura a ogni pasto, pesce e legumi
// almeno 2 volte, carne rossa meno di 2, salumi al massimo 1, carne bianca circa 2, uova 2-4;
// formaggi come piatto principale non più di 3 volte.
// points: peso nel voto (in tutto 100). grams: quanto ne serve a porzione, in una ricetta, perché
// il piatto conti (circa metà di una porzione standard: un po' di parmigiano grattugiato non fa
// di una pasta un piatto di formaggio).
const FOOD_GROUPS = [
  { key: 'verdura', name: 'Verdura', grams: 60, points: 30 },
  { key: 'pesce', name: 'Pesce', grams: 40, min: 2, points: 15 },
  { key: 'legumi', name: 'Legumi', grams: 30, min: 2, points: 15 },
  { key: 'carne_rossa', name: 'Carne rossa', grams: 50, max: 1, points: 15 },
  { key: 'salumi', name: 'Salumi', grams: 25, max: 1, points: 10 },
  { key: 'carne_bianca', name: 'Carne bianca', grams: 50, max: 3, points: 5 },
  { key: 'uova', name: 'Uova', grams: 25, max: 4, points: 5 },
  { key: 'formaggi', name: 'Formaggi', grams: 25, max: 3, points: 5 },
];
const FOOD_GROUP = Object.fromEntries(FOOD_GROUPS.map((g) => [g.key, g]));

// Voto dai punti: A da 85, B da 70, C da 55, D da 40, sotto E.
const FOOD_GRADES = [[85, 'A'], [70, 'B'], [55, 'C'], [40, 'D'], [0, 'E']];

// Peso di un pezzo, per le ricette dosate in pezzi.
const PIECE_GRAMS = { uova: 50 };
const DEFAULT_PIECE_GRAMS = 100;

// Parole per gruppo, come in SHOP_WORDS (singolare o plurale, espressioni dopo il punto e virgola).
// «nessuno» toglie dal conto cose che altrimenti sembrerebbero di un gruppo (il sugo di pomodoro
// non è una porzione di verdura, le patate nemmeno: «pomodoro» al singolare, come in «pasta al
// pomodoro», è quasi sempre il sugo) e parole simili a quelle di un gruppo (grano / grana,
// pesca / pesce, polpa / polpo).
const FOOD_WORDS = {
  verdura: `verdura verdure ortaggi insalata insalate lattuga rucola valeriana songino misticanza radicchio indivia
    scarola cicoria catalogna puntarelle spinaci bietola bietole erbette cavolo cavolfiore cavolini broccolo broccoli
    broccoletti verza cappuccio crauti carota carote cipolla cipolle porro porri sedano finocchio finocchi zucchina
    zucchine zucchino zucca melanzana melanzane peperone peperoni pomodori pomodorini ciliegini datterini
    cetriolo cetrioli fagiolini taccole asparago asparagi carciofo carciofi fungo funghi champignon ravanelli rapa rape
    barbabietola barbabietole friarielli germogli;
    cime di rapa; cavolo nero; cavolini di bruxelles; erbe di campo`,
  legumi: `legumi fagioli borlotti cannellini ceci lenticchie piselli fave cicerchie lupini soia edamame tofu tempeh`,
  pesce: `pesce pesci salmone tonno merluzzo baccala stoccafisso nasello orata branzino spigola sogliola platessa
    trota sgombro alici acciughe sardine sarde aringa pangasio persico cernia dentice rombo palombo halibut gamberi
    gamberetti mazzancolle scampi astice aragosta granchio calamari calamaretti totani seppia seppie polpo polpi
    moscardini cozze vongole ostriche capesante surimi;
    frutti di mare`,
  carne_rossa: `manzo vitello vitellone bovino maiale suino agnello capretto cavallo macinato macinata hamburger
    bistecca bistecche lonza arista costine braciola braciole;
    roast beef; carne macinata; carne trita`,
  carne_bianca: `pollo tacchino coniglio faraona anatra quaglia cappone gallina petto sovracosce alette`,
  salumi: `salumi salume prosciutto salame salamino mortadella speck bresaola pancetta guanciale lardo wurstel
    salsiccia salsicce salamella cotechino zampone nduja porchetta culatello affettati`,
  uova: `uovo uova frittata omelette`,
  formaggi: `formaggio formaggi mozzarella mozzarelline parmigiano grana pecorino ricotta stracchino crescenza
    robiola gorgonzola fontina emmental emmenthal asiago taleggio provola provolone scamorza burrata stracciatella
    mascarpone feta brie camembert caciotta caciocavallo quartirolo edamer montasio sottilette philadelphia;
    primo sale; fiocchi di latte`,
  nessuno: `patata patate patatine pomodoro sugo passata pelati concentrato polpa grano pesca pesche;
    passata di pomodoro; polpa di pomodoro; pomodori pelati; concentrato di pomodoro; salsa di pomodoro`,
};

// Nomi di piatti che dicono di cosa sono fatti (solo nei nomi dei piatti, anche più gruppi).
const DISH_WORDS = {
  carbonara: ['salumi', 'uova'],
  amatriciana: ['salumi'],
  gricia: ['salumi'],
  bolognese: ['carne_rossa'],
  ragu: ['carne_rossa'],
  hamburger: ['carne_rossa'],
  cheeseburger: ['carne_rossa', 'formaggi'],
  saltimbocca: ['carne_rossa', 'salumi'],
  pizza: ['formaggi'],
  caprese: ['formaggi', 'verdura'],
  parmigiana: ['verdura', 'formaggi'],
  minestrone: ['verdura'],
  caponata: ['verdura'],
  peperonata: ['verdura'],
  ratatouille: ['verdura'],
  vellutata: ['verdura'],
  quiche: ['uova', 'formaggi'],
  hummus: ['legumi'],
  falafel: ['legumi'],
  farinata: ['legumi'],
  panelle: ['legumi'],
  sushi: ['pesce'],
};

const FOOD_INDEX = wordIndex(FOOD_WORDS);

const foodWord = (word) => FOOD_INDEX.exact.get(word) ?? FOOD_INDEX.stems.get(shopStem(word)) ?? null;

// Gruppo di un ingrediente dal nome: la prima espressione o parola riconosciuta. '' = nessuno.
function ingredientAutoGroup(name) {
  const term = shopTerm(name);
  const padded = ` ${term} `;
  let found = FOOD_INDEX.phrases.find(([phrase]) => padded.includes(phrase))?.[1] ?? null;
  for (const word of term.split(' ')) found ??= foodWord(word);
  return found && found !== 'nessuno' ? found : '';
}

// Gruppo di un ingrediente: quello scelto (anche nessuno, '') o quello riconosciuto dal nome.
const ingredientFoodGroup = (ingredient) => ingredient.foodGroup ?? ingredientAutoGroup(ingredient.name);

const wordKey = (word) => (shopStem(word).length >= 3 ? shopStem(word) : word); // singolare e plurale insieme

// Parole degli ingredienti a cui l'utente ha scelto un gruppo (anche nessuno): nei nomi dei piatti
// valgono prima del dizionario, così «salamella» messa tra la carne rossa conta come carne rossa
// anche in «Pasta e salamella». Di un nome di più parole valgono quelle che il dizionario conosce
// («salamella di maiale» → salamella, maiale). Si ricalcola solo quando cambiano gli ingredienti.
let chosenWords = { ingredients: null, groups: new Map() };

function chosenWordGroups() {
  if (chosenWords.ingredients === state.ingredients) return chosenWords.groups;
  const groups = new Map();
  for (const ingredient of state.ingredients ?? []) {
    if (ingredient.foodGroup === null || ingredient.foodGroup === undefined) continue;
    const words = shopTerm(ingredient.name).split(' ').filter(Boolean);
    for (const word of words) {
      if (words.length === 1 || foodWord(word)) groups.set(wordKey(word), ingredient.foodGroup || 'nessuno');
    }
  }
  chosenWords = { ingredients: state.ingredients, groups };
  return groups;
}

// Tutti i gruppi nominati nel nome di un piatto («Pasta e ceci con le cozze» → legumi, pesce).
function nameFoodGroups(name) {
  let padded = ` ${shopTerm(name)} `;
  const groups = new Set();
  for (const [phrase, key] of FOOD_INDEX.phrases) {
    if (!padded.includes(phrase)) continue;
    groups.add(key);
    padded = padded.replace(phrase, ' ');
  }
  const chosen = chosenWordGroups();
  for (const word of padded.trim().split(' ').filter(Boolean)) {
    const keys = chosen.has(wordKey(word)) ? [chosen.get(wordKey(word))]
      : Object.hasOwn(DISH_WORDS, word) ? DISH_WORDS[word] : [foodWord(word)];
    for (const key of keys) if (key) groups.add(key);
  }
  groups.delete('nessuno');
  return groups;
}

// Grammi a porzione di una riga della ricetta; null senza quantità (o se non è un numero).
function servingGrams(line, group, servings) {
  if (typeof line.quantity !== 'number' || Number.isNaN(line.quantity)) return null;
  const grams = { g: 1, ml: 1, kg: 1000, l: 1000 }[line.unit] ?? PIECE_GRAMS[group] ?? DEFAULT_PIECE_GRAMS;
  return (line.quantity * grams) / Math.max(1, servings || 1);
}

// Gruppo di una riga della ricetta e se conta per il piatto: senza quantità conta sempre (nel
// dubbio), con la quantità solo se a porzione ce n'è abbastanza. Un ingrediente non ancora salvato
// prende il gruppo dal nome. null se l'ingrediente non è di nessun gruppo.
function lineFoodGroup(line, servings) {
  const ingredient = ingredientById(line.ingredientId);
  const group = ingredient ? ingredientFoodGroup(ingredient) : ingredientAutoGroup(line.name ?? '');
  if (!group) return null;
  const grams = servingGrams(line, group, servings);
  return { group, grams, counts: grams === null || grams >= FOOD_GROUP[group].grams };
}

// Gruppi riconosciuti dal sito: quelli degli ingredienti della ricetta che contano, più quelli del
// nome che la ricetta non dice già. Se in ricetta c'è un ingrediente di quel gruppo (per il
// dizionario o per scelta dell'utente), decide l'ingrediente, con il suo gruppo e la sua quantità:
// «Salsiccia alla griglia» con la salamella messa tra la carne rossa è carne rossa, non salumi, e
// una carbonara con poca pancetta non conta come salumi. Le ricette senza la verdura del nome
// («Pasta zucca e salsiccia» senza la zucca) la prendono comunque dal nome.
function autoDishGroups(dish) {
  const groups = new Set();
  const covered = new Set();
  for (const line of dish.recipe ?? []) {
    covered.add(ingredientAutoGroup(ingredientById(line.ingredientId)?.name ?? line.name ?? ''));
    const found = lineFoodGroup(line, dish.servings);
    if (found) covered.add(found.group);
    if (found?.counts) groups.add(found.group);
  }
  for (const group of nameFoodGroups(dish.name)) if (!covered.has(group)) groups.add(group);
  return groups;
}

// Gruppi di un piatto: quelli scelti dall'utente (anche nessuno) o quelli riconosciuti.
const dishFoodGroups = (dish) => (dish.foodGroups ? new Set(dish.foodGroups) : autoDishGroups(dish));

const sortedGroups = (groups) => FOOD_GROUPS.filter((g) => groups.has(g.key));

// ---------------------------------------------------------------------------
// Pagella
// ---------------------------------------------------------------------------

// Pasti della settimana con ogni gruppo, punti, voto e piatti di cui non si conosce nessun gruppo.
// slots: i pasti pianificati, con i gruppi di ogni piatto ({ day, meal, groups, dishes: [{ name, groups }] }).
function weekScore(week) {
  const counts = Object.fromEntries(FOOD_GROUPS.map((g) => [g.key, 0]));
  const unknown = new Set();
  const slots = [];
  for (const [day, mealsOfDay] of Object.entries(week.meals)) {
    for (const [meal, entries] of Object.entries(mealsOfDay)) {
      if (!entries.length) continue;
      const dishes = entries.map((entry) => {
        const dish = state.dishes.find((d) => d.id === entry.dishId);
        const groups = dish ? dishFoodGroups(dish) : nameFoodGroups(entry.name);
        if (!groups.size && !dish?.foodGroups) unknown.add(entry.name);
        return { name: entry.name, groups };
      });
      // Un gruppo conta una volta per pasto, anche se in due piatti.
      const groups = new Set(dishes.flatMap((d) => [...d.groups]));
      for (const g of groups) counts[g] += 1;
      slots.push({ day, meal, groups, dishes });
    }
  }
  const meals = slots.length;
  const items = FOOD_GROUPS.map((g) => {
    const count = counts[g.key];
    let share;
    let ok;
    if (g.key === 'verdura') {
      share = meals ? count / meals : 0;
      ok = share >= 0.8;
    } else if (g.min) {
      share = Math.min(count / g.min, 1);
      ok = count >= g.min;
    } else {
      share = Math.max(0, 1 - Math.max(0, count - g.max) / 2); // metà dei punti per ogni volta di troppo
      ok = count <= g.max;
    }
    return { ...g, count, score: g.points * share, ok };
  });
  const total = Math.round(items.reduce((sum, i) => sum + i.score, 0));
  return { meals, slots, items, total, grade: FOOD_GRADES.find(([min]) => total >= min)[1], unknown: [...unknown] };
}

// Gruppo aperto nel riquadro della pagella: i suoi pasti sono elencati ed evidenziati nel tabellone.
let scoreOpenGroup = null;

// I pasti della settimana con il gruppo, nell'ordine del tabellone; per la verdura anche quelli senza.
function scoreDetailHtml(s, key) {
  const g = FOOD_GROUP[key];
  const rows = weekDays(state.week.key).flatMap((day) => MEALS.map((meal) => ({
    when: `${day.name} ${fmtShort.format(day.date)}, ${meal.name.toLowerCase()}`,
    slot: s.slots.find((x) => x.day === day.key && x.meal === meal.key),
  }))).filter((r) => r.slot);
  const list = (items, names) => `<ul class="score-meals">${items.map((r) => `
    <li><span class="score-when">${r.when}</span> ${esc(names(r.slot).join(', '))}</li>`).join('')}</ul>`;
  const withGroup = rows.filter((r) => r.slot.groups.has(key));
  let html = withGroup.length
    ? `<p><b>${g.name}</b> in ${plural(withGroup.length, 'pasto', 'pasti')}:</p>
      ${list(withGroup, (slot) => slot.dishes.filter((d) => d.groups.has(key)).map((d) => d.name))}`
    : `<p>Nessun pasto con ${g.name.toLowerCase()} questa settimana.</p>`;
  const without = key === 'verdura' ? rows.filter((r) => !r.slot.groups.has(key)) : [];
  if (without.length) html += `<p>Senza verdura:</p>${list(without, (slot) => slot.dishes.map((d) => d.name))}`;
  return `<div class="score-detail fg-${key}">${html}</div>`;
}

function scoreItemText(item, meals) {
  if (item.key === 'verdura') return `${item.name} <b>${item.count}</b> pasti su ${meals}`;
  const rule = item.min ? `almeno ${item.min}` : `al massimo ${item.max}`;
  return `${item.name} <b>${item.count}</b> <span class="score-rule">(${rule})</span>`;
}

// Il voto accanto al titolo della settimana, il dettaglio sotto il tabellone; si aggiornano a
// ogni piatto aggiunto, tolto o spostato.
function renderWeekScore() {
  const el = document.getElementById('week-score');
  if (!el || !state.week) return;
  const s = weekScore(state.week);
  const badge = document.getElementById('week-grade');
  badge.hidden = el.hidden = s.meals === 0;
  if (!s.meals) return;
  badge.textContent = s.grade;
  badge.className = `week-grade grade-${s.grade.toLowerCase()}`;
  badge.title = `Pagella della settimana: ${s.total}/100. Tocca per il dettaglio`;
  badge.setAttribute('aria-label', `Pagella della settimana: ${s.grade}, ${s.total} punti su 100. Vai al dettaglio`);
  if (!s.items.some((i) => i.key === scoreOpenGroup)) scoreOpenGroup = null;
  const howOpen = el.querySelector('.score-how')?.open ? ' open' : ''; // resta aperto mentre si cambia il menù
  const unknown = s.unknown.length ? `
    <p class="score-unknown">${ICONS.warn}<span>Non so cosa contengono: ${esc(s.unknown.join(', '))}.
      Indicalo in <a href="#/piatti">I miei piatti</a>, con <b>Modifica</b> o nella ricetta.</span></p>` : '';
  el.innerHTML = `
    <span class="score-grade grade-${s.grade.toLowerCase()}" title="${s.total} punti su 100">${s.grade}</span>
    <div class="score-body">
      <p class="score-title"><b>Pagella della settimana</b>
        <span class="muted">${s.total}/100 · ${plural(s.meals, 'pasto', 'pasti')} · dieta mediterranea</span></p>
      <ul class="score-items">${s.items.map((i) => `
        <li><button type="button" class="score-item fg fg-${i.key}${i.ok ? ' is-ok' : ' is-off'}" data-action="score-group"
          data-group="${i.key}" aria-expanded="${i.key === scoreOpenGroup}">${scoreItemText(i, s.meals)}</button></li>`).join('')}</ul>
      ${scoreOpenGroup ? scoreDetailHtml(s, scoreOpenGroup) : '<p class="score-tip">Tocca un gruppo per vedere in quali pasti si trova.</p>'}
      ${unknown}
      <details class="score-how"${howOpen}>
        <summary>Come si calcola</summary>
        <p>Per ogni pasto si guardano i gruppi alimentari dei suoi piatti, riconosciuti dagli ingredienti della ricetta
          (senza quantità contano sempre; con la quantità, solo se a porzione ce n'è abbastanza: un po' di parmigiano
          grattugiato non fa di una pasta un piatto di formaggio) e dal nome del piatto, per quello che la ricetta non
          dice già. Oppure scelti da te in <b>I miei piatti → Modifica</b>. Il gruppo che scegli per un ingrediente
          vale anche nei nomi dei piatti.
          Poi si confrontano con le frequenze della piramide della dieta mediterranea: verdura a ogni pasto (30 punti),
          pesce e legumi almeno 2 volte (15 punti ciascuno), carne rossa al massimo 1 (15), salumi al massimo 1 (10),
          carne bianca al massimo 3, uova al massimo 4, formaggi al massimo 3 (5 punti ciascuno). Per ogni volta di
          troppo si perde metà dei punti del gruppo. Voto: A da 85 punti, B da 70, C da 55, D da 40, poi E.</p>
      </details>
    </div>`;
  // Nel tabellone, il bordo del colore del gruppo aperto sui pasti che lo contengono.
  for (const slotEl of app.querySelectorAll('.slot')) {
    const hit = scoreOpenGroup && s.slots.some((x) => x.day === slotEl.dataset.day && x.meal === slotEl.dataset.meal && x.groups.has(scoreOpenGroup));
    if (hit) slotEl.dataset.fg = scoreOpenGroup;
    else delete slotEl.dataset.fg;
  }
}

// ---------------------------------------------------------------------------
// Gruppi di piatti e ingredienti (elenco dei piatti, modifica, scheda dell'ingrediente)
// ---------------------------------------------------------------------------

function foodGroupChips(groups) {
  return sortedGroups(groups).map((g) => `<span class="fg fg-${g.key}">${g.name}</span>`).join('');
}

// Sotto il nome nell'elenco dei piatti.
function dishGroupsLabel(dish) {
  const groups = dishFoodGroups(dish);
  if (!groups.size) return '';
  const title = dish.foodGroups ? 'Gruppi alimentari scelti da te' : 'Gruppi alimentari riconosciuti dal sito: puoi cambiarli con Modifica';
  return `<span class="dish-groups" title="${title}">${foodGroupChips(groups)}</span>`;
}

// Nella riga di modifica del piatto: riconosciuti dal sito, oppure scelti a mano.
function dishGroupsEditHtml(dish) {
  const auto = !dish.foodGroups;
  const groups = dishFoodGroups(dish);
  return `
    <fieldset class="dish-groups-edit">
      <legend>Gruppi alimentari, per la pagella della settimana</legend>
      <label class="check check-sm"><input type="checkbox" name="groupsAuto" data-change="dish-groups-auto"${auto ? ' checked' : ''}>
        riconosciuti dal sito</label>
      <div class="fg-toggles">${FOOD_GROUPS.map((g) => `
        <label class="fg-toggle fg fg-${g.key}"><input type="checkbox" name="foodGroups" value="${g.key}"${groups.has(g.key) ? ' checked' : ''}${auto ? ' disabled' : ''}>
          ${g.name}</label>`).join('')}</div>
    </fieldset>`;
}

// null se riconosciuti dal sito, altrimenti i gruppi spuntati (anche nessuno).
function dishGroupsFromForm(form) {
  return form.elements.groupsAuto.checked ? null : new FormData(form).getAll('foodGroups');
}

// Scelta del gruppo di un ingrediente: automatico (dal nome), uno dei gruppi o nessuno.
function foodGroupOptions(ingredient) {
  const auto = ingredientAutoGroup(ingredient.name);
  const selected = ingredient.foodGroup === null ? 'auto' : ingredient.foodGroup || 'nessuno';
  return [
    ['auto', `automatico: ${auto ? FOOD_GROUP[auto].name.toLowerCase() : 'nessuno'}`],
    ...FOOD_GROUPS.map((g) => [g.key, g.name]),
    ['nessuno', 'nessuno (pasta, pane, olio…)'],
  ].map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

// Valore per l'API dalla scelta: null = automatico, '' = nessuno.
const foodGroupValue = (value) => (value === 'auto' ? null : value === 'nessuno' ? '' : value);

Object.assign(actions, {
  'score-group': (el) => {
    scoreOpenGroup = scoreOpenGroup === el.dataset.group ? null : el.dataset.group;
    renderWeekScore();
  },
  'score-scroll': () => document.getElementById('week-score')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
});

Object.assign(changeHandlers, {
  // Tornando ai gruppi riconosciuti, le caselle mostrano quelli; togliendo la spunta si sceglie a mano.
  'dish-groups-auto': (el) => {
    const dish = state.dishes.find((d) => d.id === el.form.dataset.id);
    const auto = autoDishGroups(dish);
    for (const box of el.form.querySelectorAll('input[name="foodGroups"]')) {
      box.disabled = el.checked;
      if (el.checked) box.checked = auto.has(box.value);
    }
  },
});
