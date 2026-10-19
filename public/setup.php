<?php
/*
 * Configurazione iniziale: controlla PHP, config.php e database, crea o aggiorna le
 * tabelle e crea il primo utente. Serve anche a reimpostare la password di un utente che
 * l'ha dimenticata. Creare o reimpostare chiede la chiave 'secret' di config.php: può
 * farlo solo chi ha accesso ai file del sito.
 */

declare(strict_types=1);

define('WFP_LIBRARY', true);
require __DIR__ . '/api.php';

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('X-Frame-Options: DENY');

function h(string $text): string
{
    return htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
}

// Un controllo: [titolo, riuscito, dettaglio]. Gli errori imprevisti vanno nel log, non nella pagina.
function check(string $label, callable $test, array &$checks): bool
{
    try {
        $checks[] = [$label, true, (string) $test()];
        return true;
    } catch (Throwable $e) {
        if (!$e instanceof HttpError) {
            error_log((string) $e);
        }
        $checks[] = [$label, false, $e instanceof HttpError ? $e->getMessage() : 'Errore imprevisto: i dettagli sono nel log degli errori di PHP'];
        return false;
    }
}

$checks = [];
$ready = check('PHP', function () {
    if (PHP_VERSION_ID < 70400) {
        throw new HttpError(500, 'Serve PHP 7.4 o successivo (questo è ' . PHP_VERSION . ')');
    }
    return PHP_VERSION;
}, $checks)
    && check('Estensione pdo_mysql', function () {
        if (!extension_loaded('pdo_mysql')) {
            throw new HttpError(500, "Attiva l'estensione pdo_mysql (pannello dell'hosting o php.ini)");
        }
        return 'attiva';
    }, $checks)
    && check('config.php', function () {
        config();
        secret();
        return 'presente, con la chiave segreta';
    }, $checks)
    && check('Database', function () {
        db();
        createSchema();
        return 'collegato; tabelle create o aggiornate (prefisso «' . (config()['db']['prefix'] ?? 'menu_') . '»)';
    }, $checks)
    && check('Utenti', function () {
        $n = count(users());
        return $n ? ($n === 1 ? '1 utente' : "$n utenti") : 'nessuno: crea il primo qui sotto';
    }, $checks);

$hasUsers = $ready && users();
$message = '';
$error = '';
$form = ['username' => ''];

if ($ready && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $form['username'] = is_string($_POST['username'] ?? null) ? $_POST['username'] : '';
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    try {
        checkAttempts($ip);
        if (!hash_equals(secret(), is_string($_POST['secret'] ?? null) ? trim($_POST['secret']) : '')) {
            recordFailedAttempt($ip);
            throw new HttpError(403, "La chiave non corrisponde a 'secret' in config.php");
        }
        $name = validUsername($form['username']);
        $password = validPassword($_POST['password'] ?? null, $_POST['repeat'] ?? null);
        if ($hasUsers) {
            if (!isset(users()[$name])) {
                throw new HttpError(404, "Non c'è nessun utente chiamato «{$name}»");
            }
            saveUser($name, $password, true);
            $message = "Password di «{$name}» reimpostata: ora puoi accedere con quella nuova.";
        } else {
            saveUser($name, $password);
            setAuthCookie($name, false);
            $message = "Utente «{$name}» creato: sei già collegato. Gli altri utenti si aggiungono dal sito, nella pagina Utenti.";
            $hasUsers = true;
        }
        $form['username'] = '';
    } catch (Throwable $e) {
        if (!$e instanceof HttpError) {
            error_log((string) $e);
        }
        $error = $e instanceof HttpError ? $e->getMessage() : 'Errore imprevisto: i dettagli sono nel log degli errori di PHP';
    }
}
?>
<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Configurazione · Menù della settimana</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&display=swap">
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
    <div class="login">
      <div class="card login-card setup-card">
        <h1>Configurazione</h1>
        <ul class="setup-checks">
          <?php foreach ($checks as [$label, $ok, $detail]): ?>
            <li class="<?= $ok ? 'is-ok' : 'is-ko' ?>"><b><?= $ok ? '✓' : '✗' ?> <?= h($label) ?></b> <span><?= h($detail) ?></span></li>
          <?php endforeach; ?>
        </ul>

        <?php if (!$ready): ?>
          <p class="login-error">Correggi il problema indicato e ricarica la pagina. Il modello della configurazione è in
            <code>config.example.php</code>: copialo in <code>config.php</code> e inserisci i dati del database.</p>
        <?php else: ?>
          <?php if ($message !== ''): ?><p class="login-note"><?= h($message) ?></p><?php endif; ?>
          <?php if ($error !== ''): ?><p class="login-error" role="alert"><?= h($error) ?></p><?php endif; ?>

          <form method="post" class="setup-form" autocomplete="off">
            <h2><?= $hasUsers ? 'Reimposta una password' : 'Crea il primo utente' ?></h2>
            <p class="lead"><?= $hasUsers
                ? 'Se un utente ha dimenticato la password, puoi sceglierne una nuova.'
                : 'Gli altri utenti potrai aggiungerli dal sito, nella pagina Utenti.' ?></p>
            <label class="field"><span>Chiave segreta</span>
              <input name="secret" type="password" required autocomplete="off" placeholder="il valore di 'secret' in config.php"></label>
            <label class="field"><span>Nome utente</span>
              <input name="username" required maxlength="40" autocapitalize="none" spellcheck="false" value="<?= h($form['username']) ?>"></label>
            <label class="field"><span><?= $hasUsers ? 'Nuova password' : 'Password' ?> (almeno <?= MIN_PASSWORD ?> caratteri)</span>
              <input name="password" type="password" required minlength="<?= MIN_PASSWORD ?>" autocomplete="new-password"></label>
            <label class="field"><span>Ripeti la password</span>
              <input name="repeat" type="password" required minlength="<?= MIN_PASSWORD ?>" autocomplete="new-password"></label>
            <button type="submit" class="btn btn-primary"><?= $hasUsers ? 'Reimposta la password' : 'Crea utente' ?></button>
          </form>
          <?php if ($hasUsers): ?><a class="btn" href="./">Vai al sito</a><?php endif; ?>
        <?php endif; ?>
      </div>
    </div>
  </main>
</body>
</html>
