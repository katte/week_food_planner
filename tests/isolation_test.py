#!/usr/bin/env python3
"""
Test di isolamento tra spazi, da lanciare contro una copia DI PROVA del sito.

Iscrive due spazi nuovi (A e B), riempie A di dati (piatto con ricetta, ingrediente,
settimana, lista della spesa, scontrino, articolo, impostazioni, un secondo utente) e
controlla che B non possa né vederli né toccarli, neppure indicandone gli id. Poi
controlla che A li abbia ancora tutti e li elimina entrambi (anche se un controllo fallisce).

Uso:
    python tests/isolation_test.py https://www.tuosito.it/wfp-test/ [nome-admin-di-prova]

Con il secondo argomento prova anche la gestione del sito: il nome deve stare in 'admins'
nel config.php della copia di prova (scegline uno lungo e casuale) e non deve esistere;
il test lo iscrive, controlla riepilogo, schede, sola lettura, sospensione, creazione ed
eliminazione di spazi e utenti, e alla fine elimina anche il suo spazio.

Sulla copia di prova conviene alzare 'signups_per_hour' in config.php: ogni giro fa due
o tre iscrizioni, e il limite normale è 3 all'ora per indirizzo.
Non serve nulla oltre alla libreria standard di Python.
"""

import http.cookiejar
import json
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta

PASSWORD = "prova-" + secrets.token_hex(6)
failures = []


class Client:
    """Un browser con i suoi cookie: ognuno è collegato come un utente diverso."""

    def __init__(self, base):
        self.base = base.rstrip("/") + "/api.php"
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, action, body=None, **params):
        url = f"{self.base}?{urllib.parse.urlencode({'action': action, **params})}"
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method="GET" if body is None else "POST")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req, timeout=30) as res:
                return res.status, json.loads(res.read() or b"null")
        except urllib.error.HTTPError as err:
            raw = err.read()
            try:
                return err.code, json.loads(raw)
            except ValueError:
                return err.code, raw.decode(errors="replace")[:200]

    def ok(self, action, body=None, **params):
        status, data = self.call(action, body, **params)
        if status >= 400:
            raise RuntimeError(f"{action}: {status} {data}")
        return data


