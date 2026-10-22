'use strict';

/*
 * Menù della settimana — app a pagina singola, senza framework.
 * Viste: #/settimana[/AAAA-MM-GG] · #/piatti · #/storico; shopping.js gestisce la lista della
 * spesa, recipes.js aggiunge le ricette ai piatti, groceries.js la sezione #/spesa e users.js la
 * pagina #/utenti, registrandosi in routes, actions e *Handlers.
 */

// ---------------------------------------------------------------------------
// Costanti
// ---------------------------------------------------------------------------

const DAYS = [
  { key: 'mon', name: 'Lunedì', short: 'Lun' },
  { key: 'tue', name: 'Martedì', short: 'Mar' },
  { key: 'wed', name: 'Mercoledì', short: 'Mer' },
  { key: 'thu', name: 'Giovedì', short: 'Gio' },
  { key: 'fri', name: 'Venerdì', short: 'Ven' },
  { key: 'sat', name: 'Sabato', short: 'Sab' },
  { key: 'sun', name: 'Domenica', short: 'Dom' },
];

const MEALS = [
  { key: 'lunch', name: 'Pranzo' },
  { key: 'dinner', name: 'Cena' },
];

const CATEGORIES = [
  { key: 'primo', name: 'Primo', plural: 'Primi' },
  { key: 'secondo', name: 'Secondo', plural: 'Secondi' },
  { key: 'unico', name: 'Piatto unico', plural: 'Piatti unici' },
  { key: 'contorno', name: 'Contorno', plural: 'Contorni' },
  { key: 'altro', name: 'Altro', plural: 'Altro' },
];

const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = {
  left: svg('M15 6l-6 6 6 6'),
  right: svg('M9 6l6 6-6 6'),
  plus: svg('M12 5v14M5 12h14'),
  close: svg('M6 6l12 12M18 6L6 18'),
  print: svg('M7 9V3h10v6M7 17H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-3M7 14h10v7H7z'),
  warn: svg('M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01'),
  grip: svg('M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01'),
};

// ---------------------------------------------------------------------------
// Stato
// ---------------------------------------------------------------------------

const app = document.getElementById('app');

const state = {
  user: null, // nome dell'utente collegato
  dishes: [],
  ingredients: [], // con l'ultimo prezzo: servono per ricette e costi
  recipeDishId: null, // piatto con la ricetta aperta in «I miei piatti»
  recipeDraft: null, // ricetta in modifica: { servings, lines }
  week: null, // settimana aperta: { key, meals, notes, shopping }
  shoppingTerms: {}, // reparti imparati per le voci della spesa (shopping.js)
  weekStartDay: 0, // giorno in cui iniziano le settimane: 0 = lunedì ... 6 = domenica
  editingDishId: null,
  dishFilter: { q: '', category: 'all' },
  history: [],
  historyQuery: '',
};

let renderToken = 0;

// ---------------------------------------------------------------------------
// Date (la settimana è identificata dalla data del suo primo giorno, che si sceglie:
// state.weekStartDay)
// ---------------------------------------------------------------------------

const DAY_MS = 864e5;
const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
const weekdayIndex = (date) => (date.getDay() + 6) % 7; // 0 = lunedì ... 6 = domenica, come DAYS
const weekStartOf = (date) => addDays(date, -((weekdayIndex(date) - state.weekStartDay + 7) % 7));
const currentWeekKey = () => toKey(weekStartOf(new Date()));
const weeksBetween = (a, b) => Math.round((fromKey(b) - fromKey(a)) / (7 * DAY_MS));

// I giorni della settimana che inizia il `key`, in ordine, ciascuno con la sua data.
function weekDays(key) {
  const start = fromKey(key);
  const first = weekdayIndex(start);
  return DAYS.map((_, i) => ({ ...DAYS[(first + i) % 7], date: addDays(start, i) }));
}

const fmtDayMonth = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long' });
const fmtLong = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' });
const fmtShortYear = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' });

function weekRangeLabel(key) {
  const start = fromKey(key);
  const end = addDays(start, 6);
  if (start.getFullYear() !== end.getFullYear()) return `${fmtLong.format(start)} – ${fmtLong.format(end)}`;
  if (start.getMonth() !== end.getMonth()) return `${fmtDayMonth.format(start)} – ${fmtLong.format(end)}`;
  return `${start.getDate()} – ${fmtLong.format(end)}`;
}

// Numero ISO della settimana in cui cade la maggior parte dei giorni (quella del quarto).
function weekNumber(start) {
  const middle = addDays(start, 3);
  const thursday = addDays(middle, 3 - weekdayIndex(middle));
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  return Math.floor(Math.round((thursday - jan1) / DAY_MS) / 7) + 1;
}

function weekRelation(key) {
  const diff = weeksBetween(currentWeekKey(), key);
  if (diff === 0) return 'Questa settimana';
  if (diff === -1) return 'Settimana scorsa';
  if (diff === 1) return 'Prossima settimana';
  return diff < 0 ? `${-diff} settimane fa` : `Tra ${diff} settimane`;
}

