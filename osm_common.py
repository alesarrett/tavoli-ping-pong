"""Costanti e utility condivise tra generate_geojson.py e fetch_boundaries.py."""

import time

import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Relation OSM 43648 = "Veneto" (admin_level=4, ISO3166-2 IT-34), risolta
# via Nominatim. Vedi il commento analogo in generate_geojson.py sul
# perche' si usa l'area risolta per ID invece di una ricerca per nome.
VENETO_RELATION_ID = 43648
VENETO_AREA_ID = 3600000000 + VENETO_RELATION_ID

HEADERS = {
    # Overpass API rifiuta (406) le richieste con uno User-Agent generico
    # (es. quello di default di "requests"); ne serve uno descrittivo.
    "User-Agent": "MappaTavoliVeneto/1.0 (script generazione GeoJSON tavoli ping pong)",
}

MAX_ATTEMPTS = 3
RETRY_DELAYS = [10, 30, 60]


def fetch_overpass_json(query, timeout=90):
    """POST una query Overpass QL con retry sugli errori transitori del
    server pubblico (timeout/rate-limit sotto carico, osservati durante
    lo sviluppo anche per query modeste - non legati alla dimensione
    della query in se')."""
    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            response = requests.post(
                OVERPASS_URL, data={"data": query}, headers=HEADERS, timeout=timeout
            )
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as error:
            last_error = error
            if attempt < MAX_ATTEMPTS - 1:
                delay = RETRY_DELAYS[attempt]
                print(f"  tentativo {attempt + 1} fallito ({error}), riprovo tra {delay}s...")
                time.sleep(delay)
    raise RuntimeError(f"Impossibile scaricare i dati da Overpass: {last_error}")
