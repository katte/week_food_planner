'use strict';

/*
 * Spazio, utenti e account.
 *   #/utenti            il tuo spazio (dal nome in alto a destra): nome, persone che lo usano,
 *                       la tua email e la tua password, le tue passkey, i dati da scaricare,
 *                       eliminazione dello spazio
 *   #/admin             per chi gestisce il sito ('admins' in config.php): riepilogo e spazi
 *   #/admin/ID          scheda di uno spazio: utenti, numeri, sospensione, eliminazione, sola lettura
 *   #/iscriviti         senza accesso: crea uno spazio con il suo primo utente
 *   #/password          senza accesso: chiede il link per una nuova password (a chi ha un'email)
 *   #/reimposta/TOKEN   il link arrivato via email: sceglie la nuova password ed entra
 * Ogni spazio ha i suoi dati; chi è collegato può aggiungervi altre persone, sceglier loro
 * una nuova password se l'hanno dimenticata, toglierle, ed eliminare lo spazio.
 * Usa lo stato e le funzioni di app.js, caricato prima.
 */

routes.push(
  { nav: 'utenti', re: /^#\/utenti\/?$/, show: showUsers },
  { nav: 'utenti', re: /^#\/admin\/?$/, show: showAdmin },
  { nav: 'utenti', re: /^#\/admin\/(\d+)\/?$/, show: showAdminSpace },
);
publicRoutes.push(
  { re: /^#\/iscriviti\/?$/, show: showSignup },
  { re: /^#\/password\/?$/, show: showForgot },
  { re: /^#\/reimposta\/([A-Za-z0-9_-]{20,})\/?$/, show: showReset, always: true },
);

let userList = [];
let passkeyList = [];
let resettingUser = null; // utente dello spazio a cui si sta scegliendo una nuova password

async function showUsers(match, token) {
  const [users, passkeys] = await Promise.all([api('users'), api('passkeys')]);
  if (token !== renderToken) return;
  userList = users;
  passkeyList = passkeys;
  resettingUser = null;

  if (state.viewing) {
    app.innerHTML = `
      <div class="page">
        <header class="page-head">
          <div>
            <h1>${esc(state.viewing.name)}</h1>
            <p class="lead">Le persone di questo spazio. Sei in sola lettura: per gestirlo usa la sua scheda in Gestione.</p>
          </div>
        </header>
        <ul class="card user-list">${users.map((u) => `
          <li class="user-row"><span class="user-row-name">${esc(u.name)}</span>
            <span class="muted">${u.createdAt ? `dal ${shortDate(toKey(new Date(u.createdAt)))}` : ''}</span><span></span></li>`).join('')}
        </ul>
        <p><a href="#/admin/${state.viewing.id}">Scheda dello spazio in Gestione</a></p>
      </div>`;
    document.title = `${state.viewing.name} · Menù della settimana`;
    return;
  }

  app.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Il tuo spazio</h1>
          <p class="lead">Le persone che vedono e modificano gli stessi piatti, settimane e spese.</p>
        </div>
        <span id="user-count" class="count-pill"></span>
      </header>

      <form class="card space-form" data-submit="space-rename" autocomplete="off">
        <label class="field"><span>Nome dello spazio</span>
          <input name="name" required maxlength="80" value="${esc(state.space)}"></label>
        <button type="submit" class="btn">Salva</button>
      </form>

      <ul id="user-list" class="card user-list"></ul>

      <div class="user-forms">
        <form class="card user-form" data-submit="user-create" autocomplete="off">
          <h2 class="group-title">Aggiungi una persona</h2>
          <p class="muted">Avrà accesso a questo spazio con il nome e la password che scegli: comunicaglieli tu.</p>
          <label class="field"><span>Nome utente</span>
            <input name="username" required maxlength="40" autocapitalize="none" spellcheck="false"
              placeholder="lettere minuscole, numeri, . _ -"></label>
          <label class="field"><span>Password (almeno 8 caratteri)</span>
            <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <label class="field"><span>Ripeti la password</span>
            <input name="repeat" type="password" required minlength="8" autocomplete="new-password"></label>
          <button type="submit" class="btn btn-primary">${ICONS.plus}Aggiungi</button>
        </form>

        <form class="card user-form" data-submit="account-update" autocomplete="off">
          <h2 class="group-title">La tua email</h2>
          <p class="muted">Serve solo a mandarti un link se dimentichi la password. Facoltativa.</p>
          <label class="field"><span>Email</span>
            <input name="email" type="email" maxlength="190" autocomplete="email" value="${esc(state.email ?? '')}"></label>
          <button type="submit" class="btn">Salva</button>
        </form>

        <form class="card user-form" data-submit="user-password" autocomplete="off">
          <h2 class="group-title">Cambia la tua password</h2>
          <label class="field"><span>Password attuale</span>
            <input name="current" type="password" required autocomplete="current-password"></label>
          <label class="field"><span>Nuova password (almeno 8 caratteri)</span>
            <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <label class="field"><span>Ripeti la nuova password</span>
            <input name="repeat" type="password" required minlength="8" autocomplete="new-password"></label>
          <button type="submit" class="btn">Cambia password</button>
          <p class="muted">Sugli altri dispositivi dovrai rifare l'accesso.</p>
        </form>

        <section class="card user-form">
          <h2 class="group-title">Le tue passkey</h2>
          <p class="muted">Con una passkey entri con l'impronta, il volto o il PIN del dispositivo, senza scrivere la password.</p>
          <ul id="passkey-list" class="passkey-list"></ul>
          ${passkeySupported()
            ? `<button type="button" class="btn" data-action="passkey-add">${ICONS.key}Aggiungi una passkey</button>`
            : '<p class="muted">Per usare le passkey apri il sito in https.</p>'}
        </section>

        <section class="card user-form">
          <h2 class="group-title">Scarica i tuoi dati</h2>
          <p class="muted">Una copia di tutto lo spazio in un file (JSON): piatti e ricette, ingredienti, articoli,
            scontrini, settimane e liste della spesa. Tienila come backup o usala per portare i dati altrove.</p>
          <button type="button" class="btn" data-action="export-download">${ICONS.download}Scarica i dati</button>
        </section>
      </div>

      <section class="danger-zone space-delete">
        <h2 class="group-title">Elimina lo spazio</h2>
        <p class="muted">Cancella per sempre piatti, ricette, settimane, liste della spesa, scontrini e tutti gli utenti
          di questo spazio. Non si può annullare.</p>
        <form class="space-delete-form" data-submit="space-delete" autocomplete="off">
          <input name="password" type="password" class="input" required autocomplete="current-password"
            placeholder="la tua password" aria-label="La tua password, per confermare">
          <button type="submit" class="btn btn-ghost btn-sm btn-danger">Elimina lo spazio</button>
        </form>
        ${state.admin ? '<p><a href="#/admin">Gestione del sito: tutti gli spazi</a></p>' : ''}
      </section>
    </div>`;
  renderUserList();
  renderPasskeys();
  document.title = 'Il tuo spazio · Menù della settimana';
}

function renderUserList() {
  document.getElementById('user-count').textContent = plural(userList.length, 'persona', 'persone');
  document.getElementById('user-list').innerHTML = userList
    .map((u) => `
      <li class="user-row" data-name="${esc(u.name)}">
        <span class="user-row-name">${esc(u.name)}${u.me ? ' <span class="tag tag-ok">sei tu</span>' : ''}</span>
        <span class="muted">${u.createdAt ? `dal ${shortDate(toKey(new Date(u.createdAt)))}` : ''}</span>
        <span class="user-row-actions">
          ${u.me ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-action="user-reset">Nuova password</button>'}
          ${userList.length > 1 ? '<button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="user-delete">Togli</button>' : ''}
        </span>
        ${u.name === resettingUser ? `
          <form class="user-reset-form" data-submit="user-reset" autocomplete="off">
            <input name="password" type="password" class="input" required minlength="8" autocomplete="new-password"
              placeholder="nuova password (almeno 8 caratteri)" aria-label="Nuova password per ${esc(u.name)}">
            <input name="repeat" type="password" class="input" required minlength="8" autocomplete="new-password"
              placeholder="ripetila" aria-label="Ripeti la nuova password">
            <button type="submit" class="btn btn-primary btn-sm">Salva</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="user-reset-cancel">Annulla</button>
          </form>` : ''}
      </li>`)
    .join('');
  document.querySelector('.user-reset-form input')?.focus();
}

function renderPasskeys() {
  const day = (iso) => shortDate(toKey(new Date(iso)));
  document.getElementById('passkey-list').innerHTML = passkeyList.length
    ? passkeyList.map((p) => `
        <li class="passkey-row" data-id="${esc(p.id)}">
          <span><b>${esc(p.name)}</b>
            <small class="muted">aggiunta il ${day(p.createdAt)}${p.lastUsedAt ? ` · usata il ${day(p.lastUsedAt)}` : ''}</small></span>
          <button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="passkey-delete">Elimina</button>
        </li>`).join('')
    : '<li class="muted">Nessuna passkey per ora.</li>';
}

// ---------------------------------------------------------------------------
// Gestione del sito: riepilogo, spazi, scheda di uno spazio
// ---------------------------------------------------------------------------

const admin = {
  overview: { stats: {}, spaces: [] },
  query: '',
  sort: 'created', // created | seen | name | dishes
  space: null, // scheda aperta (#/admin/ID)
  resetting: null, // utente della scheda a cui si sta scegliendo una nuova password
};

const adminDay = (iso) => (iso ? shortDate(toKey(new Date(iso))) : '—');

async function showAdmin(match, token) {
  const overview = await api('admin-overview');
  if (token !== renderToken) return;
  admin.overview = overview;
  const s = overview.stats;
  const figure = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  app.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Gestione</h1>
          <p class="lead">Gli spazi del sito: chi li usa e quanto. Da ognuno puoi aprirne i dati in sola lettura.</p>
        </div>
      </header>
      <dl class="figures figures-wide card admin-stats">
        ${figure('Spazi', s.spaces)}${figure('Utenti', s.users)}${figure('Nuovi in 7 giorni', s.new7)}
        ${figure('Nuovi in 30 giorni', s.new30)}${figure('Attivi in 7 giorni', s.active7)}${figure('Sospesi', s.suspended)}
      </dl>
      <div class="toolbar">
        <input class="input" type="search" placeholder="Cerca uno spazio, un utente o un'email…" aria-label="Cerca"
          value="${esc(admin.query)}" data-input="admin-search">
        <select class="input admin-sort" data-change="admin-sort" aria-label="Ordina">
          ${[['created', 'Più recenti'], ['seen', 'Ultimo accesso'], ['name', 'Nome'], ['dishes', 'Più piatti']]
            .map(([v, l]) => `<option value="${v}"${v === admin.sort ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-primary" data-action="admin-new">${ICONS.plus}Nuovo spazio</button>
      </div>
      <form class="card user-form admin-create" data-submit="admin-space-create" autocomplete="off" hidden>
        <h2 class="group-title">Nuovo spazio</h2>
        <p class="muted">Con il suo primo utente: nome e password li comunichi tu a chi lo userà.</p>
        <div class="admin-create-fields">
          <label class="field"><span>Nome dello spazio</span>
            <input name="name" maxlength="80" placeholder="es. Famiglia Rossi"></label>
          <label class="field"><span>Nome utente</span>
            <input name="username" required maxlength="40" autocapitalize="none" spellcheck="false"
              placeholder="lettere minuscole, numeri, . _ -"></label>
          <label class="field"><span>Email <i>(facoltativa)</i></span>
            <input name="email" type="email" maxlength="190"></label>
          <label class="field"><span>Password (almeno 8 caratteri)</span>
            <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <label class="field"><span>Ripeti la password</span>
            <input name="repeat" type="password" required minlength="8" autocomplete="new-password"></label>
        </div>
        <div class="recipe-actions">
          <button type="submit" class="btn btn-primary">Crea lo spazio</button>
          <button type="button" class="btn btn-ghost" data-action="admin-new">Annulla</button>
        </div>
      </form>
      <p id="space-count" class="result-count"></p>
      <ul id="space-list" class="card user-list"></ul>
    </div>`;
  renderAdminSpaces();
  document.title = 'Gestione · Menù della settimana';
}

function renderAdminSpaces() {
  const list = document.getElementById('space-list');
  if (!list) return;
  const q = fold(admin.query.trim());
  const sorters = {
    created: (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
    seen: (a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''),
    name: (a, b) => a.name.localeCompare(b.name, 'it'),
    dishes: (a, b) => b.dishes - a.dishes,
  };
  const spaces = admin.overview.spaces
    .filter((s) => !q || fold(`${s.name} ${s.users} ${s.emails}`).includes(q))
    .sort(sorters[admin.sort]);
  document.getElementById('space-count').textContent = q
    ? `${plural(spaces.length, 'spazio trovato', 'spazi trovati')} su ${admin.overview.spaces.length}`
    : plural(spaces.length, 'spazio', 'spazi');
  list.innerHTML = spaces.length ? spaces.map((s) => `
    <li class="user-row admin-space">
      <span class="user-row-name"><a href="#/admin/${s.id}">${highlight(s.name, admin.query)}</a>
        ${s.mine ? '<span class="tag tag-ok">il tuo</span>' : ''}${s.suspended ? '<span class="tag tag-new">sospeso</span>' : ''}
        <small class="muted">${highlight(s.users || 'nessun utente', admin.query)}</small></span>
      <span class="muted">dal ${adminDay(s.createdAt)} · ${plural(s.dishes, 'piatto', 'piatti')} ·
        ${plural(s.weeks, 'settimana', 'settimane')} · ${plural(s.receipts, 'scontrino', 'scontrini')} ·
        ultimo accesso ${adminDay(s.lastSeen)}</span>
      <span class="user-row-actions"><a class="btn btn-ghost btn-sm" href="#/admin/${s.id}">Apri</a></span>
    </li>`).join('') : '<li class="muted user-row">Nessuno spazio trovato.</li>';
}

async function showAdminSpace(match, token) {
  const space = await api('admin-space', { params: { id: match[1] } });
  if (token !== renderToken) return;
  admin.space = space;
  admin.resetting = null;
  renderAdminSpace();
}

function renderAdminSpace() {
  const s = admin.space;
  const c = s.counts;
  const figure = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  app.innerHTML = `
    <div class="page">
      <a class="back-link" href="#/admin">← Tutti gli spazi</a>
      <header class="page-head">
        <div>
          <h1>${esc(s.name)}</h1>
          <p class="lead">Creato il ${adminDay(s.createdAt)}${s.mine ? ' · è il tuo spazio' : ''}
            ${s.suspended ? ' · <b class="admin-suspended">sospeso: nessuno può entrare</b>' : ''}</p>
        </div>
      </header>

      <div class="card admin-space-head">
        <form class="space-form" data-submit="admin-space-rename" autocomplete="off">
          <label class="field"><span>Nome dello spazio</span>
            <input name="name" required maxlength="80" value="${esc(s.name)}"></label>
          <button type="submit" class="btn">Salva</button>
        </form>
        ${s.mine ? '' : `
          <div class="admin-space-actions">
            <button type="button" class="btn btn-primary" data-action="admin-view">Apri in sola lettura</button>
            <button type="button" class="btn" data-action="admin-suspend">${s.suspended ? 'Riattiva' : 'Sospendi'}</button>
            <button type="button" class="btn btn-ghost btn-danger" data-action="admin-space-delete">Elimina lo spazio</button>
          </div>`}
      </div>

      <dl class="figures figures-wide card">
        ${figure('Piatti', c.dishes)}${figure('Con ricetta', c.recipes)}${figure('Ingredienti', c.ingredients)}
        ${figure('Articoli', c.products)}${figure('Scontrini', c.receipts)}${figure('Settimane', c.weeks)}
        ${figure('Ultima settimana salvata', adminDay(s.lastWeek))}
      </dl>

      <h2 class="group-title">Utenti</h2>
      <ul class="card user-list">${s.users.map((u) => `
        <li class="user-row" data-name="${esc(u.name)}">
          <span class="user-row-name">${esc(u.name)}${u.me ? ' <span class="tag tag-ok">sei tu</span>' : ''}
            <small class="muted">${u.email ? esc(u.email) : 'nessuna email'}</small></span>
          <span class="muted">dal ${adminDay(u.createdAt)} · ultimo accesso ${adminDay(u.lastSeen)}</span>
          <span class="user-row-actions">${u.me ? '' : `
            <button type="button" class="btn btn-ghost btn-sm" data-action="admin-user-reset">Nuova password</button>
            ${s.users.length > 1 ? '<button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="admin-user-delete">Togli</button>' : ''}`}
          </span>
          ${u.name === admin.resetting ? `
            <form class="user-reset-form" data-submit="admin-user-reset" autocomplete="off">
              <input name="password" type="password" class="input" required minlength="8" autocomplete="new-password"
                placeholder="nuova password (almeno 8 caratteri)" aria-label="Nuova password per ${esc(u.name)}">
              <input name="repeat" type="password" class="input" required minlength="8" autocomplete="new-password"
                placeholder="ripetila" aria-label="Ripeti la nuova password">
              <button type="submit" class="btn btn-primary btn-sm">Salva</button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="admin-user-reset-cancel">Annulla</button>
            </form>` : ''}
        </li>`).join('')}
      </ul>

      <form class="card user-form admin-user-form" data-submit="admin-user-create" autocomplete="off">
        <h2 class="group-title">Aggiungi un utente a questo spazio</h2>
        <div class="admin-create-fields">
          <label class="field"><span>Nome utente</span>
            <input name="username" required maxlength="40" autocapitalize="none" spellcheck="false"></label>
          <label class="field"><span>Email <i>(facoltativa)</i></span>
            <input name="email" type="email" maxlength="190"></label>
          <label class="field"><span>Password (almeno 8 caratteri)</span>
            <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <label class="field"><span>Ripeti la password</span>
            <input name="repeat" type="password" required minlength="8" autocomplete="new-password"></label>
        </div>
        <button type="submit" class="btn">${ICONS.plus}Aggiungi</button>
      </form>
    </div>`;
  document.querySelector('.user-reset-form input')?.focus();
  document.title = `${s.name} · Gestione · Menù della settimana`;
}

// Chiamata di gestione dalla scheda: aggiorna la scheda con lo spazio restituito.
async function adminCall(action, body, message) {
  try {
    admin.space = await api(action, { body });
    admin.resetting = null;
    renderAdminSpace();
    if (message) toast(message);
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  }
}

// Esce dalla sola lettura e torna alla scheda dello spazio che stava guardando.
document.getElementById('view-stop').addEventListener('click', async () => {
  const viewed = state.viewing;
  try {
    setMe(await api('view-stop', { post: true }));
    state.week = null;
    state.lastWeekKey = null;
    location.hash = viewed ? `#/admin/${viewed.id}` : '#/admin';
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  }
});

// ---------------------------------------------------------------------------
// Senza accesso: iscrizione e recupero della password
// ---------------------------------------------------------------------------

function publicPage(title, content) {
  setMe(null);
  app.innerHTML = `<div class="login">${content}</div>`;
  document.title = `${title} · Menù della settimana`;
  app.querySelector('input:not([type="hidden"])')?.focus();
}

function showSignup() {
  publicPage('Crea il tuo spazio', `
    <form class="card login-card" data-submit="signup" autocomplete="off">
      <h1>Crea il tuo spazio</h1>
      <p class="lead">Gratis. Piatti, settimane e spese che inserisci li vede solo chi aggiungi tu al tuo spazio.</p>
      <label class="field"><span>Nome utente</span>
        <input name="username" required maxlength="40" autocomplete="username" autocapitalize="none" spellcheck="false"
          placeholder="lettere minuscole, numeri, . _ -"></label>
      <label class="field"><span>Password (almeno 8 caratteri)</span>
        <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label class="field"><span>Ripeti la password</span>
        <input name="repeat" type="password" required minlength="8" autocomplete="new-password"></label>
      <label class="field"><span>Email <i>(facoltativa: serve solo se dimentichi la password)</i></span>
        <input name="email" type="email" maxlength="190" autocomplete="email"></label>
      <label class="field"><span>Nome dello spazio <i>(facoltativo)</i></span>
        <input name="space" maxlength="80" placeholder="es. Famiglia Rossi"></label>
      <label class="trap" aria-hidden="true">Sito web <input name="website" tabindex="-1" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="accept" required>
        <span>Ho letto l'<a href="privacy.php" target="_blank" rel="noopener">informativa sulla privacy</a></span></label>
      <label class="check"><input type="checkbox" name="remember" checked> Resta collegato su questo dispositivo</label>
      <p class="login-error" role="alert" hidden></p>
      <button type="submit" class="btn btn-primary">Crea lo spazio</button>
      <p class="login-links"><a href="#/settimana">Hai già un account? Accedi</a></p>
    </form>`);
}

function showForgot() {
  publicPage('Password dimenticata', `
    <form class="card login-card" data-submit="password-forgot" autocomplete="off">
      <h1>Password dimenticata</h1>
      <p class="lead">Se al tuo utente è collegata un'email, ti mandiamo un link per sceglierne una nuova.</p>
      <label class="field"><span>Nome utente o email</span>
        <input name="login" required maxlength="190" autocapitalize="none" spellcheck="false" autocomplete="username"></label>
      <p class="login-error" role="alert" hidden></p>
      <button type="submit" class="btn btn-primary">Mandami il link</button>
      <p class="muted">Senza email: chiedi a un'altra persona del tuo spazio di sceglierti una nuova password dalla pagina
        dello spazio, oppure entra con una passkey se ne hai una.</p>
      <p class="login-links"><a href="#/settimana">Torna all'accesso</a></p>
    </form>`);
}

function showReset(match) {
  publicPage('Nuova password', `
    <form class="card login-card" data-submit="password-reset" data-token="${esc(match[1])}" autocomplete="off">
      <h1>Nuova password</h1>
      <p class="lead">Scegli la nuova password: poi entri direttamente.</p>
      <label class="field"><span>Nuova password (almeno 8 caratteri)</span>
        <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label class="field"><span>Ripeti la nuova password</span>
        <input name="repeat" type="password" required minlength="8" autocomplete="new-password"></label>
      <p class="login-error" role="alert" hidden></p>
      <button type="submit" class="btn btn-primary">Salva ed entra</button>
      <p class="login-links"><a href="#/password">Chiedi un nuovo link</a></p>
    </form>`);
}

// Invia un modulo delle pagine senza accesso; gli errori compaiono nel modulo.
async function submitPublicForm(form, action, body, done) {
  const button = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.login-error');
  error.hidden = true;
  button.disabled = true;
  try {
    done(await api(action, { body }));
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Passkey (WebAuthn): il server controlla tutto in lib/passkeys.php
// ---------------------------------------------------------------------------

// Funzionano solo in https (o su localhost) e con un browser che le supporta.
const passkeySupported = () => window.isSecureContext && 'PublicKeyCredential' in window;

const b64uEncode = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (text) => Uint8Array.from(
  atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)),
  (c) => c.charCodeAt(0),
);

function passkeyError(err) {
  if (err?.name === 'NotAllowedError') return 'Operazione annullata o scaduta';
  if (err?.name === 'InvalidStateError') return 'Su questo dispositivo hai già una passkey per il tuo utente';
  if (err?.name === 'SecurityError') return 'Le passkey funzionano solo aprendo il sito in https';
  return err?.message || 'Passkey non disponibile';
}

// Nome proposto per la passkey, per riconoscerla nell'elenco.
function passkeyDeviceName() {
  const ua = navigator.userAgent;
  const device = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iPhone o iPad'
    : /Mac/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux' : 'questo dispositivo';
  return `Passkey su ${device}`;
}

async function addPasskey(button) {
  button.disabled = true;
  try {
    const options = await api('passkey-register-options', { post: true });
    const credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: b64uDecode(options.challenge),
        user: { ...options.user, id: b64uDecode(options.user.id) },
        excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: b64uDecode(c.id) })),
      },
    });
    passkeyList = await api('passkey-register', {
      body: {
        clientDataJSON: b64uEncode(credential.response.clientDataJSON),
        attestationObject: b64uEncode(credential.response.attestationObject),
        name: passkeyDeviceName(),
      },
    });
    renderPasskeys();
    toast('Passkey aggiunta: la prossima volta puoi entrare con quella');
  } catch (err) {
    if (!(err instanceof AuthError)) toast(passkeyError(err), 'error');
  } finally {
    button.disabled = false;
  }
}

