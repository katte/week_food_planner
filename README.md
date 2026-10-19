# Menù della settimana

Web app per pianificare pranzi e cene della settimana partendo dai piatti che sai cucinare, con la lista della spesa e il costo dei piatti calcolato dagli scontrini.

PHP + MySQL sul server, JavaScript senza framework né build nel browser: gira su un normale hosting condiviso.

## Funzioni

- **Settimana**: tabellone con pranzo e cena dei 7 giorni, note e lista della spesa, stampabile in A4. Il giorno di inizio è configurabile (es. sabato, se fai la spesa il sabato).
- **Piatti**: i piatti che sai fare, con ricetta, porzioni e costo totale e a porzione. Un avviso segnala gli ingredienti che non hanno ancora un prezzo.
- **Spesa**: scontrini letti da un'AI (foto → JSON con il prompt incluso), articoli con lo storico dei prezzi al kg, al litro o al pezzo, ingredienti collegati alle ricette.
- **Storico**: le settimane passate, con ricerca per piatto.
- **Utenti**: accesso con password. I dati sono condivisi da tutti gli utenti (pensato per una famiglia).

## Requisiti

PHP 7.4+ con `pdo_mysql`, MySQL o MariaDB, Apache (per i `.htaccess`; con altri server va negato l'accesso a `config.php` e a `lib/`).

## Installazione

1. Copia `public/config.example.php` in `public/config.php` e inserisci i dati del database e `secret`, una stringa casuale di almeno 32 caratteri (es. `php -r "echo bin2hex(random_bytes(32));"`).
2. Pubblica il contenuto di `public/`.
3. Apri `setup.php`: controlla la configurazione, crea le tabelle e il primo utente (chiede la `secret`). Gli altri utenti si aggiungono dalla pagina **Utenti**.

`setup.php` serve anche a reimpostare una password dimenticata. Le tabelle vengono comunque create e aggiornate da sole alla prima richiesta, con il prefisso scelto in `config.php`.

`deploy.py` (facoltativo) pubblica via FTP solo i file modificati, con la configurazione in `deploy_config.ini` (modello: `deploy_config.sample.ini`).

## Scontrini e costi

1. In **Spesa → Importa scontrino** copia il prompt (contiene già l'elenco dei tuoi ingredienti) e passalo a ChatGPT, Claude o Gemini con le foto, anche di più scontrini insieme.
2. Incolla il JSON restituito: ogni riga diventa un **articolo**, collegabile a un **ingrediente** delle ricette. Gli abbinamenti vengono ricordati per gli scontrini successivi.

Ogni acquisto è ricondotto a un prezzo al kg, al litro o al pezzo: dal peso stampato, dal formato della confezione o dal numero di pezzi. Se lo scontrino non riporta il formato, lo si indica una volta sulla scheda dell'articolo; per le cose pesate al banco si indica invece il prezzo al kg e il peso si ricava dall'importo.

Il costo di un piatto usa, per ogni ingrediente, il prezzo pieno dell'ultimo acquisto nell'unità della ricetta. Gli ingredienti trascurabili (sale, olio…) sono esclusi.

## Struttura

```
public/                 il sito da pubblicare
  index.html, styles.css
  app.js                settimana, piatti, storico, accesso
  recipes.js            ricette e costi
  groceries.js          scontrini, articoli, ingredienti
  users.js              utenti
  api.php               API JSON (lib/groceries.php: spesa e costi)
  setup.php             configurazione iniziale e reset delle password
  prompt-scontrino.txt  prompt per l'AI
deploy.py               pubblicazione via FTP (facoltativa)
```

## Sicurezza

Password salvate con `password_hash`, cookie di accesso firmati (HMAC con `secret`), blocco temporaneo dopo 10 tentativi sbagliati, `config.php` non raggiungibile dal browser. Non c'è registrazione pubblica: i nuovi utenti li crea chi ha già accesso. Usa HTTPS.

`config.php`, `deploy_config.ini` e `.deploy_state.json` sono esclusi da git.

## Licenza

MIT, vedi `LICENSE`.
