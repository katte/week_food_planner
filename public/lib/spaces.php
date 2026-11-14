<?php
/*
 * Spazi: ogni famiglia (o gruppo, o persona sola) ha il suo, con piatti, settimane, spesa e
 * scontrini. Ogni utente appartiene a uno spazio e vede solo quello: tutte le query di
 * api.php e lib/groceries.php filtrano per spaceId(). Qui ci sono anche gli utenti,
 * l'iscrizione, il recupero della password via email, l'eliminazione di uno spazio, la
 * pagina per chi gestisce il sito e il passaggio agli spazi dei dati delle versioni di prima.
 * Incluso da api.php, che fornisce db(), tables(), transaction(), HttpError e le utilità.
 */

declare(strict_types=1);

const SIGNUPS_PER_HOUR = 3;     // iscrizioni dallo stesso indirizzo IP in un'ora
const SIGNUPS_PER_DAY = 100;    // iscrizioni in un giorno, in tutto il sito
const RESETS_PER_HOUR = 5;      // richieste di una nuova password dallo stesso indirizzo in un'ora
const RESET_MINUTES = 60;       // validità del link per reimpostare la password
const MAX_EMAIL = 190;

// Le tabelle che non dipendono da uno spazio vengono create da api.php e lib/groceries.php.
function spacesSchema(array $t, string $options): array
{
    return [
        "CREATE TABLE IF NOT EXISTS {$t['spaces']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(80) NOT NULL,
            suspended_at DATETIME NULL COMMENT 'sospeso da chi gestisce il sito: nessuno può entrare',
            created_at DATETIME NOT NULL,
            PRIMARY KEY (id)
        ) $options",
    ];
}

// Dopo gli utenti: i link per reimpostare la password (si salva solo l'hash del token).
function passwordResetSchema(array $t, string $options): array
{
    return [
        "CREATE TABLE IF NOT EXISTS {$t['password_resets']} (
            token_hash CHAR(64) NOT NULL,
            user_name VARCHAR(40) NOT NULL,
            created_at DATETIME NOT NULL,
            PRIMARY KEY (token_hash),
            KEY idx_user (user_name),
            FOREIGN KEY (user_name) REFERENCES {$t['users']} (name) ON DELETE CASCADE
        ) $options",
    ];
}

// ---------------------------------------------------------------------------
// Utente collegato e suo spazio
// ---------------------------------------------------------------------------

// Un utente: name, password_hash, space_id, email, space_name, suspended_at (del suo spazio),
// viewing_space_id e viewing_name (lo spazio che sta guardando, se gestisce il sito). null se non esiste.
function findUser(string $name, bool $reload = false): ?array
{
    static $cache = [];
    if ($reload || !array_key_exists($name, $cache)) {
        $t = tables();
        $stmt = db()->prepare(
            "SELECT u.name, u.password_hash, u.space_id, u.email, u.viewing_space_id,
                    s.name AS space_name, s.suspended_at, v.name AS viewing_name
             FROM {$t['users']} u
             JOIN {$t['spaces']} s ON s.id = u.space_id
             LEFT JOIN {$t['spaces']} v ON v.id = u.viewing_space_id
             WHERE u.name = ?"
        );
        $stmt->execute([$name]);
        $cache[$name] = $stmt->fetch() ?: null;
    }
    return $cache[$name];
}

function userCount(): int
{
    $t = tables();
    return (int) db()->query("SELECT COUNT(*) FROM {$t['users']}")->fetchColumn();
}

// L'utente di questa richiesta: dal cookie, oppure quello appena entrato ($set: login,
// iscrizione, passkey, nuova password). null se nessuno è collegato.
function currentUser(?string $set = null): ?array
{
    static $user = false;
    if ($set !== null) {
        $user = findUser($set, true);
    } elseif ($user === false) {
        $auth = authToken();
        $user = $auth === null ? null : findUser($auth['user']);
    }
    return $user;
}

// Lo spazio di cui si leggono e scrivono i dati: quello dell'utente collegato, oppure quello che
// chi gestisce il sito sta guardando in sola lettura.
function spaceId(): int
{
    $viewing = viewingSpace();
    return $viewing === null ? ownSpaceId() : (int) $viewing['id'];
}

// Lo spazio dell'utente collegato.
function ownSpaceId(): int
{
    $user = currentUser();
    if ($user === null) {
        throw authRequired();
    }
    return (int) $user['space_id'];
}

