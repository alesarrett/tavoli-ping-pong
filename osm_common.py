"""Costanti e utility condivise tra generate_geojson.py e fetch_boundaries.py."""

import time

import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Relation OSM 365331 = "Italia" (admin_level=2), risolta via Nominatim.
# Vedi il commento analogo in generate_geojson.py sul perche' si usa
# l'area risolta per ID invece di una ricerca per nome.
ITALY_RELATION_ID = 365331
ITALY_AREA_ID = 3600000000 + ITALY_RELATION_ID

# Le 20 regioni italiane (admin_level=4), relation ID risolti via Overpass
# (query su admin_level=4 dentro l'area Italia). Usate solo da
# fetch_boundaries.py per scaricare comuni/province regione per regione
# (una query unica su tutta Italia rischierebbe timeout/limiti di
# dimensione - vedi i commenti in fetch_boundaries.py).
REGIONI = {
    "Abruzzo": 53937,
    "Basilicata": 40137,
    "Calabria": 1783980,
    "Campania": 40218,
    "Emilia-Romagna": 42611,
    "Friuli-Venezia Giulia": 179296,
    "Lazio": 40784,
    "Liguria": 301482,
    "Lombardia": 44879,
    "Marche": 53060,
    "Molise": 41256,
    "Piemonte": 44874,
    "Puglia": 40095,
    "Sardegna": 7361997,
    "Sicilia": 39152,
    "Toscana": 41977,
    "Trentino-Alto Adige": 45757,
    "Umbria": 42004,
    "Valle d'Aosta": 45155,
    "Veneto": 43648,
}

HEADERS = {
    # Overpass API rifiuta (406) le richieste con uno User-Agent generico
    # (es. quello di default di "requests"); ne serve uno descrittivo.
    "User-Agent": "MappaTavoliItalia/1.0 (script generazione GeoJSON tavoli ping pong)",
}

MAX_ATTEMPTS = 3
RETRY_DELAYS = [10, 30, 60]


def fetch_overpass_json(query, timeout=90, max_attempts=MAX_ATTEMPTS, retry_delays=RETRY_DELAYS):
    """POST una query Overpass QL con retry sugli errori transitori del
    server pubblico (timeout/rate-limit sotto carico, osservati durante
    lo sviluppo anche per query modeste - non legati alla dimensione
    della query in se'). max_attempts/retry_delays sono personalizzabili
    per chi chiama vuole essere piu' paziente (es. fetch_boundaries.py,
    che gira raramente e puo' permettersi attese lunghe)."""
    last_error = None
    for attempt in range(max_attempts):
        try:
            response = requests.post(
                OVERPASS_URL, data={"data": query}, headers=HEADERS, timeout=timeout
            )
            response.raise_for_status()
            data = response.json()
            # Overpass puo' rispondere HTTP 200 con JSON valido ma un
            # campo "remark" che segnala un errore di runtime (es. la
            # query e' andata in timeout server-side prima di finire) -
            # gli elementi restituiti in quel caso sono parziali/vuoti,
            # non un risultato legittimo. raise_for_status() non lo vede
            # perche' lo status HTTP e' comunque 200.
            if "remark" in data:
                raise RuntimeError(data["remark"])
            return data
        except (requests.RequestException, ValueError, RuntimeError) as error:
            last_error = error
            if attempt < max_attempts - 1:
                delay = retry_delays[min(attempt, len(retry_delays) - 1)]
                print(f"  tentativo {attempt + 1} fallito ({error}), riprovo tra {delay}s...")
                time.sleep(delay)
    raise RuntimeError(f"Impossibile scaricare i dati da Overpass: {last_error}")
