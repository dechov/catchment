"""Extract NYC DEP dams from the National Inventory of Dams CSV into GeoJSON.
usage: python pipeline/nid_dams.py nid.csv data/dams.geojson
(get nid.csv from https://nid.sec.usace.army.mil/api/nation/csv)
"""
import csv, json, sys

src, out = sys.argv[1], sys.argv[2]
r = csv.reader(open(src, encoding="utf-8", errors="replace"))
next(r)  # "Data Last Updated" line
h = next(r)
I = {k: i for i, k in enumerate(h)}

def num(v):
    try: return float(v)
    except ValueError: return None

feats = []
for row in r:
    if len(row) < len(h) or row[I["State"]] != "New York":
        continue
    owner = row[I["Owner Names"]]
    if not owner.startswith("NYCDEP DAMS"):
        continue
    yr = row[I["Year Completed"]]
    feats.append({
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [num(row[I["Longitude"]]), num(row[I["Latitude"]])]},
        "properties": {
            "name": row[I["Dam Name"]].strip(),
            "other_names": row[I["Other Names"]].strip() or None,
            "nid_id": row[I["NID ID"]],
            "county": row[I["County"]],
            "river": row[I["River or Stream Name"]] or None,
            "type": row[I["Primary Dam Type"]] or None,
            "year_completed": int(yr) if yr.isdigit() else None,
            "height_ft": num(row[I["NID Height (Ft)"]]),
            "length_ft": num(row[I["Dam Length (Ft)"]]),
            "surface_area_acres": num(row[I["Surface Area (Acres)"]]),
            "normal_storage_acre_ft": num(row[I["Normal Storage (Acre-Ft)"]]),
            "side_of_hudson": "east" if "EAST" in owner else "west",
        },
    })
feats.sort(key=lambda f: (f["properties"]["year_completed"] or 9999))
json.dump({"type": "FeatureCollection",
           "source": "USACE National Inventory of Dams (https://nid.sec.usace.army.mil/)",
           "features": feats}, open(out, "w"), indent=1)
print(len(feats), "dams")
for f in feats:
    p = f["properties"]; print(p["year_completed"], p["name"], p["height_ft"], p["length_ft"])