// Lo spazio che chi gestisce il sito sta guardando in sola lettura: { id, name }, oppure null.
function viewingSpace(): ?array
{
    $user = currentUser();
    if ($user === null || $user['viewing_space_id'] === null || $user['viewing_name'] === null || !isAdmin()) {
        return null;
    }
    return ['id' => (string) $user['viewing_space_id'], 'name' => $user['viewing_name']];
}

function isAdmin(): bool
{
    $user = currentUser();
    $admins = config()['admins'] ?? [];
    return $user !== null && is_array($admins) && in_array($user['name'], $admins, true);
}

// Quello che il browser deve sapere di chi è collegato.
function meData(): array
{
    $user = currentUser();
    return [
        'user' => $user['name'],
        'email' => $user['email'],
        'space' => $user['space_name'],
        'admin' => isAdmin(),
        'viewing' => viewingSpace(),
        'weekStartDay' => weekStartDay(),
    ];
}

// Entra come $name: cookie firmato e utente di questa richiesta. Non se lo spazio è sospeso.
function signIn(string $name, bool $remember): array
{
    $user = currentUser($name); // rilegge l'utente: il cookie va firmato con la sua password di adesso
    if ($user['suspended_at'] !== null) {
        throw new HttpError(403, suspendedMessage());
    }
    setAuthCookie($name, $remember);
    touchUser($name);
    return meData();
}

// ---------------------------------------------------------------------------
// Utenti dello spazio
// ---------------------------------------------------------------------------

// null se vuota; altrimenti un indirizzo valido.
function validEmail($value): ?string
{
    $email = is_string($value) ? strtolower(trim($value)) : '';
    if ($email === '') {
        return null;
    }
    if (strlen($email) > MAX_EMAIL || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
        throw new HttpError(400, 'Indirizzo email non valido');
    }
    return $email;
}

// Crea l'utente nello spazio indicato.
function insertUser(string $name, string $password, int $spaceId, ?string $email = null): void
{
    $t = tables();
    try {
        db()->prepare(
            "INSERT INTO {$t['users']} (name, password_hash, space_id, email, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())"
        )->execute([$name, password_hash($password, PASSWORD_DEFAULT), $spaceId, $email]);
    } catch (PDOException $e) {
        if (!isDuplicateKey($e)) {
            throw $e;
        }
        throw new HttpError(409, $email !== null && findUser($name, true) === null
            ? 'Questa email è già usata da un altro utente'
            : "Esiste già un utente chiamato «{$name}»: scegli un altro nome");
    }
    findUser($name, true); // prima risultava inesistente: la firma del cookie usa la password nuova
}

function setPassword(string $name, string $password): void
{
    $t = tables();
    db()->prepare("UPDATE {$t['users']} SET password_hash = ? WHERE name = ?")
        ->execute([password_hash($password, PASSWORD_DEFAULT), $name]);
    db()->prepare("DELETE FROM {$t['password_resets']} WHERE user_name = ?")->execute([$name]);
    findUser($name, true);
}

function listUsers(): array
{
    $t = tables();
    $me = currentUser()['name'];
    $stmt = db()->prepare("SELECT name, created_at FROM {$t['users']} WHERE space_id = ? ORDER BY name");
    $stmt->execute([spaceId()]);
    return array_map(function (array $row) use ($me) {
        return ['name' => (string) $row['name'], 'createdAt' => isoDateTime($row['created_at']), 'me' => (string) $row['name'] === $me];
    }, $stmt->fetchAll());
}

// Aggiunge una persona al proprio spazio: vedrà e modificherà gli stessi dati.
function createUser(array $input): array
{
    insertUser(validUsername($input['username'] ?? null), validPassword($input['password'] ?? null, $input['repeat'] ?? null), ownSpaceId());
    return listUsers();
}

// Cambia la password dell'utente collegato, che resta collegato su questo dispositivo
// (sugli altri deve rifare l'accesso, perché la firma del cookie include l'hash).
function changePassword(array $input): array
{
    $user = currentUser();
    $current = is_string($input['current'] ?? null) ? $input['current'] : '';
    if (!password_verify($current, $user['password_hash'])) {
        throw new HttpError(400, 'La password attuale non è corretta');
    }
    setPassword($user['name'], validPassword($input['password'] ?? null, $input['repeat'] ?? null));
    setAuthCookie($user['name'], authToken()['remember'] ?? false);
    return ['ok' => true];
}

// Un altro membro dello spazio che ha dimenticato la password: gliene sceglie una nuova chi c'è.
function resetMemberPassword(array $input): array
{
    $name = memberName($input['username'] ?? null);
    if ($name === currentUser()['name']) {
        // La propria si cambia sapendo quella attuale (changePassword).
        throw new HttpError(400, 'Per la tua password usa «Cambia la tua password»');
    }
    setPassword($name, validPassword($input['password'] ?? null, $input['repeat'] ?? null));
    return ['ok' => true];
}

