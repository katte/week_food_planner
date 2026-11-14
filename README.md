# Menù della settimana

Web app per pianificare pranzi e cene della settimana partendo dai piatti che sai cucinare, con la lista della spesa e il costo dei piatti calcolato dagli scontrini.

PHP + MySQL sul server, JavaScript senza framework né build nel browser: gira su un normale hosting condiviso.

Chiunque può iscriversi e avere il suo **spazio** (una famiglia, un gruppo, una persona sola), con i suoi piatti, settimane, spese e scontrini, e aggiungervi le persone con cui condividerlo.

## Funzioni

- **Settimana**: tabellone con pranzo e cena dei 7 giorni, note e lista della spesa, stampabile in A4. Il giorno di inizio è configurabile (es. sabato, se fai la spesa il sabato).
- **Lista della spesa**: un solo campo per aggiungere; ogni voce va da sola nel suo reparto (frutta, verdura, carne…) grazie a un dizionario di parole comuni. Le voci si riordinano trascinandole; spostandone una in un altro reparto, il sito lo ricorda per le volte successive.
- **Pagella della settimana**: un voto dalla A alla E su quanto il menù segue le frequenze della dieta mediterranea (verdura a ogni pasto, pesce e legumi almeno 2 volte, poca carne rossa e pochi salumi…), con il dettaglio gruppo per gruppo. I gruppi alimentari dei piatti si riconoscono dal nome e dagli ingredienti della ricetta con un dizionario, senza servizi esterni, e si possono correggere a mano.
- **Piatti**: i piatti che sai fare, con ricetta, porzioni e costo totale e a porzione. Sotto ogni ingrediente della ricetta c'è il prezzo usato e l'acquisto da cui viene; dal nome si apre una scheda per correggerlo al volo (formato o prezzo al kg degli articoli, gruppo alimentare). Un avviso segnala gli ingredienti che non hanno ancora un prezzo.
- **Spesa**: scontrini letti da un'AI (foto → JSON con il prompt incluso), articoli con lo storico dei prezzi al kg, al litro o al pezzo, ingredienti collegati alle ricette.
- **Storico**: le settimane passate, con ricerca per piatto.
- **Spazi e utenti**: iscrizione libera, che crea uno spazio con il suo primo utente; dalla pagina dello spazio si aggiungono altre persone, si sceglie una nuova password per chi l'ha dimenticata, si elimina lo spazio con tutti i dati. Accesso con password o con **passkey** (impronta, volto o PIN del dispositivo). Con un'email facoltativa si riceve il link per una nuova password.
- **Gestione** (solo per chi è in `admins` di `config.php`): riepilogo del sito (spazi, utenti, nuove iscrizioni, spazi attivi), elenco degli spazi con ricerca e ordinamento, creazione di uno spazio con il suo primo utente, e per ogni spazio una scheda con utenti, email, ultimo accesso e numeri, da cui rinominarlo, sospenderlo (nessuno può entrare, i dati restano), eliminarlo, aggiungere o togliere utenti, dare una nuova password, e aprirlo **in sola lettura** per aiutare chi ha un problema (il server rifiuta ogni modifica finché non si torna al proprio spazio).

## Requisiti

PHP 7.4+ con `pdo_mysql` (e `openssl` per le passkey), MySQL o MariaDB, Apache (per i `.htaccess`; con altri server va negato l'accesso a `config.php` e a `lib/`). HTTPS: le passkey funzionano solo lì, e il `.htaccess` reindirizza sempre su https.

## Installazione

1. Copia `public/config.example.php` in `public/config.php` e inserisci i dati del database, `secret` (una stringa casuale di almeno 32 caratteri, es. `php -r "echo bin2hex(random_bytes(32));"`), il tuo nome utente in `admins`, il mittente delle email (`mail_from`, un indirizzo del dominio del sito) e il contatto per l'informativa sulla privacy (`contact`).
2. Pubblica il contenuto di `public/`.
3. Apri `setup.php`: controlla la configurazione, crea le tabelle e il tuo spazio con il primo utente (chiede la `secret`). Gli altri si iscrivono dal sito.

`setup.php` serve anche a reimpostare la password di qualunque utente. Le tabelle vengono comunque create e aggiornate da sole alla prima richiesta, con il prefisso scelto in `config.php`; i dati di una versione precedente, senza spazi, diventano lo spazio del primo utente. `privacy.php` è una traccia di informativa: va adattata a chi gestisce il sito.

`deploy.py` (facoltativo) pubblica via FTP solo i file modificati, con la configurazione in `deploy_config.ini` (modello: `deploy_config.sample.ini`). Per una copia di prova, con un altro database, basta un secondo INI con un altro `remote_dir` e `site_config` (il `config.php` di quella copia): `python deploy.py -c deploy_test.ini`.

## Test

`python tests/isolation_test.py https://tuosito/cartella-di-prova/` iscrive due spazi, riempie il primo di dati e controlla che il secondo non possa né vederli né toccarli, neppure indicandone gli id; alla fine li elimina. Da lanciare solo su una copia di prova, alzando `signups_per_hour` nel suo `config.php`.

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
  shopping.js           lista della spesa: reparti, dizionario, riordino
  nutrition.js          pagella della settimana: gruppi alimentari e frequenze
  recipes.js            ricette e costi
  groceries.js          scontrini, articoli, ingredienti
  users.js              spazio, utenti, iscrizione, recupero password, passkey, gestione
  api.php               API JSON (lib/spaces.php: spazi e utenti; lib/groceries.php: spesa e costi;
                        lib/passkeys.php: passkey)
  setup.php             configurazione iniziale e reset delle password
  privacy.php           informativa sulla privacy
  prompt-scontrino.txt  prompt per l'AI
tests/isolation_test.py controllo che gli spazi non vedano i dati degli altri
deploy.py               pubblicazione via FTP (facoltativa)
```

## Sicurezza

Password salvate con `password_hash`, cookie di accesso firmati (HMAC con `secret`), blocco temporaneo dopo 10 tentativi sbagliati, `config.php` non raggiungibile dal browser, sito sempre in https.

Ogni dato appartiene a uno spazio e ogni query filtra per lo spazio di chi è collegato: gli id di un altro spazio danno 404. Eliminando uno spazio si cancella tutto a cascata. Iscrizioni limitate per indirizzo IP e al giorno, con un campo trappola per i bot; i link per una nuova password valgono un'ora e una volta sola (nel database c'è solo il loro hash), e la risposta non rivela quali utenti o email esistono.

Passkey (WebAuthn) verificate dal server senza librerie esterne: chiavi ES256 e RS256, sfide monouso valide 5 minuti, controllo di sito, origine e contatore delle firme.

`config.php`, `deploy_config.ini`, `.deploy_state.json` e i file delle altre copie (`deploy_*.ini`, `config.*.php`) sono esclusi da git.

## Licenza

MIT, vedi `LICENSE`.
