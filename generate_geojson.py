#!/usr/bin/env python3
"""
Genera un GeoJSON dei tavoli da ping pong (leisure=pitch + sport=table_tennis)
nella regione Veneto, interrogando Overpass API.

Il file prodotto e' pronto per essere importato in uMap
(Gestisci i dati del layer -> Importa dati -> sostituisci) e viene anche
servito direttamente dal frontend Leaflet (index.html) via fetch().
"""

import json
import os
import sys

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from osm_common import VENETO_AREA_ID, fetch_overpass_json

# out geom meta (non solo out geom): "meta" aggiunge version/timestamp per
# elemento, usati per il diff tra esecuzioni (vedi build_elements_state).
OVERPASS_QUERY = f"""
[out:json][timeout:120];
area({VENETO_AREA_ID})->.searchArea;
(
  nwr["leisure"="pitch"]["sport"="table_tennis"](area.searchArea);
);
out geom meta;
"""

# Tag OSM da mostrare nel popup, con etichetta leggibile in italiano,
# nell'ordine in cui devono comparire
POPUP_TAGS = [
    ("material", "Materiale"),
    ("pitch:net", "Rete"),
    ("pitch:net:material", "Materiale rete"),
]

# Traduzione dei valori piu' comuni per questi tag
VALUE_TRANSLATIONS = {
    "yes": "sì",
    "metal": "metallo",
    "concrete": "cemento",
}

# Tag OSM esposti come proprieta' GeoJSON a se stanti (non nella
# description testuale), pensati per il filtraggio lato client nella
# futura interfaccia custom. Nome proprieta' -> tag OSM.
FILTER_PROPERTIES = {
    "material": "material",
    "net": "pitch:net",
    "net_material": "pitch:net:material",
    "access": "access",
    "covered": "covered",
}

# Proprieta' filtro derivate dal contenimento geografico (BOUNDARIES),
# non da tag OSM - vedi find_containment().
GEO_FILTER_PROPERTIES = ("comune", "provincia")

# File con le personalizzazioni manuali (nome, immagini, info extra),
# indicizzate per ID del nodo/way OSM. Vedi overrides.json.
OVERRIDES_PATH = "overrides.json"

# Confini amministrativi e aree verdi scaricati una tantum da
# fetch_boundaries.py, usati per il naming automatico e le proprieta'
# comune/provincia. Se assenti, generate_geojson.py si ferma con un
# messaggio chiaro invece di rifare query di rete per ogni tavolo.
BOUNDARIES_DIR = "boundaries"
BOUNDARY_FILES = {
    "comune": os.path.join(BOUNDARIES_DIR, "veneto_comuni.geojson"),
    "provincia": os.path.join(BOUNDARIES_DIR, "veneto_province.geojson"),
    "area_verde": os.path.join(BOUNDARIES_DIR, "veneto_green.geojson"),
}

# Stato (ID OSM -> versione/coordinate) dell'ultima esecuzione riuscita,
# usato solo per stampare un diff (nuovi/rimossi/modificati) ad ogni run.
ELEMENTS_STATE_PATH = "elements_state.json"

# Base per trasformare i path relativi di overrides.json (campo "images")
# in URL pubblici raggiungibili da uMap (che non ha accesso al filesystem
# locale).
REPO_RAW_BASE = "https://raw.githubusercontent.com/alesarrett/tavoli-ping-pong/main"


def load_overrides(path=OVERRIDES_PATH):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def fetch_elements():
    return fetch_overpass_json(OVERPASS_QUERY, timeout=150)["elements"]


class BoundaryIndex:
    """Indice spaziale (STRtree) su un GeoJSON di poligoni con un tag
    "name", per il contenimento punto-in-poligono in locale."""

    def __init__(self, geojson_path):
        with open(geojson_path, encoding="utf-8") as f:
            data = json.load(f)

        self.geometries = []
        self.names = []
        for feature in data["features"]:
            name = feature["properties"].get("tags", {}).get("name")
            if not name:
                continue
            geometry = shape(feature["geometry"])
            if not geometry.is_valid:
                geometry = geometry.buffer(0)
            self.geometries.append(geometry)
            self.names.append(name)

        self.tree = STRtree(self.geometries)

    def find_containing(self, point):
        candidates = [i for i in self.tree.query(point) if self.geometries[i].contains(point)]
        if not candidates:
            return None
        # Se piu' poligoni contengono il punto (es. un giardino dentro un
        # parco piu' grande), il piu' piccolo e' il piu' specifico.
        best = min(candidates, key=lambda i: self.geometries[i].area)
        return self.names[best]


def load_boundaries():
    missing = [path for path in BOUNDARY_FILES.values() if not os.path.exists(path)]
    if missing:
        raise SystemExit(
            "Confini mancanti in boundaries/: "
            + ", ".join(missing)
            + " - lanciare prima 'python3 fetch_boundaries.py'."
        )
    return {key: BoundaryIndex(path) for key, path in BOUNDARY_FILES.items()}


def build_image_url(relative_path):
    return f"{REPO_RAW_BASE}/{relative_path}"


def build_filter_properties(tags):
    properties = {}
    for prop_name, tag_key in FILTER_PROPERTIES.items():
        value = tags.get(tag_key)
        if value:
            properties[prop_name] = VALUE_TRANSLATIONS.get(value, value)
    return properties