// Nome di un utente dello stesso spazio (404 per quelli degli altri spazi).
function memberName($value): string
{
    $user = is_string($value) ? findUser($value) : null;
    if ($user === null || (int) $user['space_id'] !== ownSpaceId()) {
        throw new HttpError(404, 'Utente non trovato');
    }
    return $user['name'];
}

// Toglie una persona dallo spazio. L'ultima no: per andarsene si elimina lo spazio.
function deleteUser(array $input): array
{
    $t = tables();
    $name = memberName($input['username'] ?? null);
    if (count(listUsers()) <= 1) {
        throw new HttpError(400, "Sei l'unico utente: per andartene elimina lo spazio, in fondo alla pagina");
    }
    db()->prepare("DELETE FROM {$t['users']} WHERE name = ?")->execute([$name]);
    return listUsers();
}

// La propria email, per ricevere il link se si dimentica la password (vuota = nessuna).
function updateAccount(array $input): array
{
    $t = tables();
    $email = validEmail($input['email'] ?? null);
    try {
        db()->prepare("UPDATE {$t['users']} SET email = ? WHERE name = ?")->execute([$email, currentUser()['name']]);
    } catch (PDOException $e) {
        if (!isDuplicateKey($e)) {
            throw $e;
        }
        throw new HttpError(409, 'Questa email è già usata da un altro utente');
    }
    currentUser(currentUser()['name']);
    return meData();
}

function validSpaceName($value, string $fallback): string
{
    $name = cleanLine($value, 80);
    return $name !== '' ? $name : $fallback;
}

function renameSpace(array $input): array
{
    $t = tables();
    $name = cleanLine($input['name'] ?? null, 80);
    if ($name === '') {
        throw new HttpError(400, 'Scrivi il nome dello spazio');
    }
    db()->prepare("UPDATE {$t['spaces']} SET name = ? WHERE id = ?")->execute([$name, ownSpaceId()]);
    currentUser(currentUser()['name']);
    return meData();
}

// Elimina lo spazio con tutti i suoi dati e i suoi utenti (a cascata). Chiede la password.
function deleteSpace(array $input): array
{
    $t = tables();
    $user = currentUser();
    $password = is_string($input['password'] ?? null) ? $input['password'] : '';
    if (!password_verify($password, $user['password_hash'])) {
        throw new HttpError(400, 'La password non è corretta');
    }
    db()->prepare("DELETE FROM {$t['spaces']} WHERE id = ?")->execute([ownSpaceId()]);
    sendAuthCookie('', time() - 3600);
    return ['ok' => true];
}

// ---------------------------------------------------------------------------
// Iscrizione e recupero della password (senza accesso)
// ---------------------------------------------------------------------------

// Quante volte l'indirizzo $ip ha fatto $kind negli ultimi $minutes minuti (null = tutti gli indirizzi).
function countAttempts(?string $ip, string $kind, int $minutes): int
{
    $t = tables();
    $stmt = db()->prepare(
        "SELECT COUNT(*) FROM {$t['login_attempts']}
         WHERE kind = ? AND attempted_at > UTC_TIMESTAMP() - INTERVAL $minutes MINUTE" . ($ip === null ? '' : ' AND ip = ?')
    );
    $stmt->execute($ip === null ? [$kind] : [$kind, $ip]);
    return (int) $stmt->fetchColumn();
}

function recordAttempt(string $ip, string $kind): void
{
    $t = tables();
    db()->prepare("INSERT INTO {$t['login_attempts']} (ip, kind, attempted_at) VALUES (?, ?, UTC_TIMESTAMP())")->execute([$ip, $kind]);
    db()->exec("DELETE FROM {$t['login_attempts']} WHERE attempted_at < UTC_TIMESTAMP() - INTERVAL 1 DAY");
}

function createSpace(string $name): int
{
    $t = tables();
    db()->prepare("INSERT INTO {$t['spaces']} (name, created_at) VALUES (?, UTC_TIMESTAMP())")->execute([$name]);
    return (int) db()->lastInsertId();
}

