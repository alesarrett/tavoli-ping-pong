#!/usr/bin/env python3
"""
Scarica una tantum i confini amministrativi (regioni, province, comuni)
d'Italia via Overpass API, e li salva come GeoJSON in boundaries/.
generate_geojson.py li usa per il naming/filtri automatici (contenimento
punto-in-poligono fatto in locale con shapely, senza query di rete
ripetute per ogni tavolo).

Da rilanciare solo se i confini cambiano (fusioni di comuni, nuova
provincia, ecc.) - NON ad ogni generazione del geojson dei tavoli.
boundaries/ e' in .gitignore: e' dato derivato e voluminoso, non va
committato.

Le aree verdi (parchi/giardini) NON vengono scaricate qui: sono troppe
su scala nazionale rispetto al numero di tavoli che devono contenerle
(centinaia di migliaia contro poche centinaia) - generate_geojson.py fa
invece un lookup mirato per singolo tavolo, con una cache che evita di
ripeterlo ad ogni rigenerazione. Vedi CLAUDE.md.
"""

import json
import os

import osm2geojson

from osm_common import ITALY_AREA_ID, REGIONI, fetch_overpass_json

OUTPUT_DIR = "boundaries"

# I confini condivisi tra comuni/province sono spesso spezzati su piu'
# way: osm2geojson.json2geojson() si occupa di riassemblare gli anelli
# delle relation multipolygon (ruoli inner/outer) in Polygon/MultiPolygon
# GeoJSON validi, cosa non banale da rifare a mano.
COMUNI_QUERY = """
    [out:json][timeout:300];
    area({area_id})->.searchArea;
    relation["admin_level"="8"]["boundary"="administrative"](area.searchArea);
    out geom;
"""

PROVINCE_QUERY = """
    [out:json][timeout:300];
    area({area_id})->.searchArea;
    relation["admin_level"="6"]["boundary"="administrative"](area.searchArea);
    out geom;
"""

REGIONI_QUERY = f"""
    [out:json][timeout:300];
    area({ITALY_AREA_ID})->.searchArea;
    relation["admin_level"="4"]["boundary"="administrative"]["ISO3166-2"~"^IT-"](area.searchArea);
    out geom;
"""


# Query lunga e rara: vale la pena essere pazienti sui retry (a
# differenza di generate_geojson.py, che gira spesso e deve restare
# reattivo). Un singolo 429/504 transitorio non deve buttare via
# minuti di lavoro gia' fatto sulle regioni precedenti.
PATIENT_MAX_ATTEMPTS = 5
PATIENT_RETRY_DELAYS = [15, 30, 60, 120]


def fetch_features(query):
    data = fetch_overpass_json(
        query, timeout=330, max_attempts=PATIENT_MAX_ATTEMPTS, retry_delays=PATIENT_RETRY_DELAYS
    )
    return osm2geojson.json2geojson(data)["features"]


def write_geojson(path, features):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, ensure_ascii=False)


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    comuni_path = os.path.join(OUTPUT_DIR, "italia_comuni.geojson")
    province_path = os.path.join(OUTPUT_DIR, "italia_province.geojson")

    print("Scarico i confini delle 20 regioni...")
    regioni_features = fetch_features(REGIONI_QUERY)
    write_geojson(os.path.join(OUTPUT_DIR, "italia_regioni.geojson"), regioni_features)
    print(f"  {len(regioni_features)} regioni scritte")

    comuni_features = []
    province_features = []
    failed = []
    for i, (nome, relation_id) in enumerate(REGIONI.items(), start=1):
        area_id = 3600000000 + relation_id
        print(f"[{i}/{len(REGIONI)}] {nome}...")

        try:
            print("  comuni...")
            comuni_features.extend(fetch_features(COMUNI_QUERY.format(area_id=area_id)))

            print("  province...")
            province_features.extend(fetch_features(PROVINCE_QUERY.format(area_id=area_id)))
        except RuntimeError as error:
            # Non buttare via il lavoro gia' fatto sulle regioni precedenti:
            # salta questa regione (andra' rilanciato lo script per
            # completarla) invece di far crashare tutto il resto.
            print(f"  {nome} saltata dopo troppi errori: {error}")
            failed.append(nome)
            continue

        # Scrittura incrementale ad ogni regione: se il processo si
        # interrompe (crash, kill manuale) il lavoro fatto finora resta
        # comunque salvato su disco.
        write_geojson(comuni_path, comuni_features)
        write_geojson(province_path, province_features)

    print(f"{len(comuni_features)} comuni scritti in {comuni_path}")
    print(f"{len(province_features)} province scritte in {province_path}")
    if failed:
        print(f"Regioni saltate (da ricontrollare rilanciando lo script): {', '.join(failed)}")


if __name__ == "__main__":
    main()
