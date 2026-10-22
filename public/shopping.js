'use strict';

/*
 * Lista della spesa della settimana: voci divise per reparto (frutta, verdura…), con un solo
 * campo per aggiungerle. Il reparto si sceglie da solo: prima quelli imparati (spostando una
 * voce in un altro reparto il sito lo ricorda, anche per le settimane successive), poi un
 * dizionario di parole comuni, che riconosce anche singolari e plurali.
 * Le voci si riordinano trascinandole dalla maniglia (mouse o dito) o con le frecce.
 * Usa lo stato e le funzioni di app.js, caricato prima.
 */

// Reparti, nell'ordine di un giro al supermercato (le chiavi sono anche in api.php).
const SHOP_CATEGORIES = [
  { key: 'frutta', name: 'Frutta' },
  { key: 'verdura', name: 'Verdura' },
  { key: 'pane', name: 'Pane e forno' },
  { key: 'carne', name: 'Carne' },
  { key: 'pesce', name: 'Pesce' },
  { key: 'salumi', name: 'Salumi e formaggi' },
  { key: 'latticini', name: 'Latte, yogurt e uova' },
  { key: 'dispensa', name: 'Pasta, riso e dispensa' },
  { key: 'colazione', name: 'Colazione, dolci e snack' },
  { key: 'surgelati', name: 'Surgelati' },
  { key: 'bevande', name: 'Bevande' },
  { key: 'casa', name: 'Casa e pulizia' },
  { key: 'igiene', name: 'Igiene e cura' },
  { key: 'animali', name: 'Animali' },
  { key: 'altro', name: 'Altro' },
];
const SHOP_KEYS = new Set(SHOP_CATEGORIES.map((c) => c.key));

