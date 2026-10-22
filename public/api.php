<?php
/*
 * API del Menù della settimana, con i dati su database MySQL / MariaDB.
 * Le credenziali stanno in config.php (modello: config.example.php); le tabelle
 * vengono create da sole al primo utilizzo. Si usano solo GET e POST
 * (alcuni hosting condivisi bloccano PUT e DELETE).
 *
 * Serve l'accesso: gli utenti stanno nel database (il primo si crea con setup.php, gli altri
 * dalla pagina Utenti) e, dopo il login, il browser tiene un cookie firmato con il 'secret'
 * di config.php. setup.php include questo file per usarne le funzioni.
 *
 *   POST api.php?action=login                      accesso              { username, password, remember }
 *   POST api.php?action=logout                     uscita
 *   GET  api.php?action=me                         utente collegato (401 se nessuno) e giorno di inizio settimana
 *   GET  api.php?action=users                      utenti
 *   POST api.php?action=user-create                aggiunge un utente   { username, password, repeat }
 *   POST api.php?action=user-password              cambia la propria password { current, password, repeat }
 *   POST api.php?action=user-delete                elimina un utente (non l'ultimo) { username }
 *   POST api.php?action=settings-save              giorno di inizio settimana { weekStartDay: 0 = lunedì ... 6 = domenica }
 *
 *   GET  api.php?action=dishes                     elenco piatti (con statistiche d'uso)
 *   POST api.php?action=dish-create                crea un piatto       { name, category, notes }
 *   POST api.php?action=dish-update&id=ID          modifica un piatto   { name, category, notes }
 *   POST api.php?action=dish-delete&id=ID          elimina un piatto
 *   GET  api.php?action=weeks                      tutte le settimane salvate, dalla più recente
 *   GET  api.php?action=week&week=AAAA-MM-GG       la settimana che contiene quel giorno (chiave = suo primo giorno)
 *   POST api.php?action=week-save&week=AAAA-MM-GG  salva una settimana (indicata con il primo giorno) { meals, notes, shopping }
 *   POST api.php?action=shopping-term              ricorda il reparto di una voce della spesa { term, category }
 *
 * Spesa e costi (codice in lib/groceries.php):
 *   GET  api.php?action=ingredients                ingredienti con l'ultimo prezzo
 *   POST api.php?action=ingredient-create          { name, unit, negligible }
 *   POST api.php?action=ingredient-update&id=ID    { name, unit, negligible }
 *   POST api.php?action=ingredient-delete&id=ID
 *   POST api.php?action=dish-recipe&id=ID          ricetta di un piatto { servings, lines }
 *   GET  api.php?action=products                   articoli comprati con l'ultimo acquisto
 *   GET  api.php?action=product&id=ID              un articolo con lo storico dei prezzi
 *   POST api.php?action=product-update&id=ID       { name, brand, category, ingredient, packageSize, packageUnit }
 *   POST api.php?action=product-merge&id=ID        riunisce l'articolo in un altro { into }
 *   POST api.php?action=product-delete&id=ID       elimina l'articolo (le righe restano, scollegate)
 *   GET  api.php?action=receipts                   scontrini importati
 *   GET  api.php?action=receipt&id=ID              uno scontrino con le righe
 *   POST api.php?action=receipt-preview            anteprima di un JSON dell'AI { receipt }
 *   POST api.php?action=receipt-save              salva lo scontrino { receipt, choices }
 *   POST api.php?action=receipt-relink&id=ID       cambia gli abbinamenti delle righe { lines }
 *   POST api.php?action=receipt-delete&id=ID
 *
 * Compatibile con PHP 7.4 e successivi; serve l'estensione pdo_mysql.
 */

declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
// Avvisi ed errori diventano eccezioni (risposta 500 in JSON invece di HTML nel mezzo
// della risposta); le deprecazioni delle versioni future di PHP vengono ignorate.
set_error_handler(function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity) || ($severity & (E_DEPRECATED | E_USER_DEPRECATED))) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
const MEALS = ['lunch', 'dinner'];
// Reparti della lista della spesa (nomi, ordine e parole in shopping.js).
const SHOPPING_CATEGORIES = [
    'frutta', 'verdura', 'pane', 'carne', 'pesce', 'salumi', 'latticini', 'dispensa',
    'colazione', 'surgelati', 'bevande', 'casa', 'igiene', 'animali', 'altro',
];
const CATEGORIES = ['primo', 'secondo', 'unico', 'contorno', 'altro'];
const MAX_BODY = 1000000;

const AUTH_COOKIE = 'wfp_auth';
const LOGIN_MAX_FAILURES = 10;   // tentativi sbagliati ammessi per indirizzo IP...
const LOGIN_WINDOW_MINUTES = 15; // ...in questo intervallo
// Hash di una password casuale: si verifica anche per i nomi utente inesistenti,
// così i tempi di risposta non rivelano quali utenti esistono.
const DUMMY_HASH = '$2y$12$.XMGCjQcb0obzOpH8bfjL.P7FLxafdciefusSA5eXzzYfCyWIyIFm';
const USERNAME_PATTERN = '/^[a-z0-9._-]{1,40}$/';
const MIN_PASSWORD = 8;

class HttpError extends Exception
{
    public $status;
    public $extra; // altri campi della risposta JSON, oltre a 'error'

