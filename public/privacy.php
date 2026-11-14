<?php
/*
 * Informativa sulla privacy, linkata dalla pagina di iscrizione. L'indirizzo da contattare
 * è 'contact' in config.php. È una traccia: va adattata a chi gestisce il sito.
 */

declare(strict_types=1);

define('WFP_LIBRARY', true);
require __DIR__ . '/api.php';

header('Content-Type: text/html; charset=utf-8');
header('X-Frame-Options: DENY');

$contact = '';
try {
    $value = config()['contact'] ?? '';
    $contact = is_string($value) ? $value : '';
} catch (Throwable $e) {
    // Senza config.php la pagina si legge lo stesso, senza contatto.
}
$h = function (string $text): string {
    return htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
};
?>
<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Privacy · Menù della settimana</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="./">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle class="plate-rim" cx="32" cy="32" r="27"/>
        <circle class="plate-well" cx="32" cy="32" r="18"/>
        <circle class="plate-line" cx="32" cy="32" r="12"/>
      </svg>
      Menù della settimana
    </a>
  </header>

  <main class="app">
    <article class="page card privacy">
      <h1>Privacy</h1>
      <p class="lead">Cosa conserva questo sito, perché e come cancellarlo.</p>

      <h2>Chi gestisce i dati</h2>
      <p>Il sito è gestito a titolo personale<?= $contact !== '' ? ', contattabile a <a href="mailto:' . $h($contact) . '">' . $h($contact) . '</a>' : '' ?>.
        È un progetto gratuito, senza pubblicità.</p>

      <h2>Quali dati</h2>
      <ul>
        <li><b>Il tuo account:</b> nome utente, password (salvata solo in forma cifrata, non leggibile) e, se la indichi,
          l'email, usata solo per mandarti il link quando chiedi una nuova password.</li>
        <li><b>Quello che inserisci:</b> piatti, ricette, settimane, note, liste della spesa, scontrini importati
          (negozio, data, articoli e prezzi). Li vedono le persone del tuo spazio e, solo quando serve, chi gestisce
          il sito (vedi sotto).</li>
        <li><b>Accessi:</b> data dell'ultimo accesso di ogni utente.</li>
        <li><b>Indirizzo IP:</b> per i tentativi di accesso sbagliati, le iscrizioni e le richieste di una nuova
          password, per bloccare gli abusi. Si cancella da solo dopo un giorno.</li>
        <li><b>Cookie:</b> uno solo, tecnico, che ti tiene collegato. Nessun cookie di profilazione o di statistica.</li>
      </ul>

      <h2>Cosa vede chi gestisce il sito</h2>
      <p>L'elenco degli spazi con il loro nome, i nomi utente, le email, le date di iscrizione e di ultimo accesso e
        quanti piatti, settimane e scontrini contengono. Solo per aiutarti a risolvere un problema o per verificare un
        abuso può aprire il tuo spazio <b>in sola lettura</b>: vede quello che vedi tu, senza poter modificare nulla.
        Può anche sospendere o eliminare uno spazio usato in modo improprio.</p>

      <h2>Servizi esterni</h2>
      <ul>
        <li>Il carattere scritto a mano viene caricato da Google Fonts: il tuo browser si collega ai server di Google,
          che ricevono il tuo indirizzo IP.</li>
        <li>Per leggere gli scontrini sei tu a copiare il testo e le foto in un servizio di intelligenza artificiale
          (ChatGPT, Claude, Gemini…): il sito non manda nulla a quei servizi, e lì valgono le loro condizioni.</li>
      </ul>

      <h2>Per quanto tempo</h2>
      <p>Finché il tuo spazio esiste. Dalla pagina <b>Utenti</b> puoi eliminare lo spazio: tutti i suoi dati e i suoi
        utenti vengono cancellati subito (le copie di sicurezza del fornitore di hosting spariscono nei giorni seguenti).</p>

      <h2>I tuoi diritti</h2>
      <p>Puoi vedere e correggere i tuoi dati dal sito, cancellarli eliminando lo spazio, e per qualsiasi richiesta
        (accesso, rettifica, cancellazione, opposizione) scrivere <?= $contact !== '' ? 'a <a href="mailto:' . $h($contact) . '">' . $h($contact) . '</a>' : 'a chi gestisce il sito' ?>.
        Puoi anche rivolgerti al Garante per la protezione dei dati personali.</p>

      <p><a class="btn" href="./#/iscriviti">Torna all'iscrizione</a></p>
    </article>
  </main>
</body>
</html>