def check(label, condition, detail=""):
    print(f"  {'ok  ' if condition else 'FAIL'} {label}" + (f"  ({detail})" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def expect_status(client, label, status_wanted, action, body=None, **params):
    status, data = client.call(action, body, **params)
    check(label, status == status_wanted, f"atteso {status_wanted}, avuto {status} {data}")


def receipt(store, product, ingredient, price):
    return {
        "receipt": {
            "negozio": store, "data": (date.today() - timedelta(days=1)).isoformat(), "totale": price,
            "righe": [{"descrizione": product.upper(), "nome": product, "quantita": 1, "prezzo_pagato": price}],
        },
        "choices": {"0": {"product": product, "ingredient": ingredient}},
    }


def admin_checks(base, admin_name, a_name, a2_name, b_name, dish, created):
    print("Gestione del sito")
    M = Client(base)
    me_m = M.ok("signup", {"space": "TEST Gestione", "username": admin_name, "password": PASSWORD,
                           "repeat": PASSWORD, "accept": True})
    created.append(M)
    check("l'amministratore di prova è riconosciuto", me_m["admin"] is True, me_m)
    overview = M.ok("admin-overview")
    by_user = {u: s for s in overview["spaces"] for u in s["users"].split(", ") if u}
    space_a, space_b = by_user.get(a_name), by_user.get(b_name)
    check("riepilogo con gli spazi di A e B", space_a is not None and space_b is not None and overview["stats"]["spaces"] >= 3)
    detail = M.ok("admin-space", id=space_a["id"])
    check("scheda di A: utenti e numeri", sorted(u["name"] for u in detail["users"]) == sorted([a_name, a2_name])
          and detail["counts"]["dishes"] == 1 and detail["counts"]["receipts"] == 1, detail)
    expect_status(M, "il proprio spazio non si sospende", 400, "admin-space-suspend",
                  {"id": by_user[admin_name]["id"], "suspended": True})
    expect_status(M, "il proprio spazio non si elimina da qui", 400, "admin-space-delete", {"id": by_user[admin_name]["id"]})

    # Sola lettura: vede i dati di A, non può cambiare niente, poi torna al suo.
    me_view = M.ok("admin-space-view", {"id": space_a["id"]})
    check("apre A in sola lettura", (me_view["viewing"] or {}).get("id") == space_a["id"], me_view)
    check("vede i piatti di A", any(d["id"] == dish["id"] for d in M.ok("dishes")))
    expect_status(M, "non crea piatti", 403, "dish-create", {"name": "TEST intruso", "category": "altro", "notes": ""})
    expect_status(M, "non cambia impostazioni", 403, "settings-save", {"weekStartDay": 1})
    expect_status(M, "non elimina lo spazio guardato", 403, "space-delete", {"password": PASSWORD})
    me_back = M.ok("view-stop", {})
    check("torna al suo spazio", me_back["viewing"] is None and M.ok("dishes") == [], me_back)

    # Sospensione: chi è collegato esce, nessuno entra, poi si riattiva.
    B2 = Client(base)
    B2.ok("login", {"username": b_name, "password": PASSWORD})
    M.ok("admin-space-suspend", {"id": space_b["id"], "suspended": True})
    status, data = B2.call("me")
    check("spazio sospeso: chi è collegato esce", status == 401 and isinstance(data, dict) and data.get("suspended"), data)
    expect_status(Client(base), "spazio sospeso: non si entra", 403, "login", {"username": b_name, "password": PASSWORD})
    M.ok("admin-space-suspend", {"id": space_b["id"], "suspended": False})
    expect_status(Client(base), "riattivato: si entra di nuovo", 200, "login", {"username": b_name, "password": PASSWORD})

    # Utenti di altri spazi.
    M.ok("admin-user-reset", {"username": a2_name, "password": PASSWORD + "x", "repeat": PASSWORD + "x"})
    expect_status(Client(base), "nuova password data dalla gestione", 200, "login",
                  {"username": a2_name, "password": PASSWORD + "x"})
    M.ok("admin-user-reset", {"username": a2_name, "password": PASSWORD, "repeat": PASSWORD})
    extra = "tc" + secrets.token_hex(3)
    M.ok("admin-user-create", {"id": space_a["id"], "username": extra, "password": PASSWORD, "repeat": PASSWORD})
    me_extra = Client(base).ok("login", {"username": extra, "password": PASSWORD})
    check("utente aggiunto dalla gestione entra nello spazio giusto", me_extra["space"] == space_a["name"], me_extra)
    M.ok("admin-user-delete", {"username": extra})
    expect_status(Client(base), "utente tolto dalla gestione non entra", 401, "login", {"username": extra, "password": PASSWORD})

    # Spazio creato dalla gestione.
    newbie = "tn" + secrets.token_hex(3)
    new_space = M.ok("admin-space-create", {"name": "TEST Creato", "username": newbie, "password": PASSWORD, "repeat": PASSWORD})
    check("spazio creato con il suo utente", new_space["name"] == "TEST Creato" and new_space["users"][0]["name"] == newbie)
    N = Client(base)
    check("il suo utente entra", N.ok("login", {"username": newbie, "password": PASSWORD})["space"] == "TEST Creato")
    expect_status(M, "l'ultimo utente di uno spazio non si toglie", 400, "admin-user-delete", {"username": newbie})
    M.ok("admin-space-delete", {"id": new_space["id"]})
    expect_status(N, "spazio eliminato dalla gestione: fuori", 401, "me")


def main(base, admin_name=None):
    tag = secrets.token_hex(3)
    a_name, a2_name, b_name = f"ta{tag}", f"ta2{tag}", f"tb{tag}"
    A, B = Client(base), Client(base)
    created = []
    try:
        print("Iscrizioni")
        expect_status(A, "senza accettare la privacy no", 400, "signup",
                      {"username": a_name, "password": PASSWORD, "repeat": PASSWORD})
        expect_status(A, "con il campo trappola riempito no", 400, "signup",
                      {"username": a_name, "password": PASSWORD, "repeat": PASSWORD, "accept": True, "website": "x"})
        me_a = A.ok("signup", {"space": "TEST A", "username": a_name, "password": PASSWORD, "repeat": PASSWORD, "accept": True})
        created.append(A)
        me_b = B.ok("signup", {"space": "TEST B", "username": b_name, "password": PASSWORD, "repeat": PASSWORD, "accept": True})
        created.append(B)
        check("A entra nel suo spazio", me_a["user"] == a_name and me_a["space"] == "TEST A", me_a)
        check("B entra nel suo spazio", me_b["user"] == b_name and me_b["space"] == "TEST B", me_b)
        expect_status(Client(base), "nome utente già preso: 409", 409, "signup",
                      {"username": a_name, "password": PASSWORD, "repeat": PASSWORD, "accept": True})
        # Gli spazi che c'erano già (es. i dati migrati) non si vedono da uno spazio nuovo.
        empty = all(A.ok(action) == [] for action in ("dishes", "ingredients", "products", "receipts", "weeks"))
        check("lo spazio nuovo parte vuoto", empty and [u["name"] for u in A.ok("users")] == [a_name])

        print("Dati di A")
        dish = A.ok("dish-create", {"name": "TEST Lasagne", "category": "primo", "notes": ""})
        ingredient = A.ok("ingredient-create", {"name": "TEST pollo", "unit": "kg"})
        A.ok("dish-recipe", {"servings": 4, "lines": [
            {"ingredientId": ingredient["id"], "quantity": 200, "unit": "g", "negligible": None}]}, id=dish["id"])
        week = A.ok("week", week=date.today().isoformat())
        key = week["week"]
        meals = week["meals"]
        meals["mon"]["lunch"] = [{"dishId": dish["id"], "name": dish["name"]}]
        A.ok("week-save", {"meals": meals, "notes": "nota di A",
                           "shopping": [{"text": "mele di A", "category": "frutta", "done": False}]}, week=key)
        A.ok("shopping-term", {"term": "mele di a", "category": "verdura"})
        rec = A.ok("receipt-save", receipt("TEST Negozio A", "TEST Pollo A", "TEST pollo", 5.0))
        product = next(p for p in A.ok("products") if p["name"] == "TEST Pollo A")
        A.ok("settings-save", {"weekStartDay": 3})
        A.ok("user-create", {"username": a2_name, "password": PASSWORD, "repeat": PASSWORD})
        A.ok("account-update", {"email": f"{a_name}@example.invalid"})
        expect_status(A, "la propria password non si reimposta senza quella attuale", 400, "user-reset",
                      {"username": a_name, "password": "senza-vecchia", "repeat": "senza-vecchia"})
        A.ok("user-reset", {"username": a2_name, "password": PASSWORD, "repeat": PASSWORD})

        print("B non vede i dati di A")
        check("piatti", all(d["id"] != dish["id"] for d in B.ok("dishes")))
        check("ingredienti", all(i["id"] != ingredient["id"] for i in B.ok("ingredients")))
        check("articoli", all(p["id"] != product["id"] for p in B.ok("products")))
        check("scontrini", all(r["id"] != rec["id"] for r in B.ok("receipts")))
        check("settimane salvate", B.ok("weeks") == [])
        b_week = B.ok("week", week=date.today().isoformat())
        check("la settimana di B è vuota", b_week["notes"] == "" and b_week["shopping"] == [])
        check("reparti imparati", "mele di a" not in b_week["shoppingTerms"])
        check("giorno di inizio della settimana", B.ok("me")["weekStartDay"] == 0)
        check("utenti dello spazio", [u["name"] for u in B.ok("users")] == [b_name])

        print("B non può toccare i dati di A (404)")
        expect_status(B, "modificare il piatto", 404, "dish-update", {"name": "preso"}, id=dish["id"])
        expect_status(B, "cambiare la ricetta", 404, "dish-recipe", {"servings": 2, "lines": []}, id=dish["id"])
        expect_status(B, "eliminare il piatto", 404, "dish-delete", {}, id=dish["id"])
        expect_status(B, "modificare l'ingrediente", 404, "ingredient-update", {"name": "preso", "unit": "kg"}, id=ingredient["id"])
        expect_status(B, "eliminare l'ingrediente", 404, "ingredient-delete", {}, id=ingredient["id"])
        expect_status(B, "leggere l'articolo", 404, "product", id=product["id"])
        expect_status(B, "modificare l'articolo", 404, "product-update", {"name": "preso"}, id=product["id"])
        expect_status(B, "eliminare l'articolo", 404, "product-delete", {}, id=product["id"])
        expect_status(B, "leggere lo scontrino", 404, "receipt", id=rec["id"])
        expect_status(B, "ricollegare lo scontrino", 404, "receipt-relink", {"lines": []}, id=rec["id"])
        expect_status(B, "eliminare lo scontrino", 404, "receipt-delete", {}, id=rec["id"])
        expect_status(B, "togliere un utente di A", 404, "user-delete", {"username": a_name})
        expect_status(B, "cambiare la password di A", 404, "user-reset",
                      {"username": a_name, "password": "presa-presa", "repeat": "presa-presa"})
        expect_status(B, "pagina di gestione", 403, "admin-overview")
        expect_status(B, "scheda di uno spazio", 403, "admin-space", id="1")
        expect_status(B, "creare spazi", 403, "admin-space-create",
                      {"username": "x" + tag, "password": PASSWORD, "repeat": PASSWORD})
        expect_status(B, "guardare spazi altrui", 403, "admin-space-view", {"id": "1"})
        expect_status(B, "sospendere spazi", 403, "admin-space-suspend", {"id": "1", "suspended": True})
        expect_status(B, "cambiare password altrui", 403, "admin-user-reset",
                      {"username": a_name, "password": "presa-presa", "repeat": "presa-presa"})
        expect_status(B, "eliminare spazi altrui", 403, "admin-space-delete", {"id": "1"})
        expect_status(B, "email già usata da A: 409", 409, "account-update", {"email": f"{a_name}@example.invalid"})

        print("B non può usare gli id di A nei suoi dati")
        b_dish = B.ok("dish-create", {"name": "TEST Lasagne", "category": "primo", "notes": ""})
        check("stesso nome di piatto in spazi diversi", b_dish["name"] == "TEST Lasagne")
        b_dish = B.ok("dish-recipe", {"servings": 2, "lines": [
            {"ingredientId": ingredient["id"], "quantity": 100, "unit": "g", "negligible": None}]}, id=b_dish["id"])
        check("ingrediente di A ignorato nella ricetta di B", b_dish["recipe"] == [], b_dish["recipe"])
        b_week = B.ok("week", week=date.today().isoformat())
        b_meals = b_week["meals"]
        b_meals["tue"]["dinner"] = [{"dishId": dish["id"], "name": "piatto di A?"}]
        saved = B.ok("week-save", {"meals": b_meals, "notes": "", "shopping": []}, week=b_week["week"])
        check("piatto di A nella settimana di B: solo nome", saved["meals"]["tue"]["dinner"] == [{"dishId": None, "name": "piatto di A?"}],
              saved["meals"]["tue"]["dinner"])
        B.ok("receipt-save", receipt("TEST Negozio B", "TEST Pollo B", "TEST pollo", 6.0))
        b_product = next(p for p in B.ok("products") if p["name"] == "TEST Pollo B")
        expect_status(B, "unire il proprio articolo in uno di A", 404, "product-merge", {"into": product["id"]}, id=b_product["id"])

        print("A ha ancora tutto")
        a_dish = next(d for d in A.ok("dishes") if d["id"] == dish["id"])
        check("piatto e ricetta", a_dish["name"] == "TEST Lasagne" and len(a_dish["recipe"]) == 1)
        check("volte pianificato", a_dish["timesPlanned"] == 1, a_dish["timesPlanned"])
        a_ingredient = next(i for i in A.ok("ingredients") if i["id"] == ingredient["id"])
        check("ingrediente", a_ingredient["name"] == "TEST pollo" and a_ingredient["dishes"] == 1)
        check("articolo con il suo acquisto", A.ok("product", id=product["id"])["purchases"] == 1)
        check("scontrino", A.ok("receipt", id=rec["id"])["store"] == "TEST Negozio A")
        # Con l'inizio spostato al giovedì la settimana può essere divisa in due: si cerca in tutte.
        a_weeks = A.ok("weeks")
        check("note e lista della spesa", any(w["notes"] == "nota di A" and w["shopping"][0]["text"] == "mele di A"
                                             for w in a_weeks if w["shopping"]), a_weeks)
        check("il piatto nella settimana", any(e["dishId"] == dish["id"] for w in a_weeks
                                              for day in w["meals"].values() for e in day["lunch"]), a_weeks)
        check("giorno di inizio", A.ok("me")["weekStartDay"] == 3)
        check("utenti", sorted(u["name"] for u in A.ok("users")) == sorted([a_name, a2_name]))

        print("Il secondo utente di A")
        A2 = Client(base)
        me_a2 = A2.ok("login", {"username": a2_name, "password": PASSWORD})
        check("entra nello spazio di A", me_a2["space"] == "TEST A")
        check("vede il piatto di A", any(d["id"] == dish["id"] for d in A2.ok("dishes")))
        expect_status(A2, "password dimenticata: risposta sempre uguale", 200, "password-forgot", {"login": a2_name})
        expect_status(A2, "link non valido", 400, "password-reset", {"token": "x" * 43, "password": PASSWORD, "repeat": PASSWORD})

        if admin_name:
            admin_checks(base, admin_name, a_name, a2_name, b_name, dish, created)

        print("Eliminazione")
        expect_status(A, "password sbagliata: lo spazio resta", 400, "space-delete", {"password": "sbagliata"})
        A.ok("space-delete", {"password": PASSWORD})
        created.remove(A)
        expect_status(A, "A non è più collegato", 401, "me")
        expect_status(A2, "nemmeno il secondo utente di A", 401, "me")
        expect_status(Client(base), "e non può più entrare", 401, "login", {"username": a2_name, "password": PASSWORD})
        check("B ha ancora i suoi dati", any(d["id"] == b_dish["id"] for d in B.ok("dishes")))
    finally:
        for client in created:
            client.call("space-delete", {"password": PASSWORD})

    print(f"\n{'TUTTO OK' if not failures else f'{len(failures)} CONTROLLI FALLITI: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    sys.exit(main(*sys.argv[1:]))