// Dalla pagina di accesso: il dispositivo propone le passkey salvate per questo sito.
async function loginWithPasskey(button) {
  const error = document.getElementById('login-error');
  error.hidden = true;
  button.disabled = true;
  try {
    const options = await api('passkey-login-options', { post: true });
    const credential = await navigator.credentials.get({
      publicKey: { ...options, challenge: b64uDecode(options.challenge) },
    });
    enter(await api('passkey-login', {
      body: {
        id: credential.id,
        clientDataJSON: b64uEncode(credential.response.clientDataJSON),
        authenticatorData: b64uEncode(credential.response.authenticatorData),
        signature: b64uEncode(credential.response.signature),
        remember: button.form.elements.remember.checked,
      },
    }));
  } catch (err) {
    error.textContent = passkeyError(err);
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function submitUserForm(form, action, done, body = Object.fromEntries(new FormData(form))) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api(action, { body });
    form.reset();
    done(result, body);
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

Object.assign(formHandlers, {
  'user-create': (form) => submitUserForm(form, 'user-create', (users, data) => {
    userList = users;
    renderUserList();
    toast(`«${data.username.trim().toLowerCase()}» aggiunto allo spazio`);
  }),
  'user-password': (form) => submitUserForm(form, 'user-password', () => toast('Password cambiata')),
  'user-reset': (form) => submitUserForm(form, 'user-reset', () => {
    toast(`Nuova password per «${resettingUser}»: comunicagliela tu`);
    resettingUser = null;
    renderUserList();
  }, { ...Object.fromEntries(new FormData(form)), username: resettingUser }),
  'account-update': (form) => submitUserForm(form, 'account-update', (me) => {
    setMe(me);
    form.elements.email.value = me.email ?? '';
    toast(me.email ? 'Email salvata' : 'Email tolta');
  }),
  'space-rename': (form) => submitUserForm(form, 'space-update', (me) => {
    setMe(me);
    form.elements.name.value = me.space;
    toast('Nome dello spazio salvato');
  }),
  'space-delete': (form) => {
    if (!confirm(`Eliminare lo spazio «${state.space}» con tutti i suoi dati e i suoi utenti?\n\nNon si può annullare.`)) return;
    submitUserForm(form, 'space-delete', () => {
      showLogin('Lo spazio è stato eliminato, con tutti i suoi dati.');
    });
  },
  signup: (form) => {
    const data = Object.fromEntries(new FormData(form));
    submitPublicForm(form, 'signup', { ...data, accept: Boolean(data.accept), remember: Boolean(data.remember) }, (me) => {
      enter(me, '#/settimana');
      toast(`Benvenuto! Lo spazio «${me.space}» è pronto: comincia dai tuoi piatti`);
    });
  },
  'password-forgot': (form) => submitPublicForm(form, 'password-forgot', Object.fromEntries(new FormData(form)), () => {
    form.innerHTML = `
      <h1>Controlla la posta</h1>
      <p class="lead">Se il nome o l'email corrispondono a un utente con un'email, ti abbiamo mandato un link per
        scegliere una nuova password. Vale un'ora; guarda anche nella posta indesiderata.</p>
      <p class="login-links"><a href="#/settimana">Torna all'accesso</a></p>`;
  }),
  'admin-space-create': (form) => submitUserForm(form, 'admin-space-create', (space) => {
    toast(`Spazio «${space.name}» creato`);
    location.hash = `#/admin/${space.id}`;
  }),
  'admin-space-rename': (form) => adminCall('admin-space-update', { id: admin.space.id, name: form.elements.name.value },
    'Nome dello spazio salvato'),
  'admin-user-create': (form) => {
    const data = Object.fromEntries(new FormData(form));
    adminCall('admin-user-create', { ...data, id: admin.space.id }, `«${data.username.trim().toLowerCase()}» aggiunto`);
  },
  'admin-user-reset': (form) => adminCall('admin-user-reset',
    { ...Object.fromEntries(new FormData(form)), username: admin.resetting },
    `Nuova password per «${admin.resetting}»: comunicagliela tu`),
  'password-reset': (form) => submitPublicForm(form, 'password-reset',
    { ...Object.fromEntries(new FormData(form)), token: form.dataset.token }, (me) => {
      enter(me, '#/settimana');
      toast('Password cambiata: sei dentro');
    }),
});

Object.assign(inputHandlers, {
  'admin-search': (el) => {
    admin.query = el.value;
    renderAdminSpaces();
  },
});

Object.assign(changeHandlers, {
  'admin-sort': (el) => {
    admin.sort = el.value;
    renderAdminSpaces();
  },
});

// Nome del file scaricato: menu-della-settimana-<spazio>-<data>.json
function exportFileName(spaceName) {
  const slug = fold(spaceName).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'spazio';
  return `menu-della-settimana-${slug}-${toKey(new Date())}.json`;
}

Object.assign(actions, {
  'export-download': async (el) => {
    el.disabled = true;
    try {
      const data = await api('export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: exportFileName(data.space.name) });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Dati scaricati');
    } catch (err) {
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    } finally {
      el.disabled = false;
    }
  },
  'passkey-login': (el) => loginWithPasskey(el),
  'passkey-add': (el) => addPasskey(el),
  'passkey-delete': async (el) => {
    const row = el.closest('.passkey-row');
    if (!confirm(`Eliminare «${row.querySelector('b').textContent}»?\n\nNon potrai più entrare con quella passkey; ricordati di toglierla anche dal dispositivo.`)) return;
    try {
      passkeyList = await api('passkey-delete', { body: { id: row.dataset.id } });
      renderPasskeys();
      toast('Passkey eliminata');
    } catch (err) {
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    }
  },
  'user-reset': (el) => {
    resettingUser = el.closest('.user-row').dataset.name;
    renderUserList();
  },
  'user-reset-cancel': () => {
    resettingUser = null;
    renderUserList();
  },
  'user-delete': async (el) => {
    const name = el.closest('.user-row').dataset.name;
    const self = name === state.user;
    const question = self
      ? 'Toglierti da questo spazio?\n\nNon potrai più accedere; i dati restano alle altre persone.'
      : `Togliere «${name}» dallo spazio?\n\nNon potrà più accedere; i dati restano.`;
    if (!confirm(question)) return;
    try {
      userList = await api('user-delete', { body: { username: name } });
      if (self) {
        showLogin('Non fai più parte dello spazio.');
        return;
      }
      renderUserList();
      toast(`«${name}» tolto dallo spazio`);
    } catch (err) {
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    }
  },
  'admin-new': () => {
    const form = document.querySelector('.admin-create');
    form.hidden = !form.hidden;
    if (!form.hidden) form.elements.name.focus();
  },
  'admin-view': async () => {
    try {
      setMe(await api('admin-space-view', { body: { id: admin.space.id } }));
      state.week = null;
      state.lastWeekKey = null;
      location.hash = '#/settimana';
      toast(`Stai guardando «${admin.space.name}» in sola lettura`);
    } catch (err) {
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    }
  },
  'admin-suspend': () => {
    const s = admin.space;
    const question = s.suspended
      ? `Riattivare «${s.name}»?\n\nI suoi utenti potranno di nuovo entrare.`
      : `Sospendere «${s.name}»?\n\nI suoi utenti non potranno più entrare (chi è collegato viene fatto uscire); i dati restano.`;
    if (confirm(question)) adminCall('admin-space-suspend', { id: s.id, suspended: !s.suspended }, s.suspended ? 'Spazio riattivato' : 'Spazio sospeso');
  },
  'admin-space-delete': async () => {
    const s = admin.space;
    if (!confirm(`Eliminare lo spazio «${s.name}» (${s.users.map((u) => u.name).join(', ') || 'nessun utente'}) con tutti i suoi dati?\n\nNon si può annullare.`)) return;
    try {
      await api('admin-space-delete', { body: { id: s.id } });
      toast(`Spazio «${s.name}» eliminato`);
      location.hash = '#/admin';
    } catch (err) {
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    }
  },
  'admin-user-reset': (el) => {
    admin.resetting = el.closest('.user-row').dataset.name;
    renderAdminSpace();
  },
  'admin-user-reset-cancel': () => {
    admin.resetting = null;
    renderAdminSpace();
  },
  'admin-user-delete': (el) => {
    const name = el.closest('.user-row').dataset.name;
    if (confirm(`Togliere «${name}» dallo spazio «${admin.space.name}»?\n\nNon potrà più accedere; i dati restano.`)) {
      adminCall('admin-user-delete', { username: name }, `«${name}» tolto`);
    }
  },
});
