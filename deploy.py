#!/usr/bin/env python3
"""
Deploy del sito sul server via FTP.

Carica il contenuto di `public/` (ricorsivamente) nella cartella del server indicata
in deploy_config.ini (chiave 'remote_dir' della sezione [ftp], default /htdocs/wfp/).

Non servono dipendenze esterne: usa 'ftplib' della libreria standard.

Le credenziali FTP stanno in un file INI esterno (default: deploy_config.ini),
NON in questo script. Vedi deploy_config.sample.ini come modello.

Uso:
    python deploy.py                  # carica solo i file nuovi o modificati
    python deploy.py --dry-run        # mostra cosa verrebbe caricato senza caricare nulla
    python deploy.py --force          # ricarica tutto, ignorando lo stato precedente
    python deploy.py -c altro.ini     # usa un file di configurazione diverso
"""

import argparse
import configparser
import fnmatch
import ftplib
import hashlib
import json
import os
import sys

# ============================================================================
#  CONFIGURAZIONE
#  Le credenziali FTP NON stanno qui: sono nel file INI esterno (deploy_config.ini).
# ============================================================================
# File di configurazione con le credenziali FTP (default, sovrascrivibile con -c).
DEFAULT_CONFIG_FILE = "./deploy_config.ini"

# Percorso base sul server dove vengono caricate le cartelle, se il file INI non indica
# 'remote_dir' nella sezione [ftp].
DEFAULT_REMOTE_DIR = "/htdocs/wfp/"

# File di stato locale: memorizza l'hash dei file gia' caricati, per saltare quelli invariati.
STATE_FILE = ".deploy_state.json"

# ============================================================================
#  Cosa caricare
# ============================================================================
# Cartelle locali (relative a questo script) da caricare, e sottocartella remota del
# percorso base in cui finisce il loro contenuto ("" = direttamente nel percorso base).
LOCAL_DIRS = {"public": ""}

# Vengono caricati SOLO i file il cui nome combacia con uno di questi pattern (glob).
# Aggiungi qui altre estensioni se servono (es. "*.png", "*.jpg", "*.svg", "*.woff2").
INCLUDE = [
    "*.php",
    "*.html",
    "*.htm",
    "*.js",
    "*.css",
    ".htaccess",
    "LICENSE",
    "*.jpg",
    "*.png",
    "*.svg",
    "*.txt",
]
# ============================================================================


def is_included(name: str) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in INCLUDE)


def file_hash(path: str) -> str:
    """SHA-256 del contenuto del file (letto a blocchi)."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(path: str) -> dict:
    """Carica lo stato del deploy precedente. Se assente/corrotto, riparte da zero."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def save_manifest(path: str, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)


def remote_join(*parts: str) -> str:
    """Join di percorsi remoti sempre con '/' (POSIX), niente backslash di Windows."""
    cleaned = [p.strip("/") for p in parts if p not in ("", "/")]
    joined = "/".join(cleaned)
    return "/" + joined if parts and parts[0].startswith("/") else joined


def ensure_remote_dir(ftp: ftplib.FTP, remote_dir: str) -> None:
    """Crea remote_dir e tutti i genitori mancanti (equivalente di 'mkdir -p')."""
    parts = remote_dir.strip("/").split("/")
    path = "/" if remote_dir.startswith("/") else ""
    for part in parts:
        if not part:
            continue
        path = path + part if path in ("", "/") else path + "/" + part
        try:
            ftp.cwd(path)          # esiste già?
        except ftplib.error_perm:
            try:
                ftp.mkd(path)
                print(f"  [mkdir] {path}")
            except ftplib.error_perm as exc:
                # Se un altro processo l'ha creata nel frattempo va bene, altrimenti rilancia.
                try:
                    ftp.cwd(path)
                except ftplib.error_perm:
                    raise exc


def upload_dir(ftp, local_dir, remote_dir, state, dry_run, force, stats):
    """Carica ricorsivamente i file nuovi/modificati di local_dir dentro remote_dir.

    'state' mappa remote_path -> hash dell'ultimo caricamento e viene aggiornata
    solo dopo un upload andato a buon fine. 'stats' accumula i conteggi.
    """
    if not dry_run:
        ensure_remote_dir(ftp, remote_dir)

    for entry in sorted(os.listdir(local_dir)):
        local_path = os.path.join(local_dir, entry)
        remote_path = remote_join(remote_dir, entry)

        if os.path.isdir(local_path):
            upload_dir(ftp, local_path, remote_path, state, dry_run, force, stats)
        elif is_included(entry):
            digest = file_hash(local_path)
            if not force and state.get(remote_path) == digest:
                stats["invariati"] += 1
                print(f"  [=]     {local_path}")
                continue
            print(f"  [put]   {local_path}  ->  {remote_path}")
            if not dry_run:
                with open(local_path, "rb") as fh:
                    ftp.storbinary(f"STOR {remote_path}", fh)
                state[remote_path] = digest  # registra solo dopo l'upload riuscito
            stats["caricati"] += 1
        else:
            stats["esclusi"] += 1
            print(f"  [skip]  {local_path}")


