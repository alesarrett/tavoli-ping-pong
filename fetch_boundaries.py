#!/usr/bin/env python3
"""
Scarica una tantum i confini amministrativi (comuni, province) e le aree
verdi della regione Veneto via Overpass API, e li salva come GeoJSON in
boundaries/. generate_geojson.py li usa per il naming automatico dei
tavoli (contenimento punto-in-poligono fatto in locale con shapely,
senza query di rete ripetute per ogni tavolo).

Da rilanciare solo se i confini cambiano (fusioni di comuni, nuova
provincia, ecc.) o se si estende l'area coperta a nuove regioni - NON ad
ogni generazione del geojson dei tavoli. boundaries/ e' in .gitignore:
e' dato derivato e voluminoso, non va committato.
"""

import json
import os

import osm2geojson

from osm_common import VENETO_AREA_ID, fetch_overpass_json

OUTPUT_DIR = "boundaries"

# I confini condivisi tra comuni/province sono spesso spezzati su piu'
# way: osm2geojson.json2geojson() si occupa di riassemblare gli anelli
# delle relation multipolygon (ruoli inner/outer) in Polygon/MultiPolygon
# GeoJSON validi, cosa non banale da rifare a mano.
QUERIES = {
    "veneto_comuni.geojson": f"""
        [out:json][timeout:300];
        area({VENETO_AREA_ID})->.searchArea;
        relation["admin_level"="8"]["boundary"="administrative"](area.searchArea);
        out geom;
    """,
    "veneto_province.geojson": f"""
        [out:json][timeout:300];
        area({VENETO_AREA_ID})->.searchArea;
        relation["admin_level"="6"]["boundary"="administrative"](area.searchArea);
        out geom;
    """,
    "veneto_green.geojson": f"""
        [out:json][timeout:300];
        area({VENETO_AREA_ID})->.searchArea;
        (
          way["leisure"~"^(park|garden|nature_reserve|recreation_ground)$"](area.searchArea);
          relation["leisure"~"^(park|garden|nature_reserve|recreation_ground)$"](area.searchArea);
        );
        out geom;
    """,
}

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for filename, query in QUERIES.items():
        print(f"Scarico {filename}...")
        data = fetch_overpass_json(query, timeout=330)
        geojson = osm2geojson.json2geojson(data)
        output_path = os.path.join(OUTPUT_DIR, filename)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(geojson, f, ensure_ascii=False)
        print(f"  {len(geojson['features'])} feature scritte in {output_path}")


if __name__ == "__main__":
    main()