// Nuovo spazio con il suo primo utente, già collegato.
// { space, username, password, repeat, email, accept, website: campo nascosto che i bot riempiono }
function signup(array $input): array
{
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if (!empty($input['website'])) {
        throw new HttpError(400, 'Iscrizione non riuscita');
    }
    // Il limite per indirizzo si può alzare in config.php ('signups_per_hour'), es. per i test.
    $perHour = (int) (config()['signups_per_hour'] ?? SIGNUPS_PER_HOUR);
    if (countAttempts($ip, 'signup', 60) >= $perHour || countAttempts(null, 'signup', 1440) >= SIGNUPS_PER_DAY) {
        throw new HttpError(429, 'Troppe iscrizioni in poco tempo: riprova più tardi');
    }
    $name = validUsername($input['username'] ?? null);
    $password = validPassword($input['password'] ?? null, $input['repeat'] ?? null);
    $email = validEmail($input['email'] ?? null);
    if (empty($input['accept'])) {
        throw new HttpError(400, "Per iscriverti devi accettare l'informativa sulla privacy");
    }
    if (findUser($name, true) !== null) {
        throw new HttpError(409, "Esiste già un utente chiamato «{$name}»: scegli un altro nome");
    }
    transaction(function () use ($input, $name, $password, $email) {
        $spaceId = createSpace(validSpaceName($input['space'] ?? null, "Spazio di $name"));
        insertUser($name, $password, $spaceId, $email);
    });
    recordAttempt($ip, 'signup');
    return signIn($name, !empty($input['remember']));
}

// Indirizzo del sito, per i link nelle email (la cartella in cui sta api.php).
function siteUrl(): string
{
    $host = preg_replace('/[^A-Za-z0-9.:-]/', '', (string) ($_SERVER['HTTP_HOST'] ?? ''));
    return 'https://' . $host . cookiePath();
}

// Email di testo semplice, dal mittente di config.php. false se non partita (o non configurata).
function sendMail(string $to, string $subject, string $body): bool
{
    $from = config()['mail_from'] ?? '';
    if (!is_string($from) || filter_var($from, FILTER_VALIDATE_EMAIL) === false) {
        error_log("Email non inviata a $to: manca 'mail_from' in config.php");
        return false;
    }
    $headers = implode("\r\n", [
        'From: Menù della settimana <' . $from . '>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
    ]);
    $sent = mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $body, $headers, '-f' . $from);
    if (!$sent) {
        error_log("Email non inviata a $to");
    }
    return $sent;
}

// Manda il link per una nuova password a chi ha un'email. Risponde sempre allo stesso modo,
// così non si scopre quali utenti o email esistono. { login: nome utente o email }
function forgotPassword(array $input): array
{
    $t = tables();
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if (countAttempts($ip, 'reset', 60) >= RESETS_PER_HOUR) {
        throw new HttpError(429, 'Troppe richieste: riprova tra un po\'');
    }
    recordAttempt($ip, 'reset');
    $login = strtolower(cleanLine($input['login'] ?? null, MAX_EMAIL));
    $stmt = db()->prepare("SELECT name, email FROM {$t['users']} WHERE (name = ? OR email = ?) AND email IS NOT NULL LIMIT 1");
    $stmt->execute([$login, $login]);
    $user = $login === '' ? false : $stmt->fetch();
    if ($user) {
        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        db()->prepare("DELETE FROM {$t['password_resets']} WHERE user_name = ?")->execute([$user['name']]);
        db()->prepare("INSERT INTO {$t['password_resets']} (token_hash, user_name, created_at) VALUES (?, ?, UTC_TIMESTAMP())")
            ->execute([hash('sha256', $token), $user['name']]);
        sendMail($user['email'], 'Nuova password per il Menù della settimana', implode("\n", [
            "Ciao {$user['name']},",
            '',
            'per scegliere una nuova password apri questo link (vale ' . RESET_MINUTES . ' minuti e una volta sola):',
            siteUrl() . '#/reimposta/' . $token,
            '',
            'Se non sei stato tu a chiederlo, ignora questa email: la password resta quella di prima.',
        ]));
    }
    return ['ok' => true];
}

// Nuova password dal link ricevuto via email; poi si è già collegati. { token, password, repeat }
function resetPassword(array $input): array
{
    $t = tables();
    $token = is_string($input['token'] ?? null) ? $input['token'] : '';
    $stmt = db()->prepare(
        "SELECT user_name FROM {$t['password_resets']}
         WHERE token_hash = ? AND created_at > UTC_TIMESTAMP() - INTERVAL " . RESET_MINUTES . ' MINUTE'
    );
    $stmt->execute([hash('sha256', $token)]);
    $name = $stmt->fetchColumn();
    if ($name === false) {
        throw new HttpError(400, 'Il link non è valido o è scaduto: chiedine uno nuovo');
    }
    setPassword((string) $name, validPassword($input['password'] ?? null, $input['repeat'] ?? null));
    return signIn((string) $name, false);
}