def load_config(path: str) -> dict:
    """Legge le credenziali FTP dal file INI indicato (sezione [ftp])."""
    if not os.path.isfile(path):
        sys.exit(
            f"ERRORE: file di configurazione non trovato: {path}\n"
            f"Copia 'deploy_config.sample.ini' in '{os.path.basename(path)}' "
            f"e inserisci le credenziali (oppure indicane un altro con -c)."
        )

    parser = configparser.ConfigParser()
    parser.read(path, encoding="utf-8")
    if not parser.has_section("ftp"):
        sys.exit(f"ERRORE: manca la sezione [ftp] nel file di configurazione: {path}")

    section = parser["ftp"]
    host = section.get("host", "").strip()
    user = section.get("user", "").strip()
    if not host or not user:
        sys.exit(f"ERRORE: 'host' e 'user' sono obbligatori in {path}")

    return {
        "host": host,
        "port": section.getint("port", 21),
        "user": user,
        "password": section.get("password", ""),
        "use_tls": section.getboolean("use_tls", False),
        "passive": section.getboolean("passive", True),
    }


def read_remote_dir(path: str) -> str:
    """Cartella remota da 'remote_dir' in [ftp], se il file c'è (serve anche in dry-run)."""
    parser = configparser.ConfigParser()
    if os.path.isfile(path):
        parser.read(path, encoding="utf-8")
    return parser.get("ftp", "remote_dir", fallback="").strip() or DEFAULT_REMOTE_DIR


def connect(cfg: dict) -> ftplib.FTP:
    ftp = ftplib.FTP_TLS() if cfg["use_tls"] else ftplib.FTP()
    print(f"Connessione a {cfg['user']}@{cfg['host']}:{cfg['port']} "
          f"({'FTPS/TLS' if cfg['use_tls'] else 'FTP'}) ...")
    ftp.connect(cfg["host"], cfg["port"], timeout=30)
    ftp.login(cfg["user"], cfg["password"])
    if cfg["use_tls"]:
        ftp.prot_p()  # cifra anche il canale dati
    ftp.set_pasv(cfg["passive"])
    return ftp


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Deploy FTP del sito (solo file nuovi o modificati)."
    )
    p.add_argument(
        "-c", "--config", metavar="FILE", default=None,
        help=f"File di configurazione INI con le credenziali FTP "
             f"(default: {DEFAULT_CONFIG_FILE} accanto allo script).",
    )
    p.add_argument("--dry-run", action="store_true",
                   help="Mostra cosa verrebbe caricato senza caricare nulla (non serve la config).")
    p.add_argument("--force", action="store_true",
                   help="Ricarica tutto ignorando lo stato precedente.")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    dry_run = args.dry_run
    force = args.force

    script_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = args.config or os.path.join(script_dir, DEFAULT_CONFIG_FILE)

    # Verifica che le cartelle locali esistano
    for d in LOCAL_DIRS:
        if not os.path.isdir(os.path.join(script_dir, d)):
            sys.exit(f"ERRORE: cartella locale non trovata: {d}")

    state_path = os.path.join(script_dir, STATE_FILE)
    state = {} if force else load_manifest(state_path)
    stats = {"caricati": 0, "invariati": 0, "esclusi": 0}
    remote_base = read_remote_dir(config_path)

    # In dry-run non serve il server (ne' le credenziali): [put]/[=]/[skip] dipende solo dai file locali.
    ftp = None if dry_run else connect(load_config(config_path))
    try:
        if not dry_run:
            ensure_remote_dir(ftp, remote_base)

        for d, remote_sub in LOCAL_DIRS.items():
            local_dir = os.path.join(script_dir, d)
            remote_dir = remote_join(remote_base, remote_sub)
            print(f"\n== {d}  ->  {remote_dir} ==")
            upload_dir(ftp, local_dir, remote_dir, state, dry_run, force, stats)
    finally:
        if ftp is not None:
            try:
                ftp.quit()
            except Exception:
                ftp.close()
        # Salva lo stato anche in caso di errore a meta': i file gia' caricati restano registrati.
        if not dry_run:
            save_manifest(state_path, state)

    print(f"\n{'[DRY-RUN] ' if dry_run else ''}Completato: "
          f"{stats['caricati']} caricati, {stats['invariati']} invariati, "
          f"{stats['esclusi']} esclusi.")


if __name__ == "__main__":
    main()