    public function __construct(int $status, string $message, array $extra = [])
    {
        parent::__construct($message);
        $this->status = $status;
        $this->extra = $extra;
    }
}

require __DIR__ . '/lib/groceries.php';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function config(): array
{
    static $config = null;
    if ($config === null) {
        $file = __DIR__ . '/config.php';
        if (!is_file($file)) {
            throw new HttpError(500, 'Manca config.php: copia config.example.php in config.php e inserisci i dati del database');
        }
        $config = require $file;
    }
    return $config;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    if (!extension_loaded('pdo_mysql')) {
        throw new HttpError(500, "L'estensione PHP pdo_mysql non è attiva");
    }
    $c = config()['db'] ?? [];
    if (empty($c['host']) || empty($c['name']) || !isset($c['user'])) {
        throw new HttpError(500, 'Database non configurato: inserisci host, nome, utente e password in config.php');
    }
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $c['host'], (int) ($c['port'] ?? 3306), $c['name']);
    try {
        $pdo = new PDO($dsn, (string) $c['user'], (string) ($c['password'] ?? ''), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    } catch (PDOException $e) {
        error_log('Connessione al database fallita: ' . $e->getMessage());
        throw new HttpError(500, 'Impossibile collegarsi al database: controlla i dati in config.php');
    }
    return $pdo;
}

// Nomi delle tabelle, con il prefisso scelto in config.php.
function tables(): array
{
    static $tables = null;
    if ($tables === null) {
        $prefix = config()['db']['prefix'] ?? 'menu_';
        if (!is_string($prefix) || !preg_match('/^[A-Za-z0-9_]*$/', $prefix)) {
            throw new HttpError(500, 'Il prefisso delle tabelle in config.php può contenere solo lettere, numeri e _');
        }
        $names = [
            'dishes', 'weeks', 'meals', 'shopping', 'shopping_terms', 'login_attempts', 'settings', 'users',
            'ingredients', 'dish_ingredients', 'products', 'product_aliases', 'receipts', 'receipt_items',
        ];
        foreach ($names as $name) {
            $tables[$name] = "`{$prefix}{$name}`";
        }
    }
    return $tables;
}

// Crea le tabelle mancanti e aggiunge le colonne nuove a quelle esistenti.
// La collation utf8mb4_unicode_ci ignora maiuscole e accenti:
// «Caffè» e «caffe» sono lo stesso piatto, e l'indice univoco lo garantisce.
function createSchema(): void
{
    $t = tables();
    $options = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    $statements = [
        "CREATE TABLE IF NOT EXISTS {$t['dishes']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(120) NOT NULL,
            category VARCHAR(20) NOT NULL DEFAULT 'altro',
            notes VARCHAR(300) NOT NULL DEFAULT '',
            servings TINYINT UNSIGNED NOT NULL DEFAULT 4 COMMENT 'porzioni della ricetta',
            created_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_name (name)
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['weeks']} (
            week_start DATE NOT NULL COMMENT 'primo giorno della settimana',
            notes TEXT NOT NULL,
            updated_at DATETIME NOT NULL,
            PRIMARY KEY (week_start)
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['meals']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            week_start DATE NOT NULL,
            day TINYINT UNSIGNED NOT NULL COMMENT '0 = lunedì ... 6 = domenica',
            meal VARCHAR(10) NOT NULL COMMENT 'lunch | dinner',
            position TINYINT UNSIGNED NOT NULL,
            dish_id INT UNSIGNED NULL,
            dish_name VARCHAR(120) NOT NULL COMMENT 'copia del nome: resta anche se il piatto viene eliminato',
            PRIMARY KEY (id),
            KEY idx_week (week_start, day, meal, position),
            KEY idx_dish (dish_id),
            FOREIGN KEY (week_start) REFERENCES {$t['weeks']} (week_start) ON DELETE CASCADE,
            FOREIGN KEY (dish_id) REFERENCES {$t['dishes']} (id) ON DELETE SET NULL
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['shopping']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            week_start DATE NOT NULL,
            position SMALLINT UNSIGNED NOT NULL,
            text VARCHAR(200) NOT NULL,
            category VARCHAR(20) NULL COMMENT 'reparto (frutta, verdura...): vedi SHOPPING_CATEGORIES',
            done TINYINT(1) NOT NULL DEFAULT 0,
            PRIMARY KEY (id),
            KEY idx_week (week_start, position),
            FOREIGN KEY (week_start) REFERENCES {$t['weeks']} (week_start) ON DELETE CASCADE
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['shopping_terms']} (
            term VARCHAR(80) NOT NULL COMMENT 'voce della lista ripulita (minuscolo, senza quantità)',
            category VARCHAR(20) NOT NULL,
            updated_at DATETIME NOT NULL,
            PRIMARY KEY (term)
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['login_attempts']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            ip VARCHAR(45) NOT NULL,
            attempted_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            KEY idx_ip (ip, attempted_at)
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['settings']} (
            name VARCHAR(40) NOT NULL,
            value VARCHAR(200) NOT NULL,
            PRIMARY KEY (name)
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['users']} (
            name VARCHAR(40) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at DATETIME NOT NULL,
            PRIMARY KEY (name)
        ) $options",
    ];
    foreach (array_merge($statements, grocerySchema($t, $options)) as $sql) {
        db()->exec($sql);
    }
    migrateSchema();
}

