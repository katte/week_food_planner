<?php
/*
 * Modello di configurazione. Copialo in config.php e inserisci i dati del database
 * (di solito li trovi nel pannello del tuo hosting, alla voce dei database MySQL).
 * config.php contiene la password: non condividerlo e non metterlo in repository pubblici.
 */

return [
    'db' => [
        'host' => 'localhost',
        'port' => 3306,
        'name' => 'nome_database',
        'user' => 'utente_database',
        'password' => 'password_database',
        // Prefisso delle tabelle, utile se il database è condiviso con altri siti.
        'prefix' => 'menu_',
    ],
    // Chiave segreta che firma i cookie di accesso: una stringa casuale di almeno 32 caratteri.
    // Per generarla: php -r "echo bin2hex(random_bytes(32));"
    // Se la cambi, tutti devono rifare il login.
    'secret' => 'sostituisci_con_una_stringa_casuale_di_64_caratteri',
];