def build_description(tags, images, extra, maps_url):
    lines = []
    for key, label in POPUP_TAGS:
        value = tags.get(key)
        if value:
            value = VALUE_TRANSLATIONS.get(value, value)
            lines.append(f"- **{label}**: {value}")
    for key, value in extra.items():
        lines.append(f"- **{key.capitalize()}**: {value}")
    for relative_path in images:
        # HTML diretto invece della sintassi [[url|{{url}}]]: il rendering
        # di uMap passa comunque da DOMPurify (ALLOWED_TAGS include "a" e
        # "img"), quindi l'HTML sopravvive alla sanitizzazione. Su mobile
        # il trucco basato sulle sostituzioni testuali non produceva un
        # <a> reale attorno all'immagine (verificato: nessuna opzione al
        # tap lungo); l'HTML esplicito evita di dipendere da quell'ordine
        # di sostituzione.
        image_url = build_image_url(relative_path)
        lines.append(
            f'<a href="{image_url}" target="_blank" rel="noopener">'
            f'<img src="{image_url}"></a>'
        )
    if maps_url:
        # Sintassi uMap per i link: [[url|testo]] (non Markdown [testo](url)).
        lines.append(f"[[{maps_url}|Apri in Google Maps]]")
    return "\n".join(lines)


def element_to_geometry(element):
    if element["type"] == "node":
        return {"type": "Point", "coordinates": [element["lon"], element["lat"]]}

    if element["type"] == "way":
        coords = [[pt["lon"], pt["lat"]] for pt in element.get("geometry", [])]
        if len(coords) < 2:
            return None
        if coords[0] == coords[-1]:
            return {"type": "Polygon", "coordinates": [coords]}
        return {"type": "LineString", "coordinates": coords}

    return None  # relation: non gestita, casi rari per questo tag


def representative_coordinates(geometry):
    """(lon, lat) rappresentativo della geometria: il punto stesso per i
    Point, il primo vertice per LineString/Polygon (way) - usato sia per
    il link Google Maps sia per il contenimento comune/provincia/area
    verde, cosi' i due non possono mai disallinearsi."""
    if geometry["type"] == "Point":
        return tuple(geometry["coordinates"])
    if geometry["type"] == "LineString":
        return tuple(geometry["coordinates"][0])
    if geometry["type"] == "Polygon":
        return tuple(geometry["coordinates"][0][0])
    return None


def build_maps_url(geometry):
    """Link universale Google Maps (routing) per la posizione della feature."""
    coordinates = representative_coordinates(geometry)
    if coordinates is None:
        return None
    lon, lat = coordinates
    return f"https://www.google.com/maps/dir/?api=1&destination={lat},{lon}"


def find_containment(geometry, boundaries):
    coordinates = representative_coordinates(geometry)
    if coordinates is None:
        return {}
    lon, lat = coordinates
    point = Point(lon, lat)
    containment = {}
    for key, index in boundaries.items():
        name = index.find_containing(point)
        if name:
            containment[key] = name
    return containment


def build_auto_name(containment):
    comune = containment.get("comune")
    area_verde = containment.get("area_verde")
    if comune and area_verde:
        return f"{comune} - {area_verde}"
    if comune:
        return comune
    return "Tavolo da ping pong"


def element_to_feature(element, geometry, overrides, boundaries):
    tags = element.get("tags", {})
    override = overrides.get(str(element["id"]), {})
    images = override.get("images", [])
    extra = override.get("extra", {})
    maps_url = build_maps_url(geometry)
    containment = find_containment(geometry, boundaries)

    if tags.get("name"):
        name = tags["name"]
    elif override.get("name"):
        name = override["name"]
    else:
        name = build_auto_name(containment)

    properties = {
        "name": name,
        "description": build_description(tags, images, extra, maps_url),
        "images": [build_image_url(path) for path in images],
        "extra": extra,
        "maps_url": maps_url,
    }
    properties.update(build_filter_properties(tags))
    for key in GEO_FILTER_PROPERTIES:
        if containment.get(key):
            properties[key] = containment[key]

    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": properties,
    }


def load_elements_state(path=ELEMENTS_STATE_PATH):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_element_state(element, geometry):
    coordinates = representative_coordinates(geometry)
    return {
        "version": element.get("version"),
        "lon": coordinates[0] if coordinates else None,
        "lat": coordinates[1] if coordinates else None,
    }


def diff_elements(old_state, new_state):
    old_ids = set(old_state)
    new_ids = set(new_state)
    added = sorted(new_ids - old_ids, key=int)
    removed = sorted(old_ids - new_ids, key=int)
    modified = sorted(
        (
            element_id
            for element_id in old_ids & new_ids
            if old_state[element_id].get("version") != new_state[element_id].get("version")
        ),
        key=int,
    )
    return added, removed, modified


def print_diff_summary(added, removed, modified):
    print(
        f"Diff rispetto all'ultima esecuzione: "
        f"+{len(added)} nuovi, -{len(removed)} rimossi, {len(modified)} modificati"
    )
    if added:
        print(f"  nuovi: {', '.join(added)}")
    if removed:
        print(f"  rimossi: {', '.join(removed)}")
    if modified:
        print(f"  modificati: {', '.join(modified)}")


def main():
    elements = fetch_elements()
    overrides = load_overrides()
    boundaries = load_boundaries()
    old_state = load_elements_state()

    features = []
    new_state = {}
    for element in elements:
        geometry = element_to_geometry(element)
        if geometry is None:
            continue
        features.append(element_to_feature(element, geometry, overrides, boundaries))
        new_state[str(element["id"])] = build_element_state(element, geometry)

    print_diff_summary(*diff_elements(old_state, new_state))

    geojson = {"type": "FeatureCollection", "features": features}

    output_path = sys.argv[1] if len(sys.argv) > 1 else "tavoli_veneto.geojson"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

    with open(ELEMENTS_STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(new_state, f, ensure_ascii=False, indent=2)

    print(f"Scritte {len(features)} feature su {len(elements)} elementi in {output_path}")


if __name__ == "__main__":
    main()