function transaction(callable $fn): void
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $fn($pdo);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function isDuplicateKey(PDOException $e): bool
{
    return ($e->errorInfo[1] ?? null) === 1062;
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

// Tronca a $max caratteri (non byte), senza dipendere da mbstring.
function cut(string $text, int $max): string
{
    return preg_match('/^.{0,' . $max . '}/us', $text, $m) ? $m[0] : '';
}

function cleanLine($value, int $max): string
{
    if (!is_string($value)) {
        return '';
    }
    return cut(trim((string) preg_replace('/\s+/u', ' ', $value)), $max);
}

function isoDateTime(?string $value): ?string
{
    return $value === null ? null : gmdate('c', (int) strtotime($value . ' UTC'));
}

// Data AAAA-MM-GG valida, altrimenti null.
function parseDateKey($key): ?DateTimeImmutable
{
    if (!is_string($key) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $key)) {
        return null;
    }
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $key, new DateTimeZone('UTC'));
    return $date !== false && $date->format('Y-m-d') === $key ? $date : null;
}

// Giorno della settimana: 0 = lunedì ... 6 = domenica (come la colonna meals.day).
function weekdayOf(DateTimeImmutable $date): int
{
    return (int) $date->format('N') - 1;
}

// Primo giorno della settimana che contiene $date, se le settimane iniziano il giorno $startDay.
function weekStartOf(DateTimeImmutable $date, int $startDay): DateTimeImmutable
{
    $back = (weekdayOf($date) - $startDay + 7) % 7;
    return $date->modify("-$back day");
}

// Data del giorno $day (0 = lunedì ... 6 = domenica) nella settimana che inizia il $weekStart.
function dayDate(string $weekStart, int $day): DateTimeImmutable
{
    $start = parseDateKey($weekStart);
    $offset = ($day - weekdayOf($start) + 7) % 7;
    return $start->modify("+$offset day");
}

// ---------------------------------------------------------------------------
// Accesso
// ---------------------------------------------------------------------------

// Utenti abilitati: [nome => hash della password], dalla tabella degli utenti. Se è vuota
// importa quelli del vecchio users.php, dove li salvavano le versioni precedenti.
function users(bool $reload = false): array
{
    static $users = null;
    if ($users === null || $reload) {
        $t = tables();
        $select = "SELECT name, password_hash FROM {$t['users']} ORDER BY name";
        $users = db()->query($select)->fetchAll(PDO::FETCH_KEY_PAIR);
        if (!$users && importLegacyUsers()) {
            $users = db()->query($select)->fetchAll(PDO::FETCH_KEY_PAIR);
        }
    }
    return $users;
}

function importLegacyUsers(): bool
{
    $file = __DIR__ . '/users.php';
    $legacy = is_file($file) ? require $file : [];
    if (!is_array($legacy) || !$legacy) {
        return false;
    }
    $t = tables();
    $insert = db()->prepare("INSERT IGNORE INTO {$t['users']} (name, password_hash, created_at) VALUES (?, ?, UTC_TIMESTAMP())");
    foreach ($legacy as $name => $hash) {
        if (is_string($hash) && preg_match(USERNAME_PATTERN, (string) $name)) {
            $insert->execute([(string) $name, $hash]);
        }
    }
    return true;
}

function validUsername($value): string
{
    $name = is_string($value) ? strtolower(trim($value)) : '';
    if (!preg_match(USERNAME_PATTERN, $name)) {
        throw new HttpError(400, 'Nome utente non valido: usa lettere minuscole, numeri, punto, trattino o trattino basso (al massimo 40)');
    }
    return $name;
}

// $repeat: la password ripetuta, da confrontare (null = non c'è da confrontare).
function validPassword($value, $repeat = null): string
{
    $password = is_string($value) ? $value : '';
    if (strlen($password) < MIN_PASSWORD) {
        throw new HttpError(400, 'La password deve avere almeno ' . MIN_PASSWORD . ' caratteri');
    }
    if ($repeat !== null && $repeat !== $password) {
        throw new HttpError(400, 'Le due password non coincidono');
    }
    return $password;
}

// Crea l'utente; con $replace, se esiste già gli cambia la password.
function saveUser(string $name, string $password, bool $replace = false): void
{
    $t = tables();
    $hash = password_hash($password, PASSWORD_DEFAULT);
    try {
        db()->prepare(
            "INSERT INTO {$t['users']} (name, password_hash, created_at) VALUES (?, ?, UTC_TIMESTAMP())"
            . ($replace ? ' ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)' : '')
        )->execute([$name, $hash]);
    } catch (PDOException $e) {
        if (!isDuplicateKey($e)) {
            throw $e;
        }
        throw new HttpError(409, "Esiste già un utente chiamato «{$name}»");
    }
    users(true);
}

function listUsers(): array
{
    $t = tables();
    $me = authToken()['user'] ?? null;
    return array_map(function (array $row) use ($me) {
        return ['name' => (string) $row['name'], 'createdAt' => isoDateTime($row['created_at']), 'me' => (string) $row['name'] === $me];
    }, db()->query("SELECT name, created_at FROM {$t['users']} ORDER BY name")->fetchAll());
}

function createUser(array $input): array
{
    saveUser(validUsername($input['username'] ?? null), validPassword($input['password'] ?? null, $input['repeat'] ?? null));
    return listUsers();
}