// ---------------------------------------------------------------------------
// Chi gestisce il sito (utenti in 'admins' di config.php)
// ---------------------------------------------------------------------------
// Vede tutti gli spazi con i loro utenti e i numeri, li crea, li rinomina, li sospende, li
// elimina, gestisce i loro utenti, e può aprirne uno in sola lettura (viewingSpace()) per
// aiutare chi ha un problema: intanto ogni modifica viene rifiutata (vedi api.php).

function requireAdmin(): void
{
    if (!isAdmin()) {
        throw new HttpError(403, 'Pagina riservata a chi gestisce il sito');
    }
}

function suspendedMessage(): string
{
    $contact = config()['contact'] ?? '';
    return 'Questo spazio è sospeso' . (is_string($contact) && $contact !== '' ? ": per informazioni scrivi a $contact" : '');
}

// Segna l'ultimo accesso (al più una volta l'ora, per non scrivere a ogni pagina).
function touchUser(string $name): void
{
    $t = tables();
    db()->prepare(
        "UPDATE {$t['users']} SET last_seen_at = UTC_TIMESTAMP()
         WHERE name = ? AND (last_seen_at IS NULL OR last_seen_at < UTC_TIMESTAMP() - INTERVAL 1 HOUR)"
    )->execute([$name]);
}

// Riepilogo del sito e tutti gli spazi, dal più recente.
function adminOverview(): array
{
    requireAdmin();
    $t = tables();
    $pdo = db();
    $count = function (string $sql) use ($pdo): int {
        return (int) $pdo->query($sql)->fetchColumn();
    };
    $stats = [
        'spaces' => $count("SELECT COUNT(*) FROM {$t['spaces']}"),
        'users' => $count("SELECT COUNT(*) FROM {$t['users']}"),
        'new7' => $count("SELECT COUNT(*) FROM {$t['spaces']} WHERE created_at > UTC_TIMESTAMP() - INTERVAL 7 DAY"),
        'new30' => $count("SELECT COUNT(*) FROM {$t['spaces']} WHERE created_at > UTC_TIMESTAMP() - INTERVAL 30 DAY"),
        'active7' => $count(
            "SELECT COUNT(DISTINCT space_id) FROM {$t['users']} WHERE last_seen_at > UTC_TIMESTAMP() - INTERVAL 7 DAY"
        ),
        'suspended' => $count("SELECT COUNT(*) FROM {$t['spaces']} WHERE suspended_at IS NOT NULL"),
    ];
    $rows = $pdo->query(
        "SELECT s.id, s.name, s.created_at, s.suspended_at,
                (SELECT GROUP_CONCAT(u.name ORDER BY u.name SEPARATOR ', ') FROM {$t['users']} u WHERE u.space_id = s.id) AS users,
                (SELECT GROUP_CONCAT(u.email ORDER BY u.name SEPARATOR ', ') FROM {$t['users']} u WHERE u.space_id = s.id) AS emails,
                (SELECT MAX(u.last_seen_at) FROM {$t['users']} u WHERE u.space_id = s.id) AS last_seen,
                (SELECT COUNT(*) FROM {$t['dishes']} d WHERE d.space_id = s.id) AS dishes,
                (SELECT COUNT(*) FROM {$t['weeks']} w WHERE w.space_id = s.id) AS weeks,
                (SELECT COUNT(*) FROM {$t['receipts']} r WHERE r.space_id = s.id) AS receipts
         FROM {$t['spaces']} s
         ORDER BY s.created_at DESC, s.id DESC"
    )->fetchAll();
    $mine = ownSpaceId();
    $spaces = array_map(function (array $row) use ($mine) {
        return [
            'id' => (string) $row['id'],
            'name' => $row['name'],
            'createdAt' => isoDateTime($row['created_at']),
            'suspended' => $row['suspended_at'] !== null,
            'users' => (string) $row['users'],
            'emails' => (string) $row['emails'],
            'lastSeen' => isoDateTime($row['last_seen']),
            'dishes' => (int) $row['dishes'],
            'weeks' => (int) $row['weeks'],
            'receipts' => (int) $row['receipts'],
            'mine' => (int) $row['id'] === $mine,
        ];
    }, $rows);
    return ['stats' => $stats, 'spaces' => $spaces];
}

