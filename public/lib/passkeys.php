<?php
/*
 * Accesso con passkey (WebAuthn): l'utente collegato registra una passkey dalla pagina Utenti,
 * poi può entrare con quella invece che con la password. Incluso da api.php.
 *
 * Funziona solo in https (o su localhost). Si accettano chiavi ES256 (quasi tutti i dispositivi)
 * e RS256 (alcuni Windows Hello); l'attestazione non serve ('none'): all'accesso conta la firma
 * fatta con la chiave registrata. Le sfide valgono una volta sola e per pochi minuti.
 */

declare(strict_types=1);

const PASSKEY_ALGORITHMS = [-7, -257]; // ES256, RS256
const PASSKEY_CHALLENGE_MINUTES = 5;

function passkeySchema(array $t, string $options): array
{
    return [
        "CREATE TABLE IF NOT EXISTS {$t['passkeys']} (
            id CHAR(64) NOT NULL COMMENT 'sha256 dell''id della credenziale',
            credential_id VARCHAR(1400) NOT NULL COMMENT 'id della credenziale, in base64url',
            user_name VARCHAR(40) NOT NULL,
            public_key TEXT NOT NULL COMMENT 'chiave pubblica in PEM',
            sign_count INT UNSIGNED NOT NULL DEFAULT 0,
            name VARCHAR(80) NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL,
            last_used_at DATETIME NULL,
            PRIMARY KEY (id),
            KEY idx_user (user_name),
            FOREIGN KEY (user_name) REFERENCES {$t['users']} (name) ON DELETE CASCADE
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['passkey_challenges']} (
            challenge CHAR(43) NOT NULL COMMENT '32 byte casuali in base64url',
            purpose VARCHAR(10) NOT NULL COMMENT 'register | login',
            user_name VARCHAR(40) NOT NULL DEFAULT '' COMMENT 'vuoto per l''accesso',
            created_at DATETIME NOT NULL,
            PRIMARY KEY (challenge),
            KEY idx_created (created_at)
        ) $options",
    ];
}

// ---------------------------------------------------------------------------
// Codifiche: base64url, CBOR (quanto serve a WebAuthn), chiavi COSE → PEM
// ---------------------------------------------------------------------------