// Cambia la password dell'utente collegato, che resta collegato su questo dispositivo
// (sugli altri deve rifare l'accesso, perché la firma del cookie include l'hash).
function changePassword(array $input): array
{
    $auth = authToken();
    $current = is_string($input['current'] ?? null) ? $input['current'] : '';
    if (!password_verify($current, users()[$auth['user']])) {
        throw new HttpError(400, 'La password attuale non è corretta');
    }
    saveUser($auth['user'], validPassword($input['password'] ?? null, $input['repeat'] ?? null), true);
    setAuthCookie($auth['user'], $auth['remember']);
    return ['ok' => true];
}

function deleteUser(array $input): array
{
    $t = tables();
    $name = is_string($input['username'] ?? null) ? $input['username'] : '';
    if (count(users()) <= 1) {
        throw new HttpError(400, "Non puoi eliminare l'ultimo utente: nessuno potrebbe più accedere");
    }
    $stmt = db()->prepare("DELETE FROM {$t['users']} WHERE name = ?");
    $stmt->execute([$name]);
    if ($stmt->rowCount() === 0) {
        throw new HttpError(404, 'Utente non trovato');
    }
    users(true);
    return listUsers();
}

// Tentativi di accesso sbagliati dallo stesso indirizzo (login e setup.php): oltre il limite si blocca.
function checkAttempts(string $ip): void
{
    $t = tables();
    $stmt = db()->prepare(
        "SELECT COUNT(*) FROM {$t['login_attempts']}
         WHERE ip = ? AND attempted_at > UTC_TIMESTAMP() - INTERVAL " . LOGIN_WINDOW_MINUTES . ' MINUTE'
    );
    $stmt->execute([$ip]);
    if ((int) $stmt->fetchColumn() >= LOGIN_MAX_FAILURES) {
        throw new HttpError(429, 'Troppi tentativi sbagliati: riprova tra qualche minuto');
    }
}

function recordFailedAttempt(string $ip): void
{
    $t = tables();
    db()->prepare("INSERT INTO {$t['login_attempts']} (ip, attempted_at) VALUES (?, UTC_TIMESTAMP())")->execute([$ip]);
    db()->exec("DELETE FROM {$t['login_attempts']} WHERE attempted_at < UTC_TIMESTAMP() - INTERVAL 1 DAY");
}

function secret(): string
{
    $secret = config()['secret'] ?? '';
    if (!is_string($secret) || strlen($secret) < 32) {
        throw new HttpError(500, "Manca 'secret' in config.php (una stringa casuale di almeno 32 caratteri)");
    }
    return $secret;
}

// Il token vale fino alla scadenza e finché la password non cambia: la firma
// include l'hash della password, quindi cambiandola si scollegano tutti i dispositivi.
function tokenSignature(string $payload, string $user): string
{
    return hash_hmac('sha256', $payload, secret() . users()[$user]);
}

// Utente collegato secondo il cookie: ['user' => ..., 'remember' => bool] oppure null.
function authToken(): ?array
{
    $token = $_COOKIE[AUTH_COOKIE] ?? '';
    if (!is_string($token) || substr_count($token, '.') !== 1) {
        return null;
    }
    [$encoded, $signature] = explode('.', $token);
    $payload = base64_decode(strtr($encoded, '-_', '+/'), true);
    if (!is_string($payload) || substr_count($payload, '|') !== 2) {
        return null;
    }
    [$user, $expires, $remember] = explode('|', $payload);
    if (!isset(users()[$user]) || (int) $expires < time() || !hash_equals(tokenSignature($payload, $user), $signature)) {
        return null;
    }
    return ['user' => $user, 'remember' => $remember === '1'];
}

function cookiePath(): string
{
    return rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/') . '/';
}

function setAuthCookie(string $user, bool $remember): void
{
    // "Resta collegato": 60 giorni; altrimenti fino alla chiusura del browser (max 12 ore).
    $expires = time() + ($remember ? 60 * 86400 : 12 * 3600);
    $payload = $user . '|' . $expires . '|' . ($remember ? '1' : '0');
    $token = rtrim(strtr(base64_encode($payload), '+/', '-_'), '=') . '.' . tokenSignature($payload, $user);
    sendAuthCookie($token, $remember ? $expires : 0);
}