// Uno spazio con i suoi utenti e quanto lo usano.
function adminSpace(int $id): array
{
    requireAdmin();
    $t = tables();
    $stmt = db()->prepare("SELECT id, name, created_at, suspended_at FROM {$t['spaces']} WHERE id = ?");
    $stmt->execute([$id]);
    $space = $stmt->fetch();
    if (!$space) {
        throw new HttpError(404, 'Spazio non trovato');
    }
    $stmt = db()->prepare("SELECT name, email, created_at, last_seen_at FROM {$t['users']} WHERE space_id = ? ORDER BY name");
    $stmt->execute([$id]);
    $users = array_map(function (array $row) {
        return [
            'name' => $row['name'],
            'email' => $row['email'],
            'createdAt' => isoDateTime($row['created_at']),
            'lastSeen' => isoDateTime($row['last_seen_at']),
            'me' => $row['name'] === currentUser()['name'],
        ];
    }, $stmt->fetchAll());
    $counts = [];
    $queries = [
        'dishes' => "SELECT COUNT(*) FROM {$t['dishes']} WHERE space_id = ?",
        'recipes' => "SELECT COUNT(DISTINCT di.dish_id) FROM {$t['dish_ingredients']} di
                      JOIN {$t['dishes']} d ON d.id = di.dish_id WHERE d.space_id = ?",
        'ingredients' => "SELECT COUNT(*) FROM {$t['ingredients']} WHERE space_id = ?",
        'products' => "SELECT COUNT(*) FROM {$t['products']} WHERE space_id = ?",
        'receipts' => "SELECT COUNT(*) FROM {$t['receipts']} WHERE space_id = ?",
        'weeks' => "SELECT COUNT(*) FROM {$t['weeks']} WHERE space_id = ?",
    ];
    foreach ($queries as $key => $sql) {
        $stmt = db()->prepare($sql);
        $stmt->execute([$id]);
        $counts[$key] = (int) $stmt->fetchColumn();
    }
    $stmt = db()->prepare("SELECT MAX(updated_at) FROM {$t['weeks']} WHERE space_id = ?");
    $stmt->execute([$id]);
    return [
        'id' => (string) $space['id'],
        'name' => $space['name'],
        'createdAt' => isoDateTime($space['created_at']),
        'suspended' => $space['suspended_at'] !== null,
        'mine' => (int) $space['id'] === ownSpaceId(),
        'lastWeek' => isoDateTime($stmt->fetchColumn() ?: null),
        'users' => $users,
        'counts' => $counts,
    ];
}

// Id di uno spazio esistente dal corpo della richiesta (404 se non c'è).
function adminSpaceId(array $input): int
{
    $id = idFromInput($input['id'] ?? null);
    if ($id === null) {
        throw new HttpError(404, 'Spazio non trovato');
    }
    adminSpace($id);
    return $id;
}

// Nuovo spazio con il suo primo utente (la password la comunica chi lo crea).
// { name, username, password, repeat, email }
function adminCreateSpace(array $input): array
{
    requireAdmin();
    $name = validUsername($input['username'] ?? null);
    $password = validPassword($input['password'] ?? null, $input['repeat'] ?? null);
    $email = validEmail($input['email'] ?? null);
    if (findUser($name, true) !== null) {
        throw new HttpError(409, "Esiste già un utente chiamato «{$name}»: scegli un altro nome");
    }
    $id = 0;
    transaction(function () use ($input, $name, $password, $email, &$id) {
        $id = createSpace(validSpaceName($input['name'] ?? null, "Spazio di $name"));
        insertUser($name, $password, $id, $email);
    });
    return adminSpace($id);
}

function adminRenameSpace(array $input): array
{
    $id = adminSpaceId($input);
    $name = cleanLine($input['name'] ?? null, 80);
    if ($name === '') {
        throw new HttpError(400, 'Scrivi il nome dello spazio');
    }
    $t = tables();
    db()->prepare("UPDATE {$t['spaces']} SET name = ? WHERE id = ?")->execute([$name, $id]);
    return adminSpace($id);
}

// Sospende (nessuno dello spazio può più entrare, i dati restano) o riattiva. { id, suspended }
function adminSuspendSpace(array $input): array
{
    $id = adminSpaceId($input);
    if ($id === ownSpaceId()) {
        throw new HttpError(400, 'Non puoi sospendere il tuo spazio');
    }
    $t = tables();
    db()->prepare("UPDATE {$t['spaces']} SET suspended_at = " . (empty($input['suspended']) ? 'NULL' : 'UTC_TIMESTAMP()') . ' WHERE id = ?')
        ->execute([$id]);
    return adminSpace($id);
}

