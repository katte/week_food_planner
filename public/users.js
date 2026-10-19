'use strict';

/*
 * Pagina «Utenti» (#/utenti, dal nome in alto a destra): chi può accedere al sito.
 * Tutti gli utenti vedono e modificano gli stessi dati; chi è collegato può aggiungerne
 * altri, eliminarli (anche se stesso, ma non l'ultimo) e cambiare la propria password.
 * Il primo utente si crea con setup.php.
 * Usa lo stato e le funzioni di app.js, caricato prima.
 */

routes.push({ nav: 'utenti', re: /^#\/utenti\/?$/, show: showUsers });

let userList = [];

async function showUsers(match, token) {
  const users = await api('users');
  if (token !== renderToken) return;
  userList = users;

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
      </div>
    </div>`;
  renderUserList();
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