// Parole per reparto. Basta il singolare o il plurale regolare (mela/mele); le espressioni di
// più parole («carta igienica») valgono prima delle singole parole. Nelle voci conta la prima
// parola riconosciuta («succo di mela» → bevande, «gelato alla fragola» → surgelati).
const SHOP_WORDS = {
  frutta: `frutta frutti macedonia mela pera banana arancia arance mandarino mandarancio clementina limone lime
    pompelmo kiwi ananas uva fragola ciliegia ciliegie pesca pesche albicocca albicocche prugna susina fico fichi
    melone anguria cocomero mango papaya avocado cachi kaki melograno mirtillo lampone ribes amarene nespola
    castagna noce noci nocciola mandorla pistacchio dattero uvetta;
    frutti di bosco; frutta secca`,
  verdura: `verdura verdure insalata lattuga rucola valeriana songino radicchio indivia scarola cicoria spinaci
    bietola erbette cavolo cavolfiore cavolini broccolo broccoli verza cappuccio carota patata cipolla cipollotto
    aglio porro sedano finocchio zucchina zucchino zucca melanzana peperone pomodoro pomodorini ciliegini datterini
    cetriolo fagiolini piselli asparago carciofo fungo funghi champignon prezzemolo basilico rosmarino salvia
    menta timo zenzero ravanello rapa barbabietola catalogna friarielli germogli aromi;
    erba cipollina; cime di rapa`,
  pane: `pane pani panino panini pagnotta baguette focaccia piadina pizza grissini cracker crackers pancarre
    tramezzini taralli friselle rosetta ciabatta;
    pan carre; pan bauletto`,
  carne: `carne pollo tacchino manzo vitello maiale agnello coniglio macinato macinata hamburger salsiccia
    bistecca fettine braciola arrosto spezzatino scaloppine cotoletta polpette wurstel spiedini costine lonza
    cosce coscia sovracosce alette fegato`,
  pesce: `pesce pesci salmone merluzzo baccala nasello orata branzino spigola sogliola platessa trota sgombro
    alici acciughe sardine gamberi gamberetti scampi calamari seppia polpo polpi cozze vongole surimi;
    frutti di mare; pesce spada; tonno fresco`,
  salumi: `salumi prosciutto crudo cotto mortadella salame speck bresaola coppa pancetta guanciale lardo
    affettati affettato fesa formaggio formaggi parmigiano grana pecorino emmental emmenthal fontina asiago
    gorgonzola taleggio provola provolone scamorza brie caciotta edamer sottilette feta`,
  latticini: `latte yogurt yoghurt burro panna uova uovo mozzarella ricotta mascarpone stracchino crescenza
    robiola philadelphia kefir skyr margarina`,
  dispensa: `pasta spaghetti spaghettini penne fusilli rigatoni farfalle maccheroni tagliatelle lasagne linguine
    tortellini ravioli gnocchi riso orzo farro couscous quinoa farina zucchero sale pepe olio oli aceto passata
    pelati polpa concentrato sugo pesto ragu tonno legumi fagioli ceci lenticchie mais olive capperi sottaceti
    maionese ketchup senape brodo dado spezie origano curry paprika lievito pangrattato besciamella amido maizena
    zuppa minestra salsa;
    cous cous; noce moscata; aceto balsamico`,
  colazione: `caffe cialde capsule the te tisana camomilla biscotti biscotto cereali muesli marmellata confettura
    miele nutella cioccolato cioccolata cioccolatini merendine merendina brioche brioches cornetti croissant torta
    crostata plumcake budino caramelle gomme patatine snack popcorn salatini cacao pandoro panettone colomba wafer
    savoiardi pavesini;
    fette biscottate; corn flakes; crema spalmabile; chewing gum`,
  surgelati: `surgelati surgelato surgelata gelato gelati ghiaccioli ghiaccio bastoncini sofficini minestrone;
    pizza surgelata; verdure surgelate; piselli surgelati; spinaci surgelati; patatine fritte`,
  bevande: `bevanda bevande acqua vino vini birra birre succo succhi aranciata cola pepsi spremuta bibita gassosa
    chinotto aperitivo spritz prosecco spumante liquore amaro grappa whisky vodka gin rum tonica;
    coca cola; te freddo; the freddo; acqua tonica`,
  casa: `detersivo detersivi ammorbidente candeggina sgrassatore anticalcare brillantante spugna spugne carta
    scottex tovaglioli tovaglie piatti bicchieri posate sacchetti sacchi pellicola alluminio stagnola scopa mocio
    panno panni guanti lampadina lampadine pile batterie accendino fiammiferi insetticida ammoniaca alcol
    lavapavimenti swiffer candele lavastoviglie;
    pastiglie lavastoviglie; sale lavastoviglie; deodorante per ambienti`,
  igiene: `shampoo balsamo bagnoschiuma docciaschiuma sapone saponetta dentifricio spazzolino collutorio
    deodorante assorbenti salvaslip tamponi rasoio lamette crema creme cotone dischetti fazzoletti salviette
    salviettine pannolini pannolino cerotti medicine farmaci tachipirina aspirina profumo mascara lacca gel
    struccante smalto solare;
    carta igienica; doccia schiuma; filo interdentale; schiuma da barba; cotton fioc; crema solare`,
  animali: `crocchette croccantini lettiera sabbietta gatto gatti cane cani antiparassitario;
    cibo per gatti; cibo per cani; cibo per gatto; cibo per cane`,
};

// Parole che non dicono cosa si compra: articoli e preposizioni, quantità e confezioni.
const SHOP_IGNORED = new Set(`di da del dello della dei degli delle al allo alla ai agli alle per con in e o
  il lo la i gli le un uno una g gr hg kg l lt ml cl pz pezzo pezzi conf confezione confezioni x n nr
  bottiglia bottiglie pacco pacchi pacchetto pacchetti vasetto vasetti barattolo barattoli lattina lattine
  scatola scatole busta buste etto etti`.split(/\s+/));

// La voce ripulita: minuscolo, senza accenti, senza quantità né parole vuote («2 kg di Patate» → «patate»).
function shopTerm(text) {
  return fold(String(text))
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !SHOP_IGNORED.has(w) && !/^\d/.test(w) && !/^x\d+$/.test(w))
    .join(' ');
}

// Radice per riconoscere singolare e plurale: senza vocali finali (e la h di -che/-ghi).
const shopStem = (word) => word.replace(/[aeiou]+$/, '').replace(/([cg])h$/, '$1');

// Indice del dizionario: parole esatte, radici (null se in due reparti diversi) ed espressioni.
const SHOP_INDEX = (() => {
  const exact = new Map();
  const stems = new Map();
  const phrases = [];
  for (const [category, list] of Object.entries(SHOP_WORDS)) {
    const [words, ...rest] = list.split(';');
    for (const phrase of rest) {
      const term = shopTerm(phrase);
      if (term) phrases.push([` ${term} `, category]);
    }
    for (const word of words.split(/\s+/).map(shopTerm).filter(Boolean)) {
      exact.set(word, category);
      const stem = shopStem(word);
      if (stem.length >= 3) stems.set(stem, stems.has(stem) && stems.get(stem) !== category ? null : category);
    }
  }
  return { exact, stems, phrases: phrases.sort((a, b) => b[0].length - a[0].length) };
})();