function adminDeleteSpace(array $input): array
{
    $id = adminSpaceId($input);
    if ($id === ownSpaceId()) {
        throw new HttpError(400, 'Il tuo spazio si elimina dalla pagina dello spazio');
    }
    $t = tables();
    db()->prepare("UPDATE {$t['users']} SET viewing_space_id = NULL WHERE viewing_space_id = ?")->execute([$id]);
    db()->prepare("DELETE FROM {$t['spaces']} WHERE id = ?")->execute([$id]);
    return adminOverview();
}

// Un utente di qualunque spazio (404 se non esiste).
function adminUserName($value): string
{
    $user = is_string($value) ? findUser($value, true) : null;
    if ($user === null) {
        throw new HttpError(404, 'Utente non trovato');
    }
    return $user['name'];
}

// Aggiunge un utente a uno spazio. { id: spazio, username, password, repeat, email }
function adminCreateUser(array $input): array
{
    $id = adminSpaceId($input);
    insertUser(
        validUsername($input['username'] ?? null),
        validPassword($input['password'] ?? null, $input['repeat'] ?? null),
        $id,
        validEmail($input['email'] ?? null)
    );
    return adminSpace($id);
}

// Nuova password per un utente di qualunque spazio (la propria si cambia sapendo quella attuale).
function adminResetUser(array $input): array
{
    requireAdmin();
    $name = adminUserName($input['username'] ?? null);
    if ($name === currentUser()['name']) {
        throw new HttpError(400, 'Per la tua password usa la pagina del tuo spazio');
    }
    setPassword($name, validPassword($input['password'] ?? null, $input['repeat'] ?? null));
    return adminSpace((int) findUser($name)['space_id']);
}

// Toglie un utente; non sé stessi e non l'ultimo di uno spazio (si elimina lo spazio).
function adminDeleteUser(array $input): array
{
    requireAdmin();
    $t = tables();
    $name = adminUserName($input['username'] ?? null);
    $spaceId = (int) findUser($name)['space_id'];
    if ($name === currentUser()['name']) {
        throw new HttpError(400, 'Non puoi togliere te stesso da qui');
    }
    $stmt = db()->prepare("SELECT COUNT(*) FROM {$t['users']} WHERE space_id = ?");
    $stmt->execute([$spaceId]);
    if ((int) $stmt->fetchColumn() <= 1) {
        throw new HttpError(400, "È l'ultimo utente dello spazio: per toglierlo elimina lo spazio");
    }
    db()->prepare("DELETE FROM {$t['users']} WHERE name = ?")->execute([$name]);
    return adminSpace($spaceId);
}

// Apre uno spazio in sola lettura: da qui le pagine mostrano i suoi dati. Il proprio = torna al proprio.
function adminViewSpace(array $input): array
{
    $id = adminSpaceId($input);
    $t = tables();
    db()->prepare("UPDATE {$t['users']} SET viewing_space_id = ? WHERE name = ?")
        ->execute([$id === ownSpaceId() ? null : $id, currentUser()['name']]);
    currentUser(currentUser()['name']);
    return meData();
}

// Torna al proprio spazio.
function stopViewing(): array
{
    $t = tables();
    db()->prepare("UPDATE {$t['users']} SET viewing_space_id = NULL WHERE name = ?")->execute([currentUser()['name']]);
    currentUser(currentUser()['name']);
    return meData();
}

// ---------------------------------------------------------------------------
// Passaggio agli spazi dei dati delle versioni di prima
// ---------------------------------------------------------------------------