function shortDate(key) {
  const date = fromKey(key);
  return (date.getFullYear() === new Date().getFullYear() ? fmtShort : fmtShortYear).format(date);
}

// ---------------------------------------------------------------------------
// Testo
// ---------------------------------------------------------------------------

const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Minuscolo e senza accenti, per cercare "caffe" e trovare "Caffè".
const fold = (value) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function highlight(text, query) {
  const q = fold(query.trim());
  const folded = fold(text);
  const i = q ? folded.indexOf(q) : -1;
  if (i < 0 || folded.length !== text.length) return esc(text);
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const fmtEuro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const euro = (value) => fmtEuro.format(value);
const formatDecimal = (n) => n.toLocaleString('it-IT', { maximumFractionDigits: 3, useGrouping: false });

// Numero scritto a mano ("0,5", "320"): null se vuoto, NaN se non valido o non positivo.
function parseDecimal(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').replace(/\s/g, '').replace(',', '.');
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`)
    .replace(/-/g, '')
    .slice(0, 12);

function categoryOptions(selected) {
  return CATEGORIES.map(
    (c) => `<option value="${c.key}"${c.key === selected ? ' selected' : ''}>${c.name}</option>`,
  ).join('');
}

function usageLabel(dish, { long = false } = {}) {
  if (!dish.timesPlanned) return long ? 'Mai pianificato' : 'mai pianificato';
  const times = plural(dish.timesPlanned, 'volta', 'volte');
  return long ? `Pianificato ${times} · ultima il ${shortDate(dish.lastPlanned)}` : `${times} · ultima ${shortDate(dish.lastPlanned)}`;
}

function emptyTemplate(title, text, extra = '') {
  return `<div class="empty"><h2>${title}</h2><p>${text}</p>${extra}</div>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Errore per accesso mancante o scaduto: la schermata di login è già stata mostrata.
class AuthError extends Error {}

// Tutte le chiamate passano da api.php?action=…: GET per leggere, POST (sempre JSON) per scrivere.
async function api(action, { params = {}, body, post = body !== undefined, keepalive = false } = {}) {
  const url = `api.php?${new URLSearchParams({ action, ...params })}`;
  let res;
  try {
    res = await fetch(url, {
      method: post ? 'POST' : 'GET',
      keepalive,
      credentials: 'same-origin',
      headers: post ? { 'Content-Type': 'application/json' } : {},
      body: post ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new Error('Impossibile contattare il server.');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && action !== 'login') {
    if (!document.getElementById('login-form')) {
      showLogin(state.user ? 'La sessione è scaduta: accedi di nuovo.' : '', data?.needsSetup);
    }
    throw new AuthError(data?.error || 'Accesso richiesto');
  }
  if (!res.ok) throw new Error(data?.error || `Errore ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------------------------------------------------------------------------
// Navigazione
// ---------------------------------------------------------------------------

const routes = [
  { nav: 'settimana', re: /^#\/settimana(?:\/(\d{4}-\d{2}-\d{2}))?\/?$/, show: showWeek },
  { nav: 'piatti', re: /^#\/piatti\/?$/, show: showDishes },
  { nav: 'storico', re: /^#\/storico\/?$/, show: showHistory },
];

let lastScrollKey = null;

async function route() {
  if (!state.user) return showLogin();
  flushWeekSave();
  if (picker.dialog.open) picker.dialog.close();

  const hash = location.hash || '#/settimana';
  let match = null;
  const current = routes.find((r) => (match = hash.match(r.re)));
  if (!current) return location.replace('#/settimana');

  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === current.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  const token = ++renderToken;
  try {
    await current.show(match, token);
    // Cambiando pagina si riparte dall'alto (tra una settimana e l'altra no).
    const scrollKey = current.nav === 'settimana' ? 'settimana' : hash;
    if (token === renderToken && scrollKey !== lastScrollKey) window.scrollTo(0, 0);
    lastScrollKey = scrollKey;
  } catch (err) {
    if (token !== renderToken || err instanceof AuthError) return;
    showError(err);
  }
}

function showError(err) {
  app.innerHTML = emptyTemplate(
    'Qualcosa è andato storto',
    `${esc(err.message)} Controlla la connessione e riprova.`,
    '<button type="button" class="btn btn-primary" data-action="retry">Riprova</button>',
  );
}

// ---------------------------------------------------------------------------
// Accesso
// ---------------------------------------------------------------------------

function setUser(user) {
  state.user = user;
  document.body.classList.toggle('is-locked', !user);
  document.getElementById('user-menu').hidden = !user;
  document.querySelector('#user-name .user-name-text').textContent = user || '';
}

// needsSetup: il sito non ha ancora utenti, il primo si crea con setup.php.
function showLogin(message = '', needsSetup = false) {
  ++renderToken; // annulla eventuali viste ancora in caricamento
  setUser(null);
  if (picker.dialog.open) picker.dialog.close();
  app.innerHTML = `
    <div class="login">
      <form id="login-form" class="card login-card">
        <h1>Accedi</h1>
        <p class="lead">Entra per pianificare il menù della settimana.</p>
        ${message ? `<p class="login-note">${esc(message)}</p>` : ''}
        ${needsSetup ? '<p class="login-note">Il sito non ha ancora utenti: <a href="setup.php">crea il primo nella pagina di configurazione</a>.</p>' : ''}
        <label class="field"><span>Nome utente</span>
          <input name="username" required maxlength="40" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <label class="field"><span>Password</span>
          <input name="password" type="password" required autocomplete="current-password"></label>
        <label class="check"><input type="checkbox" name="remember" checked> Resta collegato su questo dispositivo</label>
        <p id="login-error" class="login-error" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary">Entra</button>
      </form>
    </div>`;
  document.title = 'Accedi · Menù della settimana';
  app.querySelector('input[name="username"]').focus();
}

async function submitLogin(form) {
  const { username, password, remember } = form.elements;
  const button = form.querySelector('button[type="submit"]');
  const error = document.getElementById('login-error');
  button.disabled = true;
  try {
    const { user, weekStartDay } = await api('login', {
      body: { username: username.value, password: password.value, remember: remember.checked },
    });
    state.weekStartDay = weekStartDay;
    setUser(user);
    lastScrollKey = null;
    route();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    password.value = '';
    password.focus();
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  await flushWeekSave();
  try {
    await api('logout', { post: true });
  } catch {
    // anche se il server non risponde, l'interfaccia torna comunque al login
  }
  state.week = null;
  state.dishes = [];
  state.history = [];
  showLogin();
}

document.getElementById('logout-btn').addEventListener('click', logout);

// ---------------------------------------------------------------------------
// Vista: settimana
// ---------------------------------------------------------------------------

async function showWeek(match, token) {
  const requested = match[1];
  const key = requested ? toKey(weekStartOf(fromKey(requested))) : currentWeekKey();
  if (requested && key !== requested) return location.replace(`#/settimana/${key}`);

  await saveChain; // non rileggere una settimana mentre la sua ultima modifica è in viaggio
  const [data, dishes] = await Promise.all([api('week', { params: { week: key } }), api('dishes')]);
  if (token !== renderToken) return;
  // Il giorno di inizio può essere stato cambiato da un altro dispositivo.
  state.weekStartDay = data.weekStartDay;
  if (data.week !== key) return location.replace(`#/settimana/${data.week}`);

  state.dishes = dishes;
  state.week = { key, meals: data.meals, notes: data.notes, shopping: data.shopping };
  state.shoppingTerms = data.shoppingTerms ?? {};
  app.innerHTML = weekTemplate(state.week);
  renderSlots();
  renderShopping();
  document.title = `${weekRangeLabel(key)} · Menù della settimana`;
}

function weekTemplate(week) {
  const start = fromKey(week.key);
  const todayKey = toKey(new Date());
  const isCurrent = week.key === currentWeekKey();

  return `
    <div class="week-toolbar">
      <a class="icon-btn" href="#/settimana/${toKey(addDays(start, -7))}" aria-label="Settimana precedente" title="Settimana precedente">${ICONS.left}</a>
      <div class="week-title">
        <h1>${esc(weekRangeLabel(week.key))}</h1>
        <p>Settimana ${weekNumber(start)} · ${weekRelation(week.key)}</p>
      </div>
      <a class="icon-btn" href="#/settimana/${toKey(addDays(start, 7))}" aria-label="Settimana successiva" title="Settimana successiva">${ICONS.right}</a>
      <div class="week-actions">
        <span id="save-status" class="save-status" aria-live="polite"></span>
        ${isCurrent ? '' : '<a class="btn btn-sm" href="#/settimana">Vai a questa settimana</a>'}
        <button type="button" class="btn btn-sm" data-action="print">${ICONS.print}Stampa</button>
      </div>
    </div>

    <div class="board">
      ${weekDays(week.key).map((day, i) => dayTemplate(day, i, todayKey)).join('')}

      <section class="cell notes-cell">
        <div class="cell-head"><h2 class="cell-title">Note</h2></div>
        <textarea id="week-notes" class="notes-text lined" aria-label="Note della settimana"
          placeholder="Ospiti, cene fuori, cose da ricordare…">${esc(week.notes)}</textarea>
      </section>

      <section class="cell shopping-cell">
        <div class="cell-head">
          <h2 class="cell-title">Lista della spesa</h2>
          <span id="shopping-count" class="muted"></span>
        </div>
        <div class="shopping-body lined">
          <form class="shopping-add" data-submit="shop-add" autocomplete="off">
            <input name="text" maxlength="200" placeholder="Aggiungi alla lista…" aria-label="Aggiungi alla lista della spesa">
            <button type="submit" aria-label="Aggiungi">${ICONS.plus}</button>
          </form>
          <ul id="shopping-list" class="shopping-list"></ul>
          <div id="shopping-drop" class="shopping-drop" hidden></div>
        </div>
        <div class="cell-head">
          <span></span>
          <button type="button" id="shopping-clear" class="link-btn" data-action="shop-clear" hidden>Togli le voci spuntate</button>
        </div>
      </section>
    </div>

    <p class="hint">
      Premi <strong>+</strong> per scegliere un piatto dalla tua lista.
      <span class="hint-drag">Trascina un piatto per spostarlo in un altro pasto (tieni premuto Ctrl per copiarlo).</span>
    </p>
    <label class="week-start">La settimana inizia di
      <select class="input" data-change="week-start" aria-label="Giorno di inizio della settimana">
        ${DAYS.map((d, i) => `<option value="${i}"${i === state.weekStartDay ? ' selected' : ''}>${d.name.toLowerCase()}</option>`).join('')}
      </select></label>`;
}

// position: posto nel tabellone (d1 … d7), che resta lo stesso qualunque sia il giorno di inizio.
function dayTemplate(day, position, todayKey) {
  const isToday = toKey(day.date) === todayKey;
  return `
    <section class="cell day${isToday ? ' is-today' : ''}" style="grid-area:d${position + 1}">
      <header class="day-head">
        <h2 class="day-name">${day.name}</h2>
        <span class="day-date">${fmtShort.format(day.date)}</span>
        ${isToday ? '<span class="today-badge">Oggi</span>' : ''}
      </header>
      ${MEALS.map((meal) => `
        <div class="slot" data-day="${day.key}" data-meal="${meal.key}">
          <span class="slot-label">${meal.name}</span>
          <ul class="chips"></ul>
          <button type="button" class="add-btn" data-action="open-picker"
            aria-label="Aggiungi un piatto: ${day.name}, ${meal.name.toLowerCase()}">${ICONS.plus}<span class="add-text">Aggiungi</span></button>
        </div>`).join('')}
    </section>`;
}

function renderSlots() {
  for (const slot of app.querySelectorAll('.slot')) {
    const entries = state.week.meals[slot.dataset.day][slot.dataset.meal];
    slot.querySelector('.chips').innerHTML = entries
      .map((entry, i) => `
        <li class="chip" draggable="true" data-index="${i}">
          <span class="chip-name">${esc(entry.name)}</span>
          <button type="button" class="chip-remove" data-action="remove-entry" aria-label="Togli ${esc(entry.name)}">${ICONS.close}</button>
        </li>`)
      .join('');
    slot.classList.toggle('is-empty', entries.length === 0);
  }
}

// La lista della spesa (renderShopping e i suoi eventi) sta in shopping.js.

// --- Salvataggio automatico ------------------------------------------------

let saveTimer = null;
let saveChain = Promise.resolve();

function scheduleSave(delay = 0) {
  setSaveStatus('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushWeekSave, delay);
}

function flushWeekSave({ keepalive = false } = {}) {
  if (!saveTimer || !state.week) return saveChain;
  clearTimeout(saveTimer);
  saveTimer = null;
  const { key, meals, notes, shopping } = state.week;
  const body = structuredClone({ meals, notes, shopping });
  saveChain = saveChain
    .then(() => api('week-save', { params: { week: key }, body, keepalive }))
    .then(
      () => { if (!saveTimer && state.week?.key === key) setSaveStatus('saved'); },
      (err) => {
        if (err instanceof AuthError) return;
        setSaveStatus('error');
        toast(`Modifiche non salvate: ${err.message}`, 'error');
      },
    );
  return saveChain;
}

function setSaveStatus(status) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.dataset.status = status;
  el.textContent = { pending: 'Salvataggio…', saved: 'Salvato', error: 'Non salvato' }[status] || '';
}

window.addEventListener('pagehide', () => flushWeekSave({ keepalive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushWeekSave({ keepalive: true });
});

// --- Trascinamento dei piatti tra i pasti ----------------------------------

let drag = null;

app.addEventListener('dragstart', (e) => {
  const chip = e.target.closest?.('.chip');
  if (!chip) return;
  const slot = chip.closest('.slot');
  drag = { day: slot.dataset.day, meal: slot.dataset.meal, index: Number(chip.dataset.index) };
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', chip.querySelector('.chip-name').textContent);
  chip.classList.add('is-dragging');
});

app.addEventListener('dragover', (e) => {
  const slot = drag && e.target.closest?.('.slot');
  if (!slot) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : 'move';
  for (const s of app.querySelectorAll('.slot.is-drop-target')) if (s !== slot) s.classList.remove('is-drop-target');
  slot.classList.add('is-drop-target');
});

app.addEventListener('dragleave', (e) => {
  const slot = e.target.closest?.('.slot');
  if (slot && !slot.contains(e.relatedTarget)) slot.classList.remove('is-drop-target');
});

app.addEventListener('drop', (e) => {
  const slot = drag && e.target.closest?.('.slot');
  if (!slot) return;
  e.preventDefault();
  const from = state.week.meals[drag.day][drag.meal];
  const to = state.week.meals[slot.dataset.day][slot.dataset.meal];
  const copy = e.ctrlKey || e.altKey;
  if (from !== to || copy) {
    const entry = copy ? { ...from[drag.index] } : from.splice(drag.index, 1)[0];
    to.push(entry);
    renderSlots();
    scheduleSave();
  }
  endDrag();
});

app.addEventListener('dragend', endDrag);

function endDrag() {
  drag = null;
  for (const el of app.querySelectorAll('.is-drop-target, .is-dragging')) {
    el.classList.remove('is-drop-target', 'is-dragging');
  }
}

// ---------------------------------------------------------------------------
// Finestra di scelta del piatto
// ---------------------------------------------------------------------------

const picker = {
  dialog: document.getElementById('picker'),
  search: document.getElementById('picker-search'),
  list: document.getElementById('picker-list'),
  target: null, // { day, meal }
  matches: [],
  category: 'altro',
  error: '',
};

function openPicker(dayKey, mealKey) {
  const day = weekDays(state.week.key).find((d) => d.key === dayKey);
  picker.target = { day: dayKey, meal: mealKey };
  picker.error = '';
  document.getElementById('picker-kicker').textContent = `${day.name} ${fmtShort.format(day.date)}`;
  document.getElementById('picker-title').textContent = MEALS.find((m) => m.key === mealKey).name;
  picker.search.value = '';
  renderPicker();
  picker.dialog.showModal();
  picker.search.focus();
}

function renderPicker() {
  const raw = picker.search.value.trim();
  const q = fold(raw);
  const inSlot = new Set(state.week.meals[picker.target.day][picker.target.meal].map((e) => e.dishId));
  const matches = state.dishes.filter((d) => fold(d.name).includes(q));
  const exact = q && state.dishes.some((d) => fold(d.name) === q);
  picker.matches = matches;

  const parts = [];
  if (!state.dishes.length && !q) {
    parts.push(`
      <div class="picker-empty">
        <p><strong>La tua lista di piatti è ancora vuota.</strong></p>
        <p>Scrivi qui sopra il nome di un piatto per aggiungerlo, oppure vai a <a href="#/piatti">I miei piatti</a>.</p>
      </div>`);
  }

  const create = raw && !exact
    ? `
      <div class="picker-create">
        <p>${matches.length ? 'Non è tra questi?' : 'Non hai ancora questo piatto.'} Aggiungi <strong>«${esc(raw)}»</strong> ai tuoi piatti:</p>
        <div class="picker-create-row">
          <select id="picker-category" class="input" aria-label="Categoria">${categoryOptions(picker.category)}</select>
          <button type="button" class="btn btn-primary btn-sm" data-action="picker-create">Aggiungi e inserisci</button>
        </div>
        ${picker.error ? `<p class="picker-error">${esc(picker.error)}</p>` : ''}
      </div>`
    : '';

  if (!matches.length) parts.push(create);

  for (const cat of CATEGORIES) {
    const items = matches.filter((d) => d.category === cat.key);
    if (!items.length) continue;
    parts.push(`
      <section class="picker-group">
        <h3>${cat.plural}</h3>
        <ul>${items.map((d) => `
          <li><button type="button" class="pick" data-pick="${d.id}"${inSlot.has(d.id) ? ' disabled' : ''}>
            <span class="pick-name">${highlight(d.name, raw)}</span>
            <span class="pick-meta">${inSlot.has(d.id) ? 'già inserito' : usageLabel(d)}</span>
          </button></li>`).join('')}
        </ul>
      </section>`);
  }

  if (matches.length) parts.push(create);
  picker.list.innerHTML = parts.join('');
}

function pickDish(dish) {
  const { day, meal } = picker.target;
  const entries = state.week.meals[day][meal];
  if (!entries.some((e) => e.dishId === dish.id)) entries.push({ dishId: dish.id, name: dish.name });
  picker.dialog.close();
  renderSlots();
  scheduleSave();
}

async function createFromPicker() {
  const name = picker.search.value.trim();
  if (!name) return;
  try {
    const dish = await api('dish-create', { body: { name, category: picker.category } });
    state.dishes.push(dish);
    pickDish(dish);
    toast(`«${dish.name}» aggiunto ai tuoi piatti`);
  } catch (err) {
    picker.error = err.message;
    renderPicker();
  }
}

picker.search.addEventListener('input', () => {
  picker.error = '';
  renderPicker();
});

picker.dialog.addEventListener('change', (e) => {
  if (e.target.id === 'picker-category') picker.category = e.target.value;
});

picker.dialog.addEventListener('click', (e) => {
  if (e.target === picker.dialog) return picker.dialog.close(); // clic sullo sfondo
  const pick = e.target.closest('[data-pick]');
  if (pick) return pickDish(state.dishes.find((d) => d.id === pick.dataset.pick));
  if (e.target.closest('[data-action="picker-create"]')) return createFromPicker();
  if (e.target.closest('[data-action="picker-close"]')) return picker.dialog.close();
});

picker.dialog.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target === picker.search) {
    e.preventDefault();
    const q = fold(picker.search.value.trim());
    if (!q) return;
    const exact = state.dishes.find((d) => fold(d.name) === q);
    if (exact) return pickDish(exact);
    if (picker.matches.length === 1) return pickDish(picker.matches[0]);
    if (!picker.matches.length) return createFromPicker();
    picker.list.querySelector('.pick:not(:disabled)')?.focus();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = [picker.search, ...picker.list.querySelectorAll('.pick:not(:disabled), [data-action="picker-create"]')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    items[next].focus();
  }
});

// ---------------------------------------------------------------------------
// Vista: i miei piatti
// ---------------------------------------------------------------------------

async function showDishes(match, token) {
  const [dishes, ingredients] = await Promise.all([api('dishes'), api('ingredients')]);
  if (token !== renderToken) return;
  state.dishes = dishes;
  state.ingredients = ingredients;
  state.editingDishId = null;
  state.recipeDishId = null;
  state.recipeDraft = null;

  app.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>I miei piatti</h1>
          <p class="lead">I piatti che sai preparare: li userai per riempire la settimana.</p>
        </div>
        <span id="dish-total" class="count-pill"></span>
      </header>

      <form id="dish-form" class="card dish-form" autocomplete="off">
        <label class="field"><span>Nome del piatto</span>
          <input name="name" required maxlength="120" placeholder="es. Pasta alla norma"></label>
        <label class="field"><span>Categoria</span>
          <select name="category">${categoryOptions('primo')}</select></label>
        <label class="field"><span>Note <i>(facoltative)</i></span>
          <input name="notes" maxlength="300" placeholder="es. ricetta a pag. 42, serve il forno"></label>
        <button type="submit" class="btn btn-primary">${ICONS.plus}Aggiungi</button>
      </form>

      <div class="toolbar">
        <input id="dish-search" class="input" type="search" placeholder="Cerca tra i piatti…"
          aria-label="Cerca tra i piatti" value="${esc(state.dishFilter.q)}">
        <div id="dish-filters" class="filters" role="group" aria-label="Filtra per categoria"></div>
      </div>

      <div id="dish-list"></div>
    </div>`;

  renderDishList();
  document.title = 'I miei piatti · Menù della settimana';
}

function renderDishList() {
  const container = document.getElementById('dish-list');
  if (!container) return;
  const { q, category } = state.dishFilter;
  const fq = fold(q.trim());

  document.getElementById('dish-total').textContent = plural(state.dishes.length, 'piatto', 'piatti');
  document.getElementById('dish-filters').innerHTML = [{ key: 'all', plural: 'Tutti' }, ...CATEGORIES]
    .map((c) => {
      const n = c.key === 'all' ? state.dishes.length : state.dishes.filter((d) => d.category === c.key).length;
      return `<button type="button" class="filter" data-action="dish-filter" data-category="${c.key}"
        aria-pressed="${category === c.key}">${c.plural}<span class="n">${n}</span></button>`;
    })
    .join('');

  if (!state.dishes.length) {
    container.innerHTML = emptyTemplate(
      'Ancora nessun piatto',
      'Scrivi qui sopra il nome di un piatto che sai fare e premi <strong>Aggiungi</strong>. Poi potrai usarlo per riempire la settimana.',
    );
    return;
  }

  const visible = state.dishes.filter(
    (d) => (category === 'all' || d.category === category) && (!fq || fold(d.name).includes(fq) || fold(d.notes || '').includes(fq)),
  );
  if (!visible.length) {
    container.innerHTML = emptyTemplate('Nessun piatto trovato', 'Prova a cambiare la ricerca o la categoria.');
    return;
  }

  container.innerHTML = CATEGORIES.map((cat) => {
    const items = visible.filter((d) => d.category === cat.key);
    if (!items.length) return '';
    return `
      <section class="dish-group">
        <h2 class="group-title">${cat.plural} <span class="count-pill">${items.length}</span></h2>
        <ul class="dish-rows">${items.map((d) => (d.id === state.editingDishId ? dishEditRow(d) : dishRow(d))).join('')}</ul>
      </section>`;
  }).join('');
}

function dishRow(d) {
  const recipeOpen = d.id === state.recipeDishId;
  return `
    <li class="dish-row${recipeOpen ? ' is-open' : ''}" data-id="${d.id}">
      <div>
        <span class="dish-name">${highlight(d.name, state.dishFilter.q)}</span>
        ${d.notes ? `<span class="dish-notes">${esc(d.notes)}</span>` : ''}
        ${dishCostLabel(d)}
      </div>
      <span class="dish-stats">${usageLabel(d, { long: true })}</span>
      <div class="dish-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-action="recipe-toggle" aria-expanded="${recipeOpen}">Ricetta</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="dish-edit">Modifica</button>
        <button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="dish-delete">Elimina</button>
      </div>
    </li>
    ${recipeOpen ? recipePanel(d) : ''}`;
}

function dishEditRow(d) {
  return `
    <li class="dish-row is-editing" data-id="${d.id}">
      <form class="dish-edit-form" data-id="${d.id}" autocomplete="off">
        <input name="name" class="input" required maxlength="120" value="${esc(d.name)}" aria-label="Nome del piatto">
        <select name="category" class="input" aria-label="Categoria">${categoryOptions(d.category)}</select>
        <input name="notes" class="input" maxlength="300" value="${esc(d.notes || '')}" placeholder="Note" aria-label="Note">
        <div class="dish-actions">
          <button type="submit" class="btn btn-primary btn-sm">Salva</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="dish-cancel">Annulla</button>
        </div>
      </form>
    </li>`;
}

function sortDishes() {
  state.dishes.sort((a, b) => a.name.localeCompare(b.name, 'it'));
}

async function addDish(form) {
  const data = Object.fromEntries(new FormData(form));
  if (!data.name.trim()) return;
  // Svuoto subito i campi, così si può già scrivere il piatto successivo.
  const { name, notes } = form.elements;
  name.value = '';
  notes.value = '';
  name.focus();
  try {
    const dish = await api('dish-create', { body: data });
    state.dishes.push(dish);
    sortDishes();
    // Se i filtri nasconderebbero il nuovo piatto, li azzero.
    if (state.dishFilter.category !== 'all' && state.dishFilter.category !== dish.category) state.dishFilter.category = 'all';
    if (state.dishFilter.q) {
      state.dishFilter.q = '';
      document.getElementById('dish-search').value = '';
    }
    renderDishList();
    app.querySelector(`.dish-row[data-id="${dish.id}"]`)?.classList.add('is-new');
  } catch (err) {
    if (!name.value) {
      name.value = data.name;
      notes.value = data.notes;
    }
    toast(err.message, 'error');
  }
}

async function saveDishEdit(form) {
  const id = form.dataset.id;
  try {
    const dish = await api('dish-update', { params: { id }, body: Object.fromEntries(new FormData(form)) });
    state.dishes = state.dishes.map((d) => (d.id === id ? dish : d));
    sortDishes();
    state.editingDishId = null;
    renderDishList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteDish(id) {
  const dish = state.dishes.find((d) => d.id === id);
  if (!dish) return;
  const ok = confirm(`Eliminare «${dish.name}» dai tuoi piatti?\n\nLe settimane in cui l'hai già pianificato non verranno modificate.`);
  if (!ok) return;
  try {
    await api('dish-delete', { params: { id }, post: true });
    state.dishes = state.dishes.filter((d) => d.id !== id);
    renderDishList();
    toast(`«${dish.name}» eliminato`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Vista: storico
// ---------------------------------------------------------------------------

async function showHistory(match, token) {
  const weeks = await api('weeks');
  if (token !== renderToken) return;
  state.history = weeks;

  app.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Storico</h1>
          <p class="lead">Le settimane che hai pianificato, dalla più recente.</p>
        </div>
        ${weeks.length ? `<span class="count-pill">${plural(weeks.length, 'settimana', 'settimane')}</span>` : ''}
      </header>
      ${weeks.length ? `
        <div class="toolbar">
          <input id="history-search" class="input" type="search" placeholder="Quando l'ho mangiato? Cerca un piatto…"
            aria-label="Cerca un piatto nello storico" value="${esc(state.historyQuery)}">
        </div>` : ''}
      <div id="history-list"></div>
    </div>`;

  renderHistory();
  document.title = 'Storico · Menù della settimana';
}

function weekEntries(week) {
  return DAYS.flatMap((d) => MEALS.flatMap((m) => week.meals[d.key][m.key]));
}

function renderHistory() {
  const container = document.getElementById('history-list');
  if (!container) return;

  if (!state.history.length) {
    container.innerHTML = emptyTemplate(
      'Lo storico è ancora vuoto',
      'Quando pianifichi una settimana la ritrovi qui, così puoi riguardare cosa hai mangiato.',
      '<a class="btn btn-primary" href="#/settimana">Pianifica questa settimana</a>',
    );
    return;
  }

  const q = fold(state.historyQuery.trim());
  const weeks = q ? state.history.filter((w) => weekEntries(w).some((e) => fold(e.name).includes(q))) : state.history;
  if (!weeks.length) {
    container.innerHTML = emptyTemplate('Nessuna settimana trovata', `Nessuna settimana contiene «${esc(state.historyQuery.trim())}».`);
    return;
  }

  let lastMonth = '';
  const parts = q ? [`<p class="result-count">${plural(weeks.length, 'settimana', 'settimane')} con «${esc(state.historyQuery.trim())}»</p>`] : [];
  for (const week of weeks) {
    const month = capitalize(fmtMonth.format(fromKey(week.week)));
    if (month !== lastMonth) {
      parts.push(`<h2 class="history-month">${month}</h2>`);
      lastMonth = month;
    }
    parts.push(historyCard(week));
  }
  container.innerHTML = parts.join('');
}

function historyCard(week) {
  const todayKey = toKey(new Date());
  const isCurrent = week.week === currentWeekKey();
  const planned = DAYS.reduce((n, d) => n + MEALS.filter((m) => week.meals[d.key][m.key].length).length, 0);

  const cells = weekDays(week.week).map((day) => {
    const head = `<div class="mini-head${toKey(day.date) === todayKey ? ' is-today' : ''}">${day.short} <span>${day.date.getDate()}</span></div>`;
    return head + MEALS.map((meal) => {
      const entries = week.meals[day.key][meal.key];
      const content = entries.length
        ? entries.map((e) => `<span>${highlight(e.name, state.historyQuery)}</span>`).join('')
        : '<span class="mini-empty">—</span>';
      return `<div class="mini-cell">${content}</div>`;
    }).join('');
  }).join('');

  return `
    <article class="history-week${isCurrent ? ' is-current' : ''}">
      <header class="history-head">
        <a class="history-title" href="#/settimana/${week.week}">${esc(weekRangeLabel(week.week))}</a>
        <span class="badge">${weekRelation(week.week)}</span>
        <span class="history-meta">${plural(planned, 'pasto', 'pasti')} su 14</span>
        <a class="btn btn-sm history-open" href="#/settimana/${week.week}">Apri</a>
      </header>
      <div class="mini-week">
        <div class="mini-label"></div><div class="mini-label">Pranzo</div><div class="mini-label">Cena</div>
        ${cells}
      </div>
      ${week.notes.trim() ? `<p class="history-notes"><strong>Note:</strong> ${esc(truncate(week.notes.trim(), 200))}</p>` : ''}
    </article>`;
}

// ---------------------------------------------------------------------------
// Eventi (delegati sul contenitore principale)
// ---------------------------------------------------------------------------

const actions = {
  'open-picker': (el) => {
    const slot = el.closest('.slot');
    openPicker(slot.dataset.day, slot.dataset.meal);
  },
  'remove-entry': (el) => {
    const slot = el.closest('.slot');
    state.week.meals[slot.dataset.day][slot.dataset.meal].splice(Number(el.closest('.chip').dataset.index), 1);
    renderSlots();
    scheduleSave();
  },
  print: () => window.print(),
  'dish-filter': (el) => {
    state.dishFilter.category = el.dataset.category;
    renderDishList();
  },
  'dish-edit': (el) => {
    state.editingDishId = el.closest('.dish-row').dataset.id;
    renderDishList();
    app.querySelector('.dish-edit-form input[name="name"]')?.focus();
  },
  'dish-cancel': () => {
    state.editingDishId = null;
    renderDishList();
  },
  'dish-delete': (el) => deleteDish(el.closest('.dish-row').dataset.id),
  retry: () => (state.user ? route() : start()),
};

// Gestori registrati dagli altri file, scelti con data-submit / data-input / data-change.
const formHandlers = {};
const inputHandlers = {};
const changeHandlers = {
  'week-start': (el) => changeWeekStart(el),
};

// Cambia il giorno di inizio delle settimane: il server riorganizza quelle già salvate.
async function changeWeekStart(select) {
  const day = Number(select.value);
  const name = DAYS[day].name.toLowerCase();
  if (!confirm(`Far iniziare le settimane di ${name}?\n\nLe settimane già pianificate vengono riorganizzate: ogni pasto resta nel suo giorno; note e lista della spesa passano alla settimana che ne contiene la maggior parte.`)) {
    select.value = String(state.weekStartDay);
    return;
  }
  select.disabled = true;
  try {
    await flushWeekSave();
    const { weekStartDay } = await api('settings-save', { body: { weekStartDay: day } });
    state.weekStartDay = weekStartDay;
    toast(`Ora le settimane iniziano di ${DAYS[weekStartDay].name.toLowerCase()}`);
    // Resta sulla settimana che contiene la maggior parte di quella che si stava guardando.
    const target = `#/settimana/${toKey(weekStartOf(addDays(fromKey(state.week.key), 3)))}`;
    if (location.hash === target) route();
    else location.hash = target;
  } catch (err) {
    select.value = String(state.weekStartDay);
    select.disabled = false;
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  }
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
});

app.addEventListener('submit', (e) => {
  const form = e.target;
  e.preventDefault();
  if (form.id === 'login-form') {
    submitLogin(form);
  } else if (form.id === 'dish-form') {
    addDish(form);
  } else if (form.classList.contains('dish-edit-form')) {
    saveDishEdit(form);
  } else if (formHandlers[form.dataset.submit]) {
    formHandlers[form.dataset.submit](form, e);
  }
});

app.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'week-notes') {
    state.week.notes = el.value;
    scheduleSave(700);
  } else if (el.id === 'dish-search') {
    state.dishFilter.q = el.value;
    renderDishList();
  } else if (el.id === 'history-search') {
    state.historyQuery = el.value;
    renderHistory();
  } else if (inputHandlers[el.dataset.input]) {
    inputHandlers[el.dataset.input](el, e);
  }
});

app.addEventListener('change', (e) => {
  const el = e.target;
  if (changeHandlers[el.dataset.change]) changeHandlers[el.dataset.change](el, e);
});

app.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const escape = e.target.closest('[data-escape]')?.dataset.escape;
  if (escape) actions[escape]?.();
  else if (e.target.closest('.dish-edit-form')) actions['dish-cancel']();
});

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

// Prima di tutto chiedo al server chi è collegato: se nessuno, compare il login.
async function start() {
  try {
    const me = await api('me');
    state.weekStartDay = me.weekStartDay;
    setUser(me.user);
  } catch (err) {
    if (!(err instanceof AuthError)) showError(err);
    return;
  }
  route();
}

window.addEventListener('hashchange', route);
// Si parte quando anche recipes.js e groceries.js (caricati dopo) si sono registrati.
document.addEventListener('DOMContentLoaded', start);
