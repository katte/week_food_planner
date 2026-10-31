'use strict';

/*
 * Pagina «Utenti» (#/utenti, dal nome in alto a destra): chi può accedere al sito.
 * Tutti gli utenti vedono e modificano gli stessi dati; chi è collegato può aggiungerne
 * altri, eliminarli (anche se stesso, ma non l'ultimo), cambiare la propria password e
 * registrare le proprie passkey, con cui poi entrare senza password (pulsante nella pagina
 * di accesso). Il primo utente si crea con setup.php.
 * Usa lo stato e le funzioni di app.js, caricato prima.
 */

routes.push({ nav: 'utenti', re: /^#\/utenti\/?$/, show: showUsers });

let userList = [];
let passkeyList = [];

async function showUsers(match, token) {
  const [users, passkeys] = await Promise.all([api('users'), api('passkeys')]);
  if (token !== renderToken) return;
  userList = users;
  passkeyList = passkeys;

  app.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Utenti</h1>
          <p class="lead">Chi può accedere al sito. Tutti vedono e modificano gli stessi piatti, settimane e spese.</p>
        </div>
        <span id="user-count" class="count-pill"></span>
      </header>

      <ul id="user-list" class="card user-list"></ul>

      <div class="user-forms">
        <form class="card user-form" data-submit="user-create" autocomplete="off">
          <h2 class="group-title">Aggiungi un utente</h2>
          <label class="field"><span>Nome utente</span>
            <input name="username" required maxlength="40" autocapitalize="none" spellcheck="false"
              placeholder="lettere minuscole, numeri, . _ -"></label>
          <label class="field"><span>Password (almeno 8 caratteri)</span>
            <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <label class="field"><span>Ripeti la password</span>
            <input name="repeat" type="password" required minlength="8" autocomplete="new-password"></label>
          <button type="submit" class="btn btn-primary">${ICONS.plus}Aggiungi</button>
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
          <p class="muted">Sugli altri dispositivi dovrai rifare l'accesso. Se un utente dimentica la password,
            puoi eliminarlo e ricrearlo, oppure reimpostarla da <a href="setup.php">setup.php</a>.</p>
        </form>

        <section class="card user-form">
          <h2 class="group-title">Le tue passkey</h2>
          <p class="muted">Con una passkey entri con l'impronta, il volto o il PIN del dispositivo, senza scrivere la password.</p>
          <ul id="passkey-list" class="passkey-list"></ul>
          ${passkeySupported()
            ? `<button type="button" class="btn" data-action="passkey-add">${ICONS.key}Aggiungi una passkey</button>`
            : '<p class="muted">Per usare le passkey apri il sito in https.</p>'}
        </section>
      </div>
    </div>`;
  renderUserList();
  renderPasskeys();
  document.title = 'Utenti · Menù della settimana';
}

function renderUserList() {
  document.getElementById('user-count').textContent = plural(userList.length, 'utente', 'utenti');
  document.getElementById('user-list').innerHTML = userList
    .map((u) => `
      <li class="user-row" data-name="${esc(u.name)}">
        <span class="user-row-name">${esc(u.name)}${u.me ? ' <span class="tag tag-ok">sei tu</span>' : ''}</span>
        <span class="muted">${u.createdAt ? `dal ${shortDate(toKey(new Date(u.createdAt)))}` : ''}</span>
        ${userList.length > 1 ? '<button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="user-delete">Elimina</button>' : '<span></span>'}
      </li>`)
    .join('');
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
    const { user, weekStartDay } = await api('passkey-login', {
      body: {
        id: credential.id,
        clientDataJSON: b64uEncode(credential.response.clientDataJSON),
        authenticatorData: b64uEncode(credential.response.authenticatorData),
        signature: b64uEncode(credential.response.signature),
        remember: button.form.elements.remember.checked,
      },
    });
    state.weekStartDay = weekStartDay;
    setUser(user);
    lastScrollKey = null;
    route();
  } catch (err) {
    error.textContent = passkeyError(err);
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function submitUserForm(form, action, done) {
  const data = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api(action, { body: data });
    form.reset();
    done(result, data);
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
    toast(`Utente «${data.username.trim().toLowerCase()}» aggiunto`);
  }),
  'user-password': (form) => submitUserForm(form, 'user-password', () => toast('Password cambiata')),
});

Object.assign(actions, {
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
  'user-delete': async (el) => {
    const name = el.closest('.user-row').dataset.name;
    const self = name === state.user;
    const question = self
      ? 'Eliminare il tuo utente?\n\nNon potrai più accedere al sito; i dati restano agli altri utenti.'
      : `Eliminare l'utente «${name}»?\n\nNon potrà più accedere al sito; i dati restano.`;
    if (!confirm(question)) return;
    try {
      userList = await api('user-delete', { body: { username: name } });
      if (self) {
        showLogin('Il tuo utente è stato eliminato.');
        return;
      }
      renderUserList();
      toast(`Utente «${name}» eliminato`);
    } catch (err) {
      if (!(err instanceof AuthError)) toast(err.message, 'error');
    }
  },
});