// Tutto quello che c'era (piatti, settimane, scontrini, utenti...) diventa lo spazio 1.
// Ogni passo controlla se è già stato fatto, così si può riprendere se si interrompe;
// la colonna space_id degli utenti, aggiunta per ultima, dice che è tutto fatto.
function migrateToSpaces(): void
{
    $t = tables();
    $pdo = db();
    $hasColumn = function (string $table, string $column) use ($pdo): bool {
        return (bool) $pdo->query("SHOW COLUMNS FROM $table LIKE '$column'")->fetchAll();
    };
    if ($hasColumn($t['users'], 'space_id')) {
        return;
    }
    $pdo->exec("INSERT IGNORE INTO {$t['spaces']} (id, name, created_at) VALUES (1, 'Il mio spazio', UTC_TIMESTAMP())");

    // Colonne di quanto si possono vedere, in quale indice univoco o chiave primaria entrano.
    $owned = [
        'dishes' => ['UNIQUE KEY uq_name', '(space_id, name)'],
        'ingredients' => ['UNIQUE KEY uq_name', '(space_id, name)'],
        'products' => ['UNIQUE KEY uq_name', '(space_id, name)'],
        'product_aliases' => ['UNIQUE KEY uq_alias', '(space_id, alias_hash)'],
        'shopping_terms' => ['PRIMARY KEY', '(space_id, term)'],
        'settings' => ['PRIMARY KEY', '(space_id, name)'],
        'weeks' => ['PRIMARY KEY', '(space_id, week_start)'],
        'receipts' => [null, null],
        'meals' => [null, null],
        'shopping' => [null, null],
    ];
    foreach (array_keys($owned) as $name) {
        if (!$hasColumn($t[$name], 'space_id')) {
            $pdo->exec("ALTER TABLE {$t[$name]} ADD COLUMN space_id INT UNSIGNED NOT NULL DEFAULT 1 FIRST");
        }
    }

    // Pasti e lista della spesa puntano alla settimana: le chiavi esterne vanno rifatte con lo spazio.
    foreach (['meals', 'shopping'] as $child) {
        foreach (foreignKeys($child, 'weeks') as $fk) {
            $pdo->exec("ALTER TABLE {$t[$child]} DROP FOREIGN KEY `$fk`");
        }
    }
    foreach ($owned as $name => [$key, $columns]) {
        if ($key === null || indexColumns($name, $key === 'PRIMARY KEY' ? 'PRIMARY' : substr($key, 11)) === trim($columns, '()')) {
            continue;
        }
        $drop = $key === 'PRIMARY KEY' ? 'DROP PRIMARY KEY' : 'DROP INDEX ' . substr($key, 11);
        $pdo->exec("ALTER TABLE {$t[$name]} $drop, ADD $key $columns");
    }
    $weekKeys = ['meals' => '(space_id, week_start, day, meal, position)', 'shopping' => '(space_id, week_start, position)'];
    foreach ($weekKeys as $child => $columns) {
        if (!foreignKeys($child, 'weeks')) {
            $pdo->exec(
                "ALTER TABLE {$t[$child]} ADD KEY idx_space_week $columns,
                 ADD FOREIGN KEY (space_id, week_start) REFERENCES {$t['weeks']} (space_id, week_start) ON DELETE CASCADE"
            );
        }
    }
    foreach (['dishes', 'ingredients', 'products', 'product_aliases', 'shopping_terms', 'settings', 'weeks', 'receipts'] as $name) {
        if (!foreignKeys($name, 'spaces')) {
            $pdo->exec("ALTER TABLE {$t[$name]} ADD FOREIGN KEY (space_id) REFERENCES {$t['spaces']} (id) ON DELETE CASCADE");
        }
    }
    foreach (array_keys($owned) as $name) {
        $pdo->exec("ALTER TABLE {$t[$name]} ALTER COLUMN space_id DROP DEFAULT");
    }

    if (!$hasColumn($t['login_attempts'], 'kind')) {
        $pdo->exec("ALTER TABLE {$t['login_attempts']} ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'login' AFTER ip");
    }
    // Per ultimi gli utenti: da qui in poi la migrazione risulta fatta.
    $pdo->exec(
        "ALTER TABLE {$t['users']}
         ADD COLUMN space_id INT UNSIGNED NOT NULL DEFAULT 1 AFTER password_hash,
         ADD COLUMN email VARCHAR(" . MAX_EMAIL . ") NULL AFTER space_id,
         ADD UNIQUE KEY uq_email (email),
         ADD FOREIGN KEY (space_id) REFERENCES {$t['spaces']} (id) ON DELETE CASCADE"
    );
    $pdo->exec("ALTER TABLE {$t['users']} ALTER COLUMN space_id DROP DEFAULT");
}

// Nome della tabella nel database, senza le virgolette che tables() aggiunge.
function rawTable(string $name): string
{
    return trim(tables()[$name], '`');
}

// Nomi delle chiavi esterne di $table verso $referenced.
function foreignKeys(string $table, string $referenced): array
{
    $stmt = db()->prepare(
        'SELECT DISTINCT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME = ?'
    );
    $stmt->execute([rawTable($table), rawTable($referenced)]);
    return $stmt->fetchAll(PDO::FETCH_COLUMN);
}

// Colonne di un indice, separate da ", " ('' se non c'è).
function indexColumns(string $table, string $index): string
{
    $stmt = db()->prepare(
        'SELECT COLUMN_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX'
    );
    $stmt->execute([rawTable($table), $index]);
    return implode(', ', $stmt->fetchAll(PDO::FETCH_COLUMN));
}
