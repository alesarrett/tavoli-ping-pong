#!/usr/bin/env python3
"""
Genera un GeoJSON dei tavoli da ping pong (leisure=pitch + sport=table_tennis)
nella provincia di Padova, interrogando Overpass API.

Il file prodotto e' pronto per essere importato in uMap
(Gestisci i dati del layer -> Importa dati -> sostituisci).
"""

import json
import os
import sys
import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Relation OSM 44217 = "Provincia di Padova" (admin_level=6, ISO3166-2 IT-PD).
# Usare l'area risolta direttamente (invece della ricerca per nome/admin_level)
# evita che il server debba scansionare tutte le aree amministrative per trovare
# quella giusta: una ricerca per nome su un confine grande come una provincia
# puo' andare in timeout sui server condivisi, con conseguente "Ajax Error"
# lato client anche se il server non e' sovraccarico.
PADOVA_RELATION_ID = 44217
PADOVA_AREA_ID = 3600000000 + PADOVA_RELATION_ID

OVERPASS_QUERY = f"""
[out:json][timeout:60];
area({PADOVA_AREA_ID})->.searchArea;
(
  nwr["leisure"="pitch"]["sport"="table_tennis"](area.searchArea);
);
out geom;
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

# File con le personalizzazioni manuali (nome, immagini, info extra),
# indicizzate per ID del nodo/way OSM. Vedi overrides.json.
OVERRIDES_PATH = "overrides.json"

# Base per trasformare i path relativi di overrides.json (campo "images")
# in URL pubblici raggiungibili da uMap (che non ha accesso al filesystem
# locale).
REPO_RAW_BASE = "https://raw.githubusercontent.com/alesarrett/tavoli-ping-pong/main"


HEADERS = {
    # Overpass API rifiuta (406) le richieste con uno User-Agent generico
    # (es. quello di default di "requests"); ne serve uno descrittivo.
    "User-Agent": "MappaTavoliPadova/1.0 (script generazione GeoJSON tavoli ping pong)",
}


def load_overrides(path=OVERRIDES_PATH):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def fetch_elements():
    response = requests.post(
        OVERPASS_URL, data={"data": OVERPASS_QUERY}, headers=HEADERS, timeout=90
    )
    response.raise_for_status()
    return response.json()["elements"]


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


def build_maps_url(geometry):
    """Link universale Google Maps (routing) per la posizione della feature."""
    if geometry["type"] == "Point":
        lon, lat = geometry["coordinates"]
    elif geometry["type"] == "LineString":
        lon, lat = geometry["coordinates"][0]
    elif geometry["type"] == "Polygon":
        lon, lat = geometry["coordinates"][0][0]
    else:
        return None
    return f"https://www.google.com/maps/dir/?api=1&destination={lat},{lon}"


def element_to_feature(element, overrides):
    geometry = element_to_geometry(element)
    if geometry is None:
        return None

    tags = element.get("tags", {})
    override = overrides.get(str(element["id"]), {})
    images = override.get("images", [])
    extra = override.get("extra", {})
    maps_url = build_maps_url(geometry)

    default_name = tags.get("name", "Tavolo da ping pong")
    name = override.get("name", default_name)

    properties = {
        "name": name,
        "description": build_description(tags, images, extra, maps_url),
        "images": [build_image_url(path) for path in images],
        "extra": extra,
        "maps_url": maps_url,
    }
    properties.update(build_filter_properties(tags))

    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": properties,
    }


def main():
    elements = fetch_elements()
    overrides = load_overrides()

    features = []
    for element in elements:
        feature = element_to_feature(element, overrides)
        if feature is not None:
            features.append(feature)

    geojson = {"type": "FeatureCollection", "features": features}

    output_path = sys.argv[1] if len(sys.argv) > 1 else "tavoli_padova.geojson"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

    print(f"Scritte {len(features)} feature su {len(elements)} elementi in {output_path}")


if __name__ == "__main__":
    main()
