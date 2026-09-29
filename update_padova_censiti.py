"""Rigenera padova_censiti.json contando, per ogni OSM id, quante risposte
il Google Form del censimento manutenzione (vedi padova.html/js/padova.js)
ha ricevuto per quel tavolo.

Uso:
    python3 update_padova_censiti.py

Aggiornamento "a scatti", non in tempo reale: va rilanciato a mano ogni
volta che si vuole aggiornare il conteggio mostrato sulla mappa (vedi
CENSITI_URL in js/padova.js), poi va committato il nuovo
padova_censiti.json.

Richiede che il foglio delle risposte del form sia pubblicato come CSV:
nel foglio Google Sheets delle risposte, File -> Condividi -> Pubblica
sul web -> scheda del foglio risposte -> formato CSV -> Pubblica, e
incollare il link ottenuto in padova_censiti_local.py (file locale, non
committato - vedi .gitignore - perche' chiunque avesse quel link
leggerebbe tutte le risposte raccolte).
"""

import csv
import io
import json

import requests

try:
    from padova_censiti_local import CSV_URL
except ImportError:
    raise SystemExit(
        "Manca padova_censiti_local.py: crealo nella cartella del progetto con "
        'CSV_URL = "<link CSV pubblicato del foglio risposte>" (vedi il '
        "docstring di questo script)."
    )

OSM_ID_COLUMN = "ID tavolo (OSM) - non modificare, compilato automaticamente"

OUTPUT_PATH = "padova_censiti.json"


def main():
    response = requests.get(CSV_URL)
    response.raise_for_status()

    reader = csv.DictReader(io.StringIO(response.text))
    counts = {}
    for row in reader:
        osm_id = row.get(OSM_ID_COLUMN, "").strip()
        if not osm_id:
            continue
        counts[osm_id] = counts.get(osm_id, 0) + 1

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(counts.items())), f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Scritti {len(counts)} tavoli con almeno un censimento in {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