function categorize(text) {
  const term = shopTerm(text);
  if (!term) return 'altro';
  const learned = state.shoppingTerms ?? {};
  if (SHOP_KEYS.has(learned[term])) return learned[term];
  const padded = ` ${term} `;
  for (const [phrase, category] of SHOP_INDEX.phrases) {
    if (padded.includes(phrase)) return category;
  }
  for (const word of term.split(' ')) {
    const found = (SHOP_KEYS.has(learned[word]) ? learned[word] : null)
      ?? SHOP_INDEX.exact.get(word) ?? SHOP_INDEX.stems.get(shopStem(word));
    if (found) return found;
  }
  return 'altro';
}

// Ricorda il reparto in cui l'utente ha spostato la voce, qui e sul server.
function learnShopCategory(item) {
  const term = shopTerm(item.text);
  if (!term) return;
  state.shoppingTerms = { ...state.shoppingTerms, [term]: item.category };
  api('shopping-term', { body: { term, category: item.category } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

const shopItem = (id) => state.week.shopping.find((item) => item.id === id);

// flash: id della voce appena aggiunta, da evidenziare nel suo reparto.
function renderShopping({ flash } = {}) {
  const list = document.getElementById('shopping-list');
  if (!list) return;
  const items = state.week.shopping;
  // Le voci salvate prima dei reparti (o con un reparto sconosciuto) ne ricevono uno ora.
  for (const item of items) {
    if (!SHOP_KEYS.has(item.category)) item.category = categorize(item.text);
  }
  list.innerHTML = SHOP_CATEGORIES.map((c) => {
    const inCategory = items.filter((item) => item.category === c.key);
    if (!inCategory.length) return '';
    return `<li class="shop-group" data-category="${c.key}">${c.name}</li>${inCategory.map(shopItemHtml).join('')}`;
  }).join('');
  if (flash) list.querySelector(`.shop-item[data-id="${flash}"]`)?.classList.add('is-new');
  updateShoppingMeta();
}

function shopItemHtml(item) {
  return `
    <li class="shop-item${item.done ? ' is-done' : ''}" data-id="${esc(item.id)}" title="${esc(item.text)}">
      <button type="button" class="shop-handle" aria-label="Sposta ${esc(item.text)} (frecce su e giù)">${ICONS.grip}</button>
      <label><input type="checkbox" data-change="shop-done"${item.done ? ' checked' : ''}><span>${esc(item.text)}</span></label>
      <button type="button" class="shop-remove" data-action="shop-remove" aria-label="Rimuovi ${esc(item.text)}">${ICONS.close}</button>
    </li>`;
}

function updateShoppingMeta() {
  const items = state.week.shopping;
  const done = items.filter((item) => item.done).length;
  document.getElementById('shopping-count').textContent = items.length ? `${done}/${items.length}` : '';
  document.getElementById('shopping-clear').hidden = done === 0;
}

// Ordine e reparti come appaiono nella lista (dopo uno spostamento): ogni voce sta nel
// reparto del titolo che la precede.
function applyShopOrderFromList() {
  let category = 'altro';
  const order = [];
  for (const el of document.getElementById('shopping-list').children) {
    if (el.classList.contains('shop-group')) {
      category = el.dataset.category;
    } else {
      const item = shopItem(el.dataset.id);
      item.category = category;
      order.push(item);
    }
  }
  state.week.shopping = order;
}

// Dopo uno spostamento: salva, e se la voce ha cambiato reparto lo ricorda.
function finishShopMove(item, previousCategory, { focus = false } = {}) {
  if (item.category !== previousCategory) learnShopCategory(item);
  renderShopping();
  scheduleSave();
  if (focus) document.querySelector(`.shop-item[data-id="${item.id}"] .shop-handle`)?.focus();
}

// --- Trascinamento dalla maniglia (mouse e dito) ------------------------------

let shopDrag = null; // { li, item, category, target, moved }

// Mentre si trascina, in fondo compaiono i reparti ancora vuoti, per spostarci la voce.
function showShopDrop() {
  const used = new Set(state.week.shopping.map((item) => item.category));
  const empty = SHOP_CATEGORIES.filter((c) => !used.has(c.key));
  const drop = document.getElementById('shopping-drop');
  if (!empty.length || !drop) return;
  drop.innerHTML = `<span class="shop-drop-label">Sposta in:</span>${empty
    .map((c) => `<span class="shop-drop-target" data-category="${c.key}">${c.name}</span>`).join('')}`;
  drop.hidden = false;
}

function moveShopDrag(x, y) {
  const inside = (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const chip = [...document.querySelectorAll('.shop-drop-target')].find((c) => inside(c.getBoundingClientRect()));
  for (const c of document.querySelectorAll('.shop-drop-target')) c.classList.toggle('is-over', c === chip);
  shopDrag.target = chip?.dataset.category ?? null;
  shopDrag.moved = true;
  if (!chip) {
    const list = document.getElementById('shopping-list');
    const others = [...list.children].filter((el) => el !== shopDrag.li);
    const before = others.find((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    // Mai sopra il primo titolo: lì la voce non avrebbe un reparto.
    list.insertBefore(shopDrag.li, before === others[0] ? others[1] ?? null : before ?? null);
  }
  // Vicino ai bordi dello schermo la pagina scorre da sola.
  if (y < 48) window.scrollBy(0, -14);
  else if (y > window.innerHeight - 48) window.scrollBy(0, 14);
}

function endShopDrag(commit) {
  const { li, item, category, target, moved } = shopDrag;
  shopDrag = null;
  li.classList.remove('is-dragging');
  const drop = document.getElementById('shopping-drop');
  if (drop) drop.hidden = true;
  if (!commit || !moved) {
    renderShopping();
    return;
  }
  if (target) {
    item.category = target;
    state.week.shopping = [...state.week.shopping.filter((i) => i !== item), item];
  } else {
    applyShopOrderFromList();
  }
  finishShopMove(item, category);
}

app.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.shop-handle');
  if (!handle || e.button !== 0) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  const li = handle.closest('.shop-item');
  const item = shopItem(li.dataset.id);
  shopDrag = { li, item, category: item.category, target: null, moved: false };
  li.classList.add('is-dragging');
  showShopDrop();
});

app.addEventListener('pointermove', (e) => {
  if (shopDrag) moveShopDrag(e.clientX, e.clientY);
});
app.addEventListener('pointerup', () => {
  if (shopDrag) endShopDrag(true);
});
app.addEventListener('pointercancel', () => {
  if (shopDrag) endShopDrag(false);
});

// Frecce sulla maniglia: su e giù di una voce, passando al reparto vicino ai bordi.
app.addEventListener('keydown', (e) => {
  const handle = e.target.closest?.('.shop-handle');
  if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const li = handle.closest('.shop-item');
  const list = li.parentElement;
  const item = shopItem(li.dataset.id);
  const category = item.category;
  if (e.key === 'ArrowUp') {
    const prev = li.previousElementSibling; // un'altra voce o il titolo del reparto
    if (!prev.classList.contains('shop-item') && !prev.previousElementSibling) return;
    list.insertBefore(li, prev);
  } else {
    const next = li.nextElementSibling;
    if (!next) return;
    list.insertBefore(li, next.nextElementSibling);
  }
  applyShopOrderFromList();
  finishShopMove(item, category, { focus: true });
});

// ---------------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------------

Object.assign(formHandlers, {
  // Un solo campo per aggiungere: la voce va da sola nel suo reparto.
  'shop-add': (form) => {
    const input = form.elements.text;
    const text = input.value.trim();
    if (!text) return;
    const item = { id: uid(), text, done: false, category: categorize(text) };
    state.week.shopping.push(item);
    input.value = '';
    renderShopping({ flash: item.id });
    scheduleSave();
  },
});

Object.assign(changeHandlers, {
  'shop-done': (el) => {
    const li = el.closest('.shop-item');
    shopItem(li.dataset.id).done = el.checked;
    li.classList.toggle('is-done', el.checked);
    updateShoppingMeta();
    scheduleSave();
  },
});

Object.assign(actions, {
  'shop-remove': (el) => {
    const id = el.closest('.shop-item').dataset.id;
    state.week.shopping = state.week.shopping.filter((item) => item.id !== id);
    renderShopping();
    scheduleSave();
  },
  'shop-clear': () => {
    state.week.shopping = state.week.shopping.filter((item) => !item.done);
    renderShopping();
    scheduleSave();
  },
});