function sendAuthCookie(string $value, int $expires): void
{
    setcookie(AUTH_COOKIE, $value, [
        'expires' => $expires,
        'path' => cookiePath(),
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function login(array $input): array
{
    $t = tables();
    $username = strtolower(cleanLine($input['username'] ?? null, 40));
    $password = is_string($input['password'] ?? null) ? $input['password'] : '';
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    checkAttempts($ip);

    $hash = users()[$username] ?? null;
    if (!password_verify($password, $hash ?? DUMMY_HASH) || $hash === null) {
        recordFailedAttempt($ip);
        throw users()
            ? new HttpError(401, 'Nome utente o password non corretti')
            : new HttpError(401, 'Non c\'è ancora nessun utente: crea il primo dalla pagina setup.php', ['needsSetup' => true]);
    }

    db()->prepare("DELETE FROM {$t['login_attempts']} WHERE ip = ?")->execute([$ip]);
    setAuthCookie($username, !empty($input['remember']));
    return ['user' => $username, 'weekStartDay' => weekStartDay()];
}

// ---------------------------------------------------------------------------
// Piatti
// ---------------------------------------------------------------------------

// Ogni piatto con quante volte compare nelle settimane salvate, l'ultima data e la ricetta.
function selectDishes(string $where = '', array $params = []): array
{
    $t = tables();
    $stmt = db()->prepare(
        "SELECT d.id, d.name, d.category, d.notes, d.servings, d.created_at,
                COALESCE(s.times_planned, 0) AS times_planned, s.last_planned
         FROM {$t['dishes']} d
         LEFT JOIN (
             SELECT dish_id, COUNT(*) AS times_planned,
                    -- day è senza segno: con CAST la differenza può essere negativa senza errori
                    MAX(DATE_ADD(week_start, INTERVAL MOD(CAST(day AS SIGNED) - WEEKDAY(week_start) + 7, 7) DAY)) AS last_planned
             FROM {$t['meals']}
             WHERE dish_id IS NOT NULL
             GROUP BY dish_id
         ) s ON s.dish_id = d.id
         $where
         ORDER BY d.name"
    );
    $stmt->execute($params);
    return attachRecipes(array_map(function (array $row) {
        return [
            'id' => (string) $row['id'],
            'name' => $row['name'],
            'category' => $row['category'],
            'notes' => $row['notes'],
            'servings' => (int) $row['servings'],
            'createdAt' => isoDateTime($row['created_at']),
            'timesPlanned' => (int) $row['times_planned'],
            'lastPlanned' => $row['last_planned'],
        ];
    }, $stmt->fetchAll()));
}

function findDish(int $id): array
{
    $dishes = selectDishes('WHERE d.id = ?', [$id]);
    if (!$dishes) {
        throw new HttpError(404, 'Piatto non trovato');
    }
    return $dishes[0];
}

function parseDish(array $input): array
{
    $name = cleanLine($input['name'] ?? null, 120);
    if ($name === '') {
        throw new HttpError(400, 'Il nome del piatto è obbligatorio');
    }
    $category = $input['category'] ?? null;
    return [
        'name' => $name,
        'category' => in_array($category, CATEGORIES, true) ? $category : 'altro',
        'notes' => cleanLine($input['notes'] ?? null, 300),
    ];
}

function assertNameAvailable(string $name, int $exceptId = 0): void
{
    $t = tables();
    $stmt = db()->prepare("SELECT name FROM {$t['dishes']} WHERE name = ? AND id <> ? LIMIT 1");
    $stmt->execute([$name, $exceptId]);
    $clash = $stmt->fetchColumn();
    if ($clash !== false) {
        throw new HttpError(409, "Hai già un piatto chiamato «{$clash}»");
    }
}

function createDish(array $input): array
{
    $t = tables();
    $dish = parseDish($input);
    assertNameAvailable($dish['name']);
    try {
        db()->prepare("INSERT INTO {$t['dishes']} (name, category, notes, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())")
            ->execute([$dish['name'], $dish['category'], $dish['notes']]);
    } catch (PDOException $e) {
        if (isDuplicateKey($e)) {
            throw new HttpError(409, "Hai già un piatto chiamato «{$dish['name']}»");
        }
        throw $e;
    }
    return findDish((int) db()->lastInsertId());
}

function updateDish(int $id, array $input): array
{
    $t = tables();
    findDish($id);
    $dish = parseDish($input);
    assertNameAvailable($dish['name'], $id);
    transaction(function (PDO $pdo) use ($t, $id, $dish) {
        $pdo->prepare("UPDATE {$t['dishes']} SET name = ?, category = ?, notes = ? WHERE id = ?")
            ->execute([$dish['name'], $dish['category'], $dish['notes'], $id]);
        // Il nuovo nome finisce anche nelle copie salvate nelle settimane, così lo
        // storico mostra il nome più recente anche se un giorno il piatto viene eliminato.
        $pdo->prepare("UPDATE {$t['meals']} SET dish_name = ? WHERE dish_id = ?")
            ->execute([$dish['name'], $id]);
    });
    return findDish($id);
}

function deleteDish(int $id): void
{
    $t = tables();
    $stmt = db()->prepare("DELETE FROM {$t['dishes']} WHERE id = ?");
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) {
        throw new HttpError(404, 'Piatto non trovato');
    }
}

// ---------------------------------------------------------------------------
// Settimane (identificate dalla data del primo giorno, AAAA-MM-GG). Le settimane iniziano
// il giorno scelto nelle impostazioni (lunedì se non indicato); i pasti tengono il giorno
// della settimana (meals.day), la data si ricava dal primo giorno.
// ---------------------------------------------------------------------------

// Giorno in cui iniziano le settimane: 0 = lunedì ... 6 = domenica.
function weekStartDay(): int
{
    $t = tables();
    $value = db()->query("SELECT value FROM {$t['settings']} WHERE name = 'week_start_day'")->fetchColumn();
    return is_string($value) && preg_match('/^[0-6]$/', $value) ? (int) $value : 0;
}

// Cambia il giorno di inizio e riorganizza le settimane salvate di conseguenza.
function changeWeekStart(array $input): array
{
    $t = tables();
    $day = $input['weekStartDay'] ?? null;
    if (!is_int($day) || $day < 0 || $day > 6) {
        throw new HttpError(400, 'Giorno di inizio non valido');
    }
    if ($day !== weekStartDay()) {
        transaction(function (PDO $pdo) use ($t, $day) {
            $weeks = regroupWeeks(loadWeeks(), $day);
            $pdo->exec("DELETE FROM {$t['weeks']}"); // pasti e liste della spesa vanno via a cascata
            foreach ($weeks as $key => $week) {
                writeWeek($pdo, (string) $key, $week);
            }
            $pdo->prepare(
                "INSERT INTO {$t['settings']} (name, value) VALUES ('week_start_day', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)"
            )->execute([(string) $day]);
        });
    }
    return ['weekStartDay' => weekStartDay()];
}

// Le settimane ($weeks come da loadWeeks) raggruppate di nuovo perché inizino il giorno $startDay.
// Ogni pasto resta nella sua data; note e lista della spesa passano alla nuova settimana che
// contiene la maggior parte della vecchia, cioè il suo quarto giorno.
function regroupWeeks(array $weeks, int $startDay): array
{
    $result = [];
    foreach ($weeks as $key => $week) {
        $key = (string) $key;
        $main = weekStartOf(parseDateKey($key)->modify('+3 day'), $startDay)->format('Y-m-d');
        $result[$main] = $result[$main] ?? emptyWeek($main);
        if (trim($week['notes']) !== '') {
            $notes = $result[$main]['notes'];
            $result[$main]['notes'] = $notes === '' ? $week['notes'] : "$notes\n\n{$week['notes']}";
        }
        foreach ($week['shopping'] as $item) {
            $result[$main]['shopping'][] = $item;
        }
        foreach (DAYS as $day => $dayKey) {
            $target = weekStartOf(dayDate($key, $day), $startDay)->format('Y-m-d');
            foreach (MEALS as $meal) {
                foreach ($week['meals'][$dayKey][$meal] as $entry) {
                    $result[$target] = $result[$target] ?? emptyWeek($target);
                    $result[$target]['meals'][$dayKey][$meal][] = $entry;
                }
            }
        }
    }
    krsort($result);
    return $result;
}

function emptyWeek(string $key): array
{
    $meals = [];
    foreach (DAYS as $day) {
        foreach (MEALS as $meal) {
            $meals[$day][$meal] = [];
        }
    }
    return ['week' => $key, 'meals' => $meals, 'notes' => '', 'shopping' => [], 'updatedAt' => null];
}

// Tutte le settimane salvate (o solo $key), dalla più recente: tre query in tutto.
function loadWeeks(?string $key = null): array
{
    $t = tables();
    $filter = $key === null ? '' : 'WHERE week_start = ?';
    $params = $key === null ? [] : [$key];

    $weeks = [];
    $stmt = db()->prepare("SELECT week_start, notes, updated_at FROM {$t['weeks']} $filter ORDER BY week_start DESC");
    $stmt->execute($params);
    foreach ($stmt->fetchAll() as $row) {
        $week = emptyWeek($row['week_start']);
        $week['notes'] = $row['notes'];
        $week['updatedAt'] = isoDateTime($row['updated_at']);
        $weeks[$row['week_start']] = $week;
    }
    if (!$weeks) {
        return [];
    }

    $stmt = db()->prepare(
        "SELECT m.week_start, m.day, m.meal, m.dish_id, COALESCE(d.name, m.dish_name) AS name
         FROM {$t['meals']} m
         LEFT JOIN {$t['dishes']} d ON d.id = m.dish_id
         " . ($key === null ? '' : 'WHERE m.week_start = ?') . "
         ORDER BY m.week_start, m.day, m.meal, m.position"
    );
    $stmt->execute($params);
    foreach ($stmt->fetchAll() as $row) {
        $weeks[$row['week_start']]['meals'][DAYS[(int) $row['day']]][$row['meal']][] = [
            'dishId' => $row['dish_id'] === null ? null : (string) $row['dish_id'],
            'name' => $row['name'],
        ];
    }

    $stmt = db()->prepare("SELECT id, week_start, text, category, done FROM {$t['shopping']} $filter ORDER BY week_start, position");
    $stmt->execute($params);
    foreach ($stmt->fetchAll() as $row) {
        $weeks[$row['week_start']]['shopping'][] = [
            'id' => (string) $row['id'],
            'text' => $row['text'],
            'category' => $row['category'],
            'done' => (bool) $row['done'],
        ];
    }

    return $weeks;
}

function getWeek(string $key): array
{
    return loadWeeks($key)[$key] ?? emptyWeek($key);
}

// Ripulisce la settimana inviata dal browser. $dishNames: [id => nome] dei piatti esistenti.
function normalizeWeek(array $input, array $dishNames): array
{
    $meals = [];
    foreach (DAYS as $day) {
        foreach (MEALS as $meal) {
            $list = $input['meals'][$day][$meal] ?? [];
            $entries = [];
            foreach (is_array($list) ? $list : [] as $entry) {
                if (!is_array($entry)) {
                    continue;
                }
                $raw = $entry['dishId'] ?? null;
                $dishId = (is_int($raw) || (is_string($raw) && ctype_digit($raw))) && isset($dishNames[(int) $raw]) ? (int) $raw : null;
                $name = $dishId !== null ? $dishNames[$dishId] : cleanLine($entry['name'] ?? null, 120);
                if ($name !== '') {
                    $entries[] = ['dishId' => $dishId, 'name' => $name];
                }
            }
            $meals[$day][$meal] = array_slice($entries, 0, 12);
        }
    }

    $shopping = [];
    foreach (is_array($input['shopping'] ?? null) ? $input['shopping'] : [] as $item) {
        $text = is_array($item) ? cleanLine($item['text'] ?? null, 200) : '';
        if ($text !== '') {
            $category = $item['category'] ?? null;
            $shopping[] = [
                'text' => $text,
                'category' => in_array($category, SHOPPING_CATEGORIES, true) ? $category : null,
                'done' => !empty($item['done']),
            ];
        }
    }

    $notes = isset($input['notes']) && is_string($input['notes']) ? cut($input['notes'], 10000) : '';

    return ['meals' => $meals, 'notes' => $notes, 'shopping' => array_slice($shopping, 0, 300)];
}

function isEmptyWeek(array $week): bool
{
    if (trim($week['notes']) !== '' || $week['shopping']) {
        return false;
    }
    foreach ($week['meals'] as $meals) {
        foreach ($meals as $entries) {
            if ($entries) {
                return false;
            }
        }
    }
    return true;
}

function saveWeek(string $key, array $input): array
{
    $t = tables();
    $dishNames = db()->query("SELECT id, name FROM {$t['dishes']}")->fetchAll(PDO::FETCH_KEY_PAIR);
    $week = normalizeWeek($input, $dishNames);

    transaction(function (PDO $pdo) use ($key, $week) {
        writeWeek($pdo, $key, $week);
    });

    return getWeek($key);
}

// Riscrive per intero una settimana già ripulita (dentro una transazione). Le settimane
// vuote non vengono conservate, così lo storico resta pulito.
function writeWeek(PDO $pdo, string $key, array $week): void
{
    $t = tables();
    $pdo->prepare("DELETE FROM {$t['weeks']} WHERE week_start = ?")->execute([$key]);
    if (isEmptyWeek($week)) {
        return;
    }
    $pdo->prepare("INSERT INTO {$t['weeks']} (week_start, notes, updated_at) VALUES (?, ?, UTC_TIMESTAMP())")
        ->execute([$key, $week['notes']]);

    $insertMeal = $pdo->prepare(
        "INSERT INTO {$t['meals']} (week_start, day, meal, position, dish_id, dish_name) VALUES (?, ?, ?, ?, ?, ?)"
    );
    foreach (DAYS as $dayIndex => $day) {
        foreach (MEALS as $meal) {
            foreach ($week['meals'][$day][$meal] as $position => $entry) {
                $insertMeal->execute([$key, $dayIndex, $meal, $position, $entry['dishId'], $entry['name']]);
            }
        }
    }

    $insertItem = $pdo->prepare(
        "INSERT INTO {$t['shopping']} (week_start, position, text, category, done) VALUES (?, ?, ?, ?, ?)"
    );
    foreach ($week['shopping'] as $position => $item) {
        $insertItem->execute([$key, $position, $item['text'], $item['category'] ?? null, $item['done'] ? 1 : 0]);
    }
}

// Reparti imparati per le voci della lista della spesa: [voce ripulita => reparto].
function shoppingTerms(): object
{
    $t = tables();
    return (object) db()->query("SELECT term, category FROM {$t['shopping_terms']}")->fetchAll(PDO::FETCH_KEY_PAIR);
}

// Ricorda il reparto scelto spostando una voce: la prossima volta finisce lì da sola.
// { term: voce ripulita dal browser (minuscolo, senza quantità), category }
function saveShoppingTerm(array $input): array
{
    $t = tables();
    $term = cleanLine($input['term'] ?? null, 80);
    $category = $input['category'] ?? null;
    if ($term === '' || !in_array($category, SHOPPING_CATEGORIES, true)) {
        throw new HttpError(400, 'Voce o reparto non validi');
    }
    db()->prepare(
        "INSERT INTO {$t['shopping_terms']} (term, category, updated_at) VALUES (?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE category = VALUES(category), updated_at = VALUES(updated_at)"
    )->execute([strtolower($term), $category]);
    return ['ok' => true];
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function respond(int $status, $data): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function readJson(): array
{
    $raw = (string) file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
    if (strlen($raw) > MAX_BODY) {
        throw new HttpError(413, 'Richiesta troppo grande');
    }
    if ($raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new HttpError(400, 'JSON non valido');
    }
    return $data;
}

function idParam(): int
{
    $id = $_GET['id'] ?? '';
    if (!is_string($id) || !ctype_digit($id)) {
        throw new HttpError(400, "Manca l'id");
    }
    return (int) $id;
}

// Primo giorno della settimana che contiene la data indicata. Per salvare ($exact) la data
// deve essere già il primo giorno: se non lo è, il giorno di inizio è cambiato nel frattempo.
function weekParam(bool $exact = false): string
{
    $date = parseDateKey($_GET['week'] ?? '');
    if ($date === null) {
        throw new HttpError(400, 'La settimana va indicata con una data (AAAA-MM-GG)');
    }
    $startDay = weekStartDay();
    $key = weekStartOf($date, $startDay)->format('Y-m-d');
    if ($exact && $key !== $date->format('Y-m-d')) {
        throw new HttpError(409, 'Ora le settimane iniziano di ' . DAY_NAMES[$startDay] . ': ricarica la pagina');
    }
    return $key;
}

// setup.php usa le funzioni di questo file senza eseguire l'API.
if (defined('WFP_LIBRARY')) {
    return;
}

// Risposta 401: se non c'è ancora nessun utente, il browser propone setup.php.
function authRequired(): HttpError
{
    return new HttpError(401, 'Accesso richiesto', users() ? [] : ['needsSetup' => true]);
}

// azione => [metodo, stato HTTP, gestore]. Tutte richiedono l'accesso tranne quelle in PUBLIC_ACTIONS.
const PUBLIC_ACTIONS = ['login', 'logout', 'me'];

$routes = [
    'login' => ['POST', 200, function () {
        return login(readJson());
    }],
    'logout' => ['POST', 200, function () {
        sendAuthCookie('', time() - 3600);
        return ['ok' => true];
    }],
    'me' => ['GET', 200, function () {
        $auth = authToken();
        if ($auth === null) {
            throw authRequired();
        }
        setAuthCookie($auth['user'], $auth['remember']); // rinnova la scadenza
        return ['user' => $auth['user'], 'weekStartDay' => weekStartDay()];
    }],
    'users' => ['GET', 200, function () {
        return listUsers();
    }],
    'user-create' => ['POST', 201, function () {
        return createUser(readJson());
    }],
    'user-password' => ['POST', 200, function () {
        return changePassword(readJson());
    }],
    'user-delete' => ['POST', 200, function () {
        return deleteUser(readJson());
    }],
    'settings-save' => ['POST', 200, function () {
        return changeWeekStart(readJson());
    }],
    'dishes' => ['GET', 200, function () {
        return selectDishes();
    }],
    'dish-create' => ['POST', 201, function () {
        return createDish(readJson());
    }],
    'dish-update' => ['POST', 200, function () {
        return updateDish(idParam(), readJson());
    }],
    'dish-delete' => ['POST', 200, function () {
        deleteDish(idParam());
        return ['ok' => true];
    }],
    'weeks' => ['GET', 200, function () {
        return array_values(loadWeeks());
    }],
    'week' => ['GET', 200, function () {
        return getWeek(weekParam()) + ['weekStartDay' => weekStartDay(), 'shoppingTerms' => shoppingTerms()];
    }],
    'shopping-term' => ['POST', 200, function () {
        return saveShoppingTerm(readJson());
    }],
    'week-save' => ['POST', 200, function () {
        return saveWeek(weekParam(true), readJson());
    }],

    'ingredients' => ['GET', 200, function () {
        return listIngredients();
    }],
    'ingredient-create' => ['POST', 201, function () {
        return createIngredient(readJson());
    }],
    'ingredient-update' => ['POST', 200, function () {
        return updateIngredient(idParam(), readJson());
    }],
    'ingredient-delete' => ['POST', 200, function () {
        deleteIngredient(idParam());
        return ['ok' => true];
    }],
    'dish-recipe' => ['POST', 200, function () {
        return saveRecipe(idParam(), readJson());
    }],
    'products' => ['GET', 200, function () {
        return listProducts();
    }],
    'product' => ['GET', 200, function () {
        return getProduct(idParam());
    }],
    'product-update' => ['POST', 200, function () {
        return updateProduct(idParam(), readJson());
    }],
    'product-merge' => ['POST', 200, function () {
        return mergeProduct(idParam(), readJson());
    }],
    'product-delete' => ['POST', 200, function () {
        deleteProduct(idParam());
        return ['ok' => true];
    }],
    'receipts' => ['GET', 200, function () {
        return listReceipts();
    }],
    'receipt' => ['GET', 200, function () {
        return getReceipt(idParam());
    }],
    'receipt-preview' => ['POST', 200, function () {
        return previewReceipt(readJson());
    }],
    'receipt-save' => ['POST', 201, function () {
        return saveReceipt(readJson());
    }],
    'receipt-relink' => ['POST', 200, function () {
        return relinkReceipt(idParam(), readJson());
    }],
    'receipt-delete' => ['POST', 200, function () {
        deleteReceipt(idParam());
        return ['ok' => true];
    }],
];

try {
    $action = $_GET['action'] ?? '';
    if (!is_string($action) || !isset($routes[$action])) {
        throw new HttpError(404, 'Azione sconosciuta');
    }
    [$method, $status, $handler] = $routes[$action];
    if ($_SERVER['REQUEST_METHOD'] !== $method) {
        throw new HttpError(405, 'Metodo non consentito');
    }
    // Le scritture arrivano solo come JSON: un altro sito non può inviarle con un
    // semplice form (in aggiunta al cookie SameSite=Lax).
    if ($method === 'POST' && stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') !== 0) {
        throw new HttpError(415, 'Le richieste devono essere in JSON');
    }
    $run = function () use ($action, $handler) {
        if (!in_array($action, PUBLIC_ACTIONS, true) && authToken() === null) {
            throw authRequired();
        }
        return $handler();
    };
    try {
        $result = $run();
    } catch (PDOException $e) {
        // 42S02 = tabella inesistente, 42S22 = colonna inesistente: è il primo avvio o
        // una versione nuova del sito; creo/aggiorno le tabelle e riprovo.
        if (!in_array($e->getCode(), ['42S02', '42S22'], true)) {
            throw $e;
        }
        createSchema();
        $result = $run();
    }
    respond($status, $result);
} catch (HttpError $e) {
    respond($e->status, ['error' => $e->getMessage()] + $e->extra);
} catch (Throwable $e) {
    error_log((string) $e);
    respond(500, ['error' => 'Errore interno del server']);
}
