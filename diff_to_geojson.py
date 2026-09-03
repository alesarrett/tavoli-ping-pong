#!/usr/bin/env python3
"""Genera un GeoJSON del diff (aggiunti/rimossi/modificati) tra due
elements_state.json, per ispezione visiva in QGIS o simile.

Uso tipico, dopo aver lanciato generate_geojson.py e prima di committare:

    python3 diff_to_geojson.py

Confronta di default l'ultimo elements_state.json committato (git HEAD)
con quello presente nella working tree (il risultato del run appena fatto,
non ancora committato). Ogni punto in output ha una proprieta' "status"
("added" / "removed" / "modified") su cui categorizzare lo stile in QGIS.
"""
import argparse
import json
import subprocess
import sys


def load_state_from_git(ref, path):
    result = subprocess.run(
        ["git", "show", f"{ref}:{path}"], capture_output=True, text=True
    )
    if result.returncode != 0:
        sys.exit(f"Impossibile leggere {path} da {ref}: {result.stderr.strip()}")
    return json.loads(result.stdout)


def load_state_from_file(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def diff_elements(old_state, new_state):
    old_ids = set(old_state)
    new_ids = set(new_state)
    added = sorted(new_ids - old_ids, key=int)
    removed = sorted(old_ids - new_ids, key=int)
    modified = sorted(
        (
            eid
            for eid in old_ids & new_ids
            if old_state[eid].get("version") != new_state[eid].get("version")
        ),
        key=int,
    )
    return added, removed, modified


def build_feature(element_id, status, old_entry, new_entry):
    entry = new_entry or old_entry
    properties = {
        "id": element_id,
        "status": status,
        "area_verde": entry.get("area_verde"),
    }
    if status == "modified":
        moved = (old_entry.get("lon"), old_entry.get("lat")) != (
            new_entry.get("lon"),
            new_entry.get("lat"),
        )
        properties["moved"] = moved
        if moved:
            properties["old_lon"] = old_entry.get("lon")
            properties["old_lat"] = old_entry.get("lat")
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [entry.get("lon"), entry.get("lat")]},
        "properties": properties,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--old-ref", default="HEAD", help="riferimento git dello stato precedente (default: HEAD)"
    )
    parser.add_argument("--old-path", default="elements_state.json")
    parser.add_argument(
        "--new-path",
        default="elements_state.json",
        help="file con lo stato nuovo (default: working tree, cioe' l'ultimo run)",
    )
    parser.add_argument("-o", "--output", default="diff_tavoli.geojson")
    args = parser.parse_args()

    old_state = load_state_from_git(args.old_ref, args.old_path)
    new_state = load_state_from_file(args.new_path)

    added, removed, modified = diff_elements(old_state, new_state)

    features = []
    for eid in added:
        features.append(build_feature(eid, "added", None, new_state[eid]))
    for eid in removed:
        features.append(build_feature(eid, "removed", old_state[eid], None))
    for eid in modified:
        features.append(build_feature(eid, "modified", old_state[eid], new_state[eid]))

    geojson = {"type": "FeatureCollection", "features": features}
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

    print(
        f"{len(added)} aggiunti, {len(removed)} rimossi, {len(modified)} modificati "
        f"-> {args.output}"
    )


if __name__ == "__main__":
    main()