function b64uEncode(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

function b64uDecode($value): string
{
    if (!is_string($value) || $value === '' || !preg_match('/^[A-Za-z0-9_-]+$/', $value)) {
        throw new HttpError(400, 'Dati della passkey non validi');
    }
    $bytes = base64_decode(str_pad(strtr($value, '-_', '+/'), (int) ceil(strlen($value) / 4) * 4, '='), true);
    if ($bytes === false) {
        throw new HttpError(400, 'Dati della passkey non validi');
    }
    return $bytes;
}

// Un elemento CBOR a partire da $offset (che avanza): interi, stringhe, array, mappe, tag, true/false/null.
function cborDecode(string $data, int &$offset)
{
    if ($offset >= strlen($data)) {
        throw new HttpError(400, 'Dati della passkey incompleti');
    }
    $byte = ord($data[$offset++]);
    $major = $byte >> 5;
    $info = $byte & 0x1f;
    if ($major === 7) {
        $simple = [20 => false, 21 => true, 22 => null];
        if (!array_key_exists($info, $simple)) {
            throw new HttpError(400, 'Dati della passkey non supportati');
        }
        return $simple[$info];
    }
    $length = cborLength($data, $offset, $info);
    switch ($major) {
        case 0:
            return $length;
        case 1:
            return -1 - $length;
        case 2:
        case 3:
            if ($offset + $length > strlen($data)) {
                throw new HttpError(400, 'Dati della passkey incompleti');
            }
            $value = substr($data, $offset, $length);
            $offset += $length;
            return $value;
        case 4:
            $list = [];
            for ($i = 0; $i < $length; $i++) {
                $list[] = cborDecode($data, $offset);
            }
            return $list;
        case 5:
            $map = [];
            for ($i = 0; $i < $length; $i++) {
                $key = cborDecode($data, $offset);
                if (!is_int($key) && !is_string($key)) {
                    throw new HttpError(400, 'Dati della passkey non supportati');
                }
                $map[$key] = cborDecode($data, $offset);
            }
            return $map;
        default: // 6: tag, conta solo il valore
            return cborDecode($data, $offset);
    }
}

function cborLength(string $data, int &$offset, int $info): int
{
    if ($info < 24) {
        return $info;
    }
    $sizes = [24 => 1, 25 => 2, 26 => 4, 27 => 8];
    if (!isset($sizes[$info])) {
        throw new HttpError(400, 'Dati della passkey non supportati');
    }
    if ($offset + $sizes[$info] > strlen($data)) {
        throw new HttpError(400, 'Dati della passkey incompleti');
    }
    $value = 0;
    for ($i = 0; $i < $sizes[$info]; $i++) {
        $value = ($value << 8) | ord($data[$offset++]);
    }
    return $value;
}

function derLength(int $length): string
{
    if ($length < 128) {
        return chr($length);
    }
    $bytes = ltrim(pack('N', $length), "\0");
    return chr(0x80 | strlen($bytes)) . $bytes;
}

function derSequence(string $content): string
{
    return "\x30" . derLength(strlen($content)) . $content;
}

function derInteger(string $bytes): string
{
    $bytes = ltrim($bytes, "\0");
    if ($bytes === '' || (ord($bytes[0]) & 0x80)) {
        $bytes = "\0" . $bytes;
    }
    return "\x02" . derLength(strlen($bytes)) . $bytes;
}

// Chiave pubblica COSE (dalla registrazione) in formato PEM, per openssl_verify.
function coseToPem(array $cose): string
{
    [$kty, $alg] = [$cose[1] ?? null, $cose[3] ?? null];
    if ($kty === 2 && $alg === -7 && ($cose[-1] ?? null) === 1
        && is_string($cose[-2] ?? null) && strlen($cose[-2]) === 32 && is_string($cose[-3] ?? null) && strlen($cose[-3]) === 32) {
        // EC P-256: intestazione SubjectPublicKeyInfo fissa + punto non compresso
        $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . "\x04" . $cose[-2] . $cose[-3];
    } elseif ($kty === 3 && $alg === -257 && is_string($cose[-1] ?? null) && is_string($cose[-2] ?? null)) {
        $rsa = derSequence(derInteger($cose[-1]) . derInteger($cose[-2]));
        $algorithm = derSequence("\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00"); // rsaEncryption, NULL
        $der = derSequence($algorithm . "\x03" . derLength(strlen($rsa) + 1) . "\x00" . $rsa);
    } else {
        throw new HttpError(400, 'Questo tipo di passkey non è supportato');
    }
    $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
    if (@openssl_pkey_get_public($pem) === false) {
        throw new HttpError(400, 'Chiave della passkey non valida');
    }
    return $pem;
}

// ---------------------------------------------------------------------------
// Controlli comuni a registrazione e accesso
// ---------------------------------------------------------------------------

// Il sito (Relying Party) è l'host a cui il browser si è rivolto, senza porta.
function passkeyRpId(): string
{
    $host = strtolower((string) preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
    if (!preg_match('/^[a-z0-9.-]+$/', $host)) {
        throw new HttpError(400, 'Indirizzo del sito non valido');
    }
    return $host;
}

// clientDataJSON: tipo di operazione e origine giuste (questo sito, in https). Restituisce [dati, JSON].
function passkeyClientData($encoded, string $type): array
{
    $json = b64uDecode($encoded);
    $data = json_decode($json, true);
    if (!is_array($data) || ($data['type'] ?? null) !== $type) {
        throw new HttpError(400, 'Risposta della passkey non valida');
    }
    $origin = is_string($data['origin'] ?? null) ? parse_url($data['origin']) : false;
    $host = strtolower((string) ($origin['host'] ?? ''));
    $scheme = $origin['scheme'] ?? '';
    if ($host !== passkeyRpId() || !($scheme === 'https' || ($scheme === 'http' && $host === 'localhost'))) {
        throw new HttpError(400, 'La passkey non è di questo sito');
    }
    return [$data, $json];
}

// Date in UTC calcolate qui, così le query sono semplici e uguali su ogni database.
function utcNow(int $secondsAgo = 0): string
{
    return gmdate('Y-m-d H:i:s', time() - $secondsAgo);
}

// $user: l'utente che registra la passkey; vuoto per l'accesso.
function newPasskeyChallenge(string $purpose, string $user = ''): string
{
    $t = tables();
    db()->prepare("DELETE FROM {$t['passkey_challenges']} WHERE created_at < ?")->execute([utcNow(PASSKEY_CHALLENGE_MINUTES * 60)]);
    $challenge = b64uEncode(random_bytes(32));
    db()->prepare("INSERT INTO {$t['passkey_challenges']} (challenge, purpose, user_name, created_at) VALUES (?, ?, ?, ?)")
        ->execute([$challenge, $purpose, $user, utcNow()]);
    return $challenge;
}

// La sfida firmata deve essere una delle nostre, ancora valida: viene consumata.
function usePasskeyChallenge(array $clientData, string $purpose, string $user = ''): void
{
    $t = tables();
    $stmt = db()->prepare(
        "DELETE FROM {$t['passkey_challenges']} WHERE challenge = ? AND purpose = ? AND user_name = ? AND created_at >= ?"
    );
    $challenge = is_string($clientData['challenge'] ?? null) ? $clientData['challenge'] : '';
    $stmt->execute([$challenge, $purpose, $user, utcNow(PASSKEY_CHALLENGE_MINUTES * 60)]);
    if ($stmt->rowCount() === 0) {
        throw new HttpError(400, 'Richiesta scaduta: riprova');
    }
}

// authenticatorData: hash del sito (32 byte), flag (1), contatore (4) e, alla registrazione,
// la credenziale (aaguid 16, lunghezza dell'id 2, id, chiave pubblica COSE).
function parseAuthData(string $authData): array
{
    if (strlen($authData) < 37) {
        throw new HttpError(400, 'Dati della passkey incompleti');
    }
    if (!hash_equals(hash('sha256', passkeyRpId(), true), substr($authData, 0, 32))) {
        throw new HttpError(400, 'La passkey non è di questo sito');
    }
    $flags = ord($authData[32]);
    if (!($flags & 0x01)) {
        throw new HttpError(400, 'Conferma la passkey sul dispositivo');
    }
    $result = ['signCount' => unpack('N', substr($authData, 33, 4))[1]];
    if ($flags & 0x40) {
        if (strlen($authData) < 55) {
            throw new HttpError(400, 'Dati della passkey incompleti');
        }
        $idLength = unpack('n', substr($authData, 53, 2))[1];
        $result['credentialId'] = substr($authData, 55, $idLength);
        $offset = 55 + $idLength;
        $result['publicKey'] = cborDecode($authData, $offset);
    }
    return $result;
}

// ---------------------------------------------------------------------------
// Registrazione (utente collegato), elenco ed eliminazione
// ---------------------------------------------------------------------------

function passkeyRegisterOptions(): array
{
    $t = tables();
    $user = authToken()['user'];
    $stmt = db()->prepare("SELECT credential_id FROM {$t['passkeys']} WHERE user_name = ?");
    $stmt->execute([$user]);
    return [
        'challenge' => newPasskeyChallenge('register', $user),
        'rp' => ['name' => 'Menù della settimana', 'id' => passkeyRpId()],
        // Identificativo opaco e stabile dell'utente, che non rivela il nome.
        'user' => ['id' => b64uEncode(hash_hmac('sha256', $user, secret(), true)), 'name' => $user, 'displayName' => $user],
        'pubKeyCredParams' => array_map(function (int $alg) {
            return ['type' => 'public-key', 'alg' => $alg];
        }, PASSKEY_ALGORITHMS),
        'authenticatorSelection' => ['residentKey' => 'required', 'requireResidentKey' => true, 'userVerification' => 'preferred'],
        'excludeCredentials' => array_map(function (string $id) {
            return ['type' => 'public-key', 'id' => $id];
        }, $stmt->fetchAll(PDO::FETCH_COLUMN)),
        'attestation' => 'none',
        'timeout' => 120000,
    ];
}

// { clientDataJSON, attestationObject, name } in base64url, dalla registrazione nel browser.
function registerPasskey(array $input): array
{
    $t = tables();
    $user = authToken()['user'];
    [$clientData] = passkeyClientData($input['clientDataJSON'] ?? null, 'webauthn.create');
    usePasskeyChallenge($clientData, 'register', $user);

    $offset = 0;
    $attestation = cborDecode(b64uDecode($input['attestationObject'] ?? null), $offset);
    if (!is_array($attestation) || !is_string($attestation['authData'] ?? null)) {
        throw new HttpError(400, 'Risposta della passkey non valida');
    }
    $auth = parseAuthData($attestation['authData']);
    if (!isset($auth['credentialId']) || $auth['credentialId'] === '' || !is_array($auth['publicKey'])) {
        throw new HttpError(400, 'Manca la chiave della passkey');
    }
    $pem = coseToPem($auth['publicKey']);
    try {
        db()->prepare(
            "INSERT INTO {$t['passkeys']} (id, credential_id, user_name, public_key, sign_count, name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)"
        )->execute([
            hash('sha256', $auth['credentialId']),
            b64uEncode($auth['credentialId']),
            $user,
            $pem,
            $auth['signCount'],
            cleanLine($input['name'] ?? null, 80) ?: 'Passkey',
            utcNow(),
        ]);
    } catch (PDOException $e) {
        if (!isDuplicateKey($e)) {
            throw $e;
        }
        throw new HttpError(409, 'Questa passkey è già registrata');
    }
    return listPasskeys();
}

function listPasskeys(): array
{
    $t = tables();
    $stmt = db()->prepare("SELECT id, name, created_at, last_used_at FROM {$t['passkeys']} WHERE user_name = ? ORDER BY created_at");
    $stmt->execute([authToken()['user']]);
    return array_map(function (array $row) {
        return [
            'id' => $row['id'],
            'name' => $row['name'],
            'createdAt' => isoDateTime($row['created_at']),
            'lastUsedAt' => isoDateTime($row['last_used_at']),
        ];
    }, $stmt->fetchAll());
}

function deletePasskey(array $input): array
{
    $t = tables();
    $stmt = db()->prepare("DELETE FROM {$t['passkeys']} WHERE id = ? AND user_name = ?");
    $stmt->execute([is_string($input['id'] ?? null) ? $input['id'] : '', authToken()['user']]);
    if ($stmt->rowCount() === 0) {
        throw new HttpError(404, 'Passkey non trovata');
    }
    return listPasskeys();
}

// ---------------------------------------------------------------------------
// Accesso
// ---------------------------------------------------------------------------

// Accesso con una passkey salvata sul dispositivo (senza indicare il nome utente).
function passkeyLoginOptions(): array
{
    return [
        'challenge' => newPasskeyChallenge('login'),
        'rpId' => passkeyRpId(),
        'allowCredentials' => [],
        'userVerification' => 'preferred',
        'timeout' => 120000,
    ];
}

// { id, clientDataJSON, authenticatorData, signature } in base64url, più remember.
function loginWithPasskey(array $input): array
{
    $t = tables();
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    checkAttempts($ip);
    try {
        [$clientData, $clientJson] = passkeyClientData($input['clientDataJSON'] ?? null, 'webauthn.get');
        usePasskeyChallenge($clientData, 'login');
        $id = hash('sha256', b64uDecode($input['id'] ?? null));
        $stmt = db()->prepare("SELECT user_name, public_key, sign_count FROM {$t['passkeys']} WHERE id = ?");
        $stmt->execute([$id]);
        $passkey = $stmt->fetch();
        if (!$passkey) {
            throw new HttpError(401, 'Passkey non riconosciuta: forse è stata eliminata dal sito');
        }
        $authData = b64uDecode($input['authenticatorData'] ?? null);
        $auth = parseAuthData($authData);
        $signed = $authData . hash('sha256', $clientJson, true);
        if (@openssl_verify($signed, b64uDecode($input['signature'] ?? null), $passkey['public_key'], OPENSSL_ALGO_SHA256) !== 1) {
            throw new HttpError(401, 'Firma della passkey non valida');
        }
        // Un contatore che torna indietro fa pensare a una copia della chiave (0 = non usato).
        $count = (int) $passkey['sign_count'];
        if (($auth['signCount'] > 0 || $count > 0) && $auth['signCount'] <= $count) {
            throw new HttpError(401, 'Passkey sospetta: eliminala dalla pagina Utenti e registrala di nuovo');
        }
    } catch (HttpError $e) {
        recordFailedAttempt($ip);
        throw $e;
    }
    db()->prepare("UPDATE {$t['passkeys']} SET sign_count = ?, last_used_at = ? WHERE id = ?")
        ->execute([$auth['signCount'], utcNow(), $id]);
    return signIn($passkey['user_name'], !empty($input['remember']));
}
