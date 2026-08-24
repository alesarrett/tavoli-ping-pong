#!/usr/bin/env python3
"""
Genera un GeoJSON dei tavoli da ping pong (leisure=pitch + sport=table_tennis)
in tutta Italia, interrogando Overpass API.

Il file prodotto e' pronto per essere importato in uMap
(Gestisci i dati del layer -> Importa dati -> sostituisci) e viene anche
servito direttamente dal frontend Leaflet (index.html) via fetch().
"""

import json
import os
import sys
import time

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from osm_common import ITALY_AREA_ID, fetch_overpass_json

# out geom meta (non solo out geom): "meta" aggiunge version/timestamp per
# elemento, usati per il diff tra esecuzioni (vedi build_elements_state).
# Timeout alto: una query su tutta Italia impiega circa un minuto anche
# se il risultato e' piccolo (poche centinaia di elementi) - il costo e'
# nella risoluzione del confine nazionale stesso, non nella query. Un
# tentativo di sostituirla con una bounding box (piu' leggera da
# risolvere in teoria) e' risultato in pratica ALTRETTANTO lento sotto
# carico del server pubblico - mantenuta quella per area, gia' provata
# affidabile piu' volte.
OVERPASS_QUERY = f"""
[out:json][timeout:240];
area({ITALY_AREA_ID})->.searchArea;
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

# Proprieta' filtro derivate dal contenimento geografico, non da tag OSM.
# comune/provincia/regione vengono da BOUNDARIES (contenimento locale);
# l'area verde no - vedi find_green_area().
GEO_FILTER_PROPERTIES = ("comune", "provincia", "regione")

# File con le personalizzazioni manuali (nome, immagini, info extra),
# indicizzate per ID del nodo/way OSM. Vedi overrides.json.
OVERRIDES_PATH = "overrides.json"

# Confini amministrativi scaricati una tantum da fetch_boundaries.py,
# usati per il naming/filtri automatici (comune/provincia/regione). Se
# assenti, generate_geojson.py si ferma con un messaggio chiaro invece
# di rifare query di rete per ogni tavolo. Le aree verdi (parchi/
# giardini) NON sono qui: troppe su scala nazionale rispetto al numero
# di tavoli - vedi find_green_area() piu' sotto per il lookup mirato.
BOUNDARIES_DIR = "boundaries"
BOUNDARY_FILES = {
    "comune": os.path.join(BOUNDARIES_DIR, "italia_comuni.geojson"),
    "provincia": os.path.join(BOUNDARIES_DIR, "italia_province.geojson"),
    "regione": os.path.join(BOUNDARIES_DIR, "italia_regioni.geojson"),
}

# Tag "leisure" che contano come area verde per il naming automatico
# ("Comune - Area verde"). "nature_reserve" escluso deliberatamente: di
# solito non ha attrezzature come un tavolo da ping pong.
GREEN_AREA_LEISURE_TAGS = "^(park|garden|recreation_ground)$"
GREEN_AREA_SEARCH_RADIUS_M = 150
# Pausa dopo ogni query "around" per l'area verde, per non stressare il
# server pubblico con centinaia di richieste ravvicinate (solo i tavoli
# nuovi/spostati la richiedono davvero - vedi resolve_area_verde()).
GREEN_AREA_REQUEST_DELAY_S = 0.3

GREEN_AREA_QUERY = """
[out:json][timeout:30];
nwr(around:{radius},{lat},{lon})["leisure"~"{tags}"];
out geom;
"""

# Stato (ID OSM -> versione/coordinate/area verde) dell'ultima esecuzione
# riuscita. Serve a due cose: stampare un diff (nuovi/rimossi/modificati)
# ad ogni run, ED evitare di ripetere il lookup Overpass dell'area verde
# (find_green_area) per un tavolo la cui posizione non e' cambiata dalla
# volta scorsa - altrimenti ogni rigenerazione richiederebbe una query
# per ciascuno dei ~600+ tavoli, anche solo per editare un override.
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
    # Piu' pazienza del default (query nazionale unica, lenta anche in
    # condizioni normali per la risoluzione del confine - vedi sopra;
    # sotto carico del server pubblico puo' richiedere piu' di 3 tentativi).
    return fetch_overpass_json(
        OVERPASS_QUERY, timeout=270, max_attempts=6, retry_delays=[15, 30, 60, 90, 120]
    )["elements"]


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
        # Se piu' poligoni contengono il punto (raro per comune/
        # provincia/regione, che non si sovrappongono), il piu' piccolo
        # e' il piu' specifico.
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


def build_description_lines(tag_lines, images, extra, maps_url, osm_url):
    """Coda comune di build_description()/build_description_from_properties():
    le righe extra/immagini/link, che non dipendono da dove vengono le
    righe sui tag (OSM grezzi o proprieta' gia' tradotte dell'output)."""
    lines = list(tag_lines)
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
    if osm_url:
        lines.append(f"[[{osm_url}|Apri su OpenStreetMap]]")
    return "\n".join(lines)


def build_description(tags, images, extra, maps_url, osm_url):
    tag_lines = []
    for key, label in POPUP_TAGS:
        value = tags.get(key)
        if value:
            value = VALUE_TRANSLATIONS.get(value, value)
            tag_lines.append(f"- **{label}**: {value}")
    return build_description_lines(tag_lines, images, extra, maps_url, osm_url)


def build_description_from_properties(properties, images, extra, maps_url, osm_url):
    """Come build_description(), ma parte dalle proprieta' piatte gia'
    presenti in un GeoJSON di output invece che dai tag OSM grezzi -
    usata da --overrides-only, che rilegge l'output di un run precedente
    e non ha percio' a disposizione i tag originali dell'elemento."""
    tag_to_property = {tag_key: prop_name for prop_name, tag_key in FILTER_PROPERTIES.items()}
    tag_lines = []
    for tag_key, label in POPUP_TAGS:
        prop_name = tag_to_property.get(tag_key)
        value = properties.get(prop_name) if prop_name else None
        if value:
            tag_lines.append(f"- **{label}**: {value}")
    return build_description_lines(tag_lines, images, extra, maps_url, osm_url)


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
    Point, il primo vertice per LineString/Polygon (way) - usato per il
    link Google Maps, il contenimento comune/provincia/regione e il
    lookup dell'area verde, cosi' i tre non possono mai disallinearsi."""
    if geometry["type"] == "Point":
        return tuple(geometry["coordinates"])
    if geometry["type"] == "LineString":
        return tuple(geometry["coordinates"][0])
    if geometry["type"] == "Polygon":
        return tuple(geometry["coordinates"][0][0])
    return None


def build_maps_url(geometry):
    """Link universale Google Maps che apre sul punto (non avvia il percorso -
    l'utente sceglie poi se navigare) per la posizione della feature."""
    coordinates = representative_coordinates(geometry)
    if coordinates is None:
        return None
    lon, lat = coordinates
    return f"https://www.google.com/maps/search/?api=1&query={lat},{lon}"


def build_osm_url(element):
    """Link alla pagina OSM dell'elemento sorgente (node o way, mai
    relation - vedi element_to_geometry()) cosi' si puo' verificare/
    correggere il dato direttamente alla fonte."""
    return f"https://www.openstreetmap.org/{element['type']}/{element['id']}"


def find_containment(point, boundaries):
    containment = {}
    for key, index in boundaries.items():
        name = index.find_containing(point)
        if name:
            containment[key] = name
    return containment


def find_green_area(lat, lon):
    """Cerca, con una query Overpass ristretta a un piccolo raggio
    (non l'intera Italia - vedi il commento su BOUNDARY_FILES), l'area
    verde che contiene effettivamente il punto. Ritorna (area_verde,
    resolved): resolved=False se il lookup di rete e' fallito (errore
    transitorio) - va distinto da "nessuna area verde trovata", altrimenti
    un blip di rete verrebbe cachato per sempre come esito negativo
    definitivo invece di essere ritentato al prossimo run."""
    query = GREEN_AREA_QUERY.format(
        radius=GREEN_AREA_SEARCH_RADIUS_M, lat=lat, lon=lon, tags=GREEN_AREA_LEISURE_TAGS
    )
    try:
        data = fetch_overpass_json(query, timeout=45)
    except RuntimeError as error:
        print(f"  lookup area verde fallito per ({lat}, {lon}): {error}")
        return None, False
    finally:
        time.sleep(GREEN_AREA_REQUEST_DELAY_S)

    point = Point(lon, lat)
    candidates = []
    for element in data.get("elements", []):
        name = element.get("tags", {}).get("name")
        if not name:
            continue
        geometry = element_to_geometry(element)
        if geometry is None or geometry["type"] != "Polygon":
            continue
        polygon = shape(geometry)
        if not polygon.is_valid:
            polygon = polygon.buffer(0)
        if polygon.contains(point):
            candidates.append((polygon.area, name))

    if not candidates:
        return None, True
    candidates.sort(key=lambda candidate: candidate[0])
    return candidates[0][1], True


def build_auto_name(comune, area_verde):
    if comune and area_verde:
        return f"{comune} - {area_verde}"
    if comune:
        return comune
    return "Tavolo da ping pong"


def element_to_feature(element, geometry, overrides, containment, area_verde):
    tags = element.get("tags", {})
    element_id = str(element["id"])
    override = overrides.get(element_id, {})
    images = override.get("images", [])
    extra = override.get("extra", {})
    maps_url = build_maps_url(geometry)
    osm_url = build_osm_url(element)

    if tags.get("name"):
        name = tags["name"]
    elif override.get("name"):
        name = override["name"]
    else:
        name = build_auto_name(containment.get("comune"), area_verde)

    properties = {
        "id": element_id,
        "name": name,
        "description": build_description(tags, images, extra, maps_url, osm_url),
        "images": [build_image_url(path) for path in images],
        "extra": extra,
        "maps_url": maps_url,
        "osm_url": osm_url,
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


def resolve_area_verde(element_id, lon, lat, old_state, skip_lookup=False):
    """Riusa l'area verde gia' in cache se posizione invariata rispetto
    all'ultima esecuzione E il lookup precedente era andato a buon fine
    (area_verde_resolved) - un lookup fallito in passato va ritentato
    anche a coordinate invariate, non trattato come cache valida.
    Con skip_lookup=True non fa MAI una query di rete: usa la cache se
    c'e', altrimenti lascia l'elemento non risolto (area_verde=None,
    resolved=False) cosi' un run futuro senza questo flag lo ritenta -
    utile per pubblicare in fretta con "solo il comune" dove manca
    l'area verde, senza aspettare un server Overpass sotto carico.
    Ritorna (area_verde, resolved, was_cache_hit)."""
    cached = old_state.get(element_id)
    if (
        cached
        and cached.get("lon") == lon
        and cached.get("lat") == lat
        and cached.get("area_verde_resolved")
    ):
        return cached.get("area_verde"), True, True
    if skip_lookup:
        return None, False, False
    area_verde, resolved = find_green_area(lat, lon)
    return area_verde, resolved, False


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


def write_output(output_path, features, new_state):
    geojson = {"type": "FeatureCollection", "features": features}
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)
    with open(ELEMENTS_STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(new_state, f, ensure_ascii=False, indent=2)


def run_overrides_only(output_path):
    """Riapplica overrides.json (images/extra/description) a un
    tavoli_italia.geojson gia' esistente, senza contattare Overpass.
    Pensata per il caso comune "ho solo aggiunto/cambiato una foto o un
    campo extra" - non serve rifare il fetch nazionale (lento, ~1 minuto
    anche in condizioni normali) solo per questo.

    NON tocca "name": la logica a tre livelli di element_to_feature()
    da' priorita' al tag OSM "name" sull'override, ma qui non abbiamo i
    tag OSM grezzi (solo l'output di un run precedente) per sapere se
    quel livello 1 si applica - toccare il nome rischierebbe di
    sovrascrivere silenziosamente un nome OSM legittimo con l'override.
    Per un cambio di nome, o per un tavolo nuovo/spostato (coordinate,
    area verde, comune/provincia/regione), serve un run completo."""
    if not os.path.exists(output_path):
        raise SystemExit(
            f"{output_path} non esiste: --overrides-only rilegge l'output di un run "
            "completo precedente. Lanciare prima lo script senza questo flag."
        )

    with open(output_path, encoding="utf-8") as f:
        geojson = json.load(f)
    overrides = load_overrides()

    for feature in geojson["features"]:
        properties = feature["properties"]
        override = overrides.get(properties["id"], {})
        images = override.get("images", [])
        extra = override.get("extra", {})
        properties["images"] = [build_image_url(path) for path in images]
        properties["extra"] = extra
        properties["description"] = build_description_from_properties(
            properties, images, extra, properties.get("maps_url"), properties.get("osm_url")
        )

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)
    print(
        f"Modalita' --overrides-only: riapplicati gli override a {len(geojson['features'])} "
        f"feature in {output_path} (nessuna query a Overpass, 'name' non toccato)."
    )


def main():
    # Senza line-buffering i print() restano nel buffer di Python finche'
    # non si riempie o il processo termina, quindi se l'output e' su file
    # (es. "> log.txt 2>&1" in background) non si vede nulla finche' non
    # e' tutto finito - inutile per seguire un run che dura minuti.
    sys.stdout.reconfigure(line_buffering=True)

    args = sys.argv[1:]
    skip_green_lookup = "--skip-green-lookup" in args
    overrides_only = "--overrides-only" in args
    args = [a for a in args if a not in ("--skip-green-lookup", "--overrides-only")]
    output_path = args[0] if args else "tavoli_italia.geojson"

    if overrides_only:
        run_overrides_only(output_path)
        return

    elements = fetch_elements()
    overrides = load_overrides()
    boundaries = load_boundaries()
    old_state = load_elements_state()

    # Difesa in profondita' oltre al controllo del campo "remark" in
    # fetch_overpass_json(): se Overpass torna un risultato molto piu'
    # piccolo di quello dell'ultima esecuzione riuscita, e' quasi
    # certamente un errore parziale, non un vero calo di tavoli - non
    # sovrascrivere l'output/la cache con questo risultato sospetto.
    if old_state and len(elements) < len(old_state) * 0.5:
        raise SystemExit(
            f"Overpass ha restituito solo {len(elements)} elementi, contro i "
            f"{len(old_state)} dell'ultima esecuzione riuscita: troppo pochi per "
            "essere un risultato legittimo (probabile errore/timeout parziale). "
            "Nessun file sovrascritto - controllare e rilanciare."
        )

    features = []
    new_state = {}
    lookups_done = 0
    for i, element in enumerate(elements, start=1):
        geometry = element_to_geometry(element)
        if geometry is None:
            continue

        element_id = str(element["id"])
        coordinates = representative_coordinates(geometry)
        lon, lat = coordinates if coordinates else (None, None)

        containment = find_containment(Point(lon, lat), boundaries) if coordinates else {}

        if coordinates:
            area_verde, resolved, was_cache_hit = resolve_area_verde(
                element_id, lon, lat, old_state, skip_lookup=skip_green_lookup
            )
        else:
            area_verde, resolved, was_cache_hit = None, True, True

        if not was_cache_hit:
            lookups_done += 1

        features.append(element_to_feature(element, geometry, overrides, containment, area_verde))
        new_state[element_id] = {
            "version": element.get("version"),
            "lon": lon,
            "lat": lat,
            "area_verde": area_verde,
            "area_verde_resolved": resolved,
        }

        if not was_cache_hit and lookups_done % 20 == 0:
            print(f"  lookup area verde: {i}/{len(elements)} elementi processati...")
            # Scrittura incrementale: se il processo viene interrotto
            # (kill manuale, crash) il lavoro fatto finora non va perso -
            # e permette anche di ispezionare l'output mentre gira, non
            # solo a fine corsa. Ad ogni ripartenza, gli elementi gia'
            # presenti in questo stato parziale fanno da cache (stessa
            # logica di resolve_area_verde), quindi ripartire dopo
            # un'interruzione non rifa' tutto da zero.
            write_output(output_path, features, new_state)

    print_diff_summary(*diff_elements(old_state, new_state))
    write_output(output_path, features, new_state)
    print(f"Scritte {len(features)} feature su {len(elements)} elementi in {output_path}")


if __name__ == "__main__":
    main()
