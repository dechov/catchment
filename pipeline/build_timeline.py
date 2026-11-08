"""Build data/timeline.json and data/aqueducts.geojson.

Reservoir and aqueduct dates come from Wikipedia articles (fetched 2026-11-07) and the
National Inventory of Dams (data/dams.geojson). Aqueduct routes are SCHEMATIC: hand-placed
waypoints at known endpoints and crossings, accurate to a few km at best. Replace with
OpenStreetMap geometry when it can be fetched.

usage: python pipeline/build_timeline.py
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WP = "https://en.wikipedia.org/wiki/"
FT = 0.3048

# id, name, system, lon, lat, spillway elevation (m), construction_start, fill_start, in_service, nid dam name, source page
# Years marked in "approx" are inferred, not stated directly in the cited source.
RESERVOIRS = [
    ("croton-distributing", "Croton Distributing Reservoir", "croton", -73.9825, 40.7533, None, 1837, 1842, 1842, None, "Croton_Distributing_Reservoir", {"retired": 1890}),
    ("central-park-lower", "Yorkville Receiving Reservoir", "croton", -73.9690, 40.7795, None, 1837, 1842, 1842, None, "Jacqueline_Kennedy_Onassis_Reservoir", {"retired": 1930}),
    ("central-park-upper", "Central Park Reservoir", "croton", -73.9625, 40.7855, None, 1858, 1860, 1862, None, "Jacqueline_Kennedy_Onassis_Reservoir", {"retired": 1993}),
    ("old-croton", "Croton Lake (Old Croton Dam)", "croton", -73.7900, 41.2400, 49.1, 1837, 1842, 1842, None, "Old_Croton_Dam",
     {"retired": 1906, "drowned_by": "new-croton", "note": "57 ft masonry dam, 670 ft long; submerged 34 ft under New Croton Reservoir since 1906",
      "dam": {"name": "Old Croton Dam", "lon": -73.80056, "lat": 41.23333, "height_ft": 57, "length_ft": 670, "type": "Masonry",
              "crest": [[-73.800319, 41.23423], [-73.800801, 41.23243]]}}),
    ("boyds-corner", "Boyds Corner Reservoir", "croton", -73.7550, 41.4510, None, None, None, 1872, "Boyds Corner Dam", None, {}),
    ("middle-branch", "Middle Branch Reservoir", "croton", -73.6440, 41.4110, None, None, None, 1878, "Middle Branch Dam", None, {}),
    ("west-branch", "West Branch Reservoir", "croton", -73.7000, 41.4250, 490 * FT, None, None, 1895, "West Branch Dam", "West_Branch_Reservoir", {}),
    ("east-branch", "East Branch Reservoir", "croton", -73.5912, 41.3970, None, None, None, 1891, "Sodom Dam", "East_Branch_Reservoir", {}),
    ("bog-brook", "Bog Brook Reservoir", "croton", -73.5858, 41.4157, None, None, None, 1892, "Bog Brook Dam #1", "Bog_Brook_Reservoir", {}),
    ("titicus", "Titicus Reservoir", "croton", -73.6150, 41.3250, None, None, None, 1895, "Titicus Dam", None, {}),
    ("amawalk", "Amawalk Reservoir", "croton", -73.7520, 41.2880, None, None, None, 1897, "Amawalk Dam", None, {}),
    ("jerome-park", "Jerome Park Reservoir", "croton", -73.8956, 40.8778, None, 1895, 1905, 1906, None, "Jerome_Park_Reservoir", {"approx": ["construction_start", "fill_start"]}),
    ("new-croton", "New Croton Reservoir", "croton", -73.8398, 41.2330, 194 * FT, 1892, 1905, 1906, "New Croton Reservoir Dam", "New_Croton_Reservoir", {"approx": ["fill_start"]}),
    ("muscoot", "Muscoot Reservoir", "croton", -73.7070, 41.2690, None, None, None, 1905, "Muscoot Dam", "Muscoot_Reservoir", {}),
    ("cross-river", "Cross River Reservoir", "croton", -73.6400, 41.2700, None, None, None, 1908, "Cross River Dam", None, {}),
    ("croton-falls", "Croton Falls Reservoir", "croton", -73.6600, 41.3900, None, None, None, 1910, "Croton Falls Dam", None, {}),
    ("diverting", "Diverting Reservoir", "croton", -73.6299, 41.3837, None, None, None, 1911, "Diverting Reservoir Dam", "Diverting_Reservoir", {}),
    ("ashokan", "Ashokan Reservoir", "catskill", -74.2170, 41.9500, 585 * FT, 1907, 1912, 1915, "Ashokan Dam", "Ashokan_Reservoir", {"fill_end": 1914}),
    ("kensico", "Kensico Reservoir", "catskill", -73.7639, 41.0861, 108, 1913, 1915, 1917, "Kensico Dam", "Kensico_Reservoir", {"approx": ["fill_start"], "note": "old Kensico dam (1885) demolished from 1911"}),
    ("old-kensico", "Kensico Reservoir (1885)", "croton", -73.7620, 41.0820, 70.1, 1881, 1885, 1885, None, "Kensico_Reservoir",
     {"retired": 1915, "drowned_by": "kensico", "approx": ["construction_start"],
      "note": "Bronx River dammed for the Croton system; level 230 ft from the 1893 USGS sheet; drowned by the new Kensico Reservoir",
      "dam": {"name": "Kensico Dam (1885)", "lon": -73.76985, "lat": 41.07275, "height_ft": 40, "length_ft": 600, "type": "Masonry", "approx": True}}),
    ("hillview", "Hillview Reservoir", "catskill", -73.8692, 40.9122, 90, 1909, 1915, 1915, None, "Hillview_Reservoir", {"approx": ["fill_start"]}),
    ("schoharie", "Schoharie Reservoir", "catskill", -74.4398, 42.3712, 343, 1919, 1924, 1926, "Gilboa Dam", "Schoharie_Reservoir", {"approx": ["construction_start", "fill_start"], "fill_end": 1924}),
    ("rondout", "Rondout Reservoir", "delaware", -74.4710, 41.8226, 255, 1937, 1950, 1951, "Merriman Dam", "Rondout_Reservoir", {"approx": ["fill_start"]}),
    ("neversink", "Neversink Reservoir", "delaware", -74.6389, 41.8258, 439, 1941, 1953, 1954, "Neversink Reservoir Dam", "Neversink_Reservoir", {"approx": ["construction_start", "in_service"]}),
    ("pepacton", "Pepacton Reservoir", "delaware", -74.8222, 42.0889, 390, 1947, 1954, 1955, "Downsville Dam", "Pepacton_Reservoir", {"approx": ["construction_start"], "fill_end": 1955}),
    ("cannonsville", "Cannonsville Reservoir", "delaware", -75.2726, 42.1114, 1148 * FT, 1955, 1963, 1964, "Cannonsville Dam", "Cannonsville_Reservoir", {"approx": ["construction_start", "fill_start"], "fill_end": 1967}),
]

# id, name, system, kind, construction_start, in_service, retired, source page, waypoints (lon, lat)
AQUEDUCTS = [
    ("old-croton-aqueduct", "Old Croton Aqueduct", "croton", "aqueduct", 1837, 1842, 1955, "Croton_Aqueduct",
     [(-73.862, 41.226), (-73.862, 41.163), (-73.863, 41.075), (-73.880, 40.945), (-73.930, 40.842), (-73.969, 40.7795), (-73.9825, 40.7533)]),
    ("high-bridge", "High Bridge (aqueduct bridge over the Harlem River)", "croton", "bridge", 1839, 1848, 1949, "High_Bridge_(New_York_City)",
     [(-73.9285, 40.8435), (-73.9315, 40.8410)]),
    ("new-croton-aqueduct", "New Croton Aqueduct", "croton", "tunnel", 1885, 1890, None, "New_Croton_Aqueduct",
     [(-73.858, 41.226), (-73.850, 41.130), (-73.858, 41.010), (-73.890, 40.900), (-73.8956, 40.8778), (-73.950, 40.818)]),
    ("catskill-aqueduct", "Catskill Aqueduct", "catskill", "aqueduct", 1907, 1916, None, "Catskill_Aqueduct",
     [(-74.205, 41.945), (-74.130, 41.830), (-74.080, 41.680), (-74.040, 41.460), (-73.985, 41.430), (-73.940, 41.400), (-73.820, 41.240), (-73.7639, 41.0861), (-73.8692, 40.9122)]),
    ("shandaken-tunnel", "Shandaken Tunnel", "catskill", "tunnel", 1916, 1924, None, "Shandaken_Tunnel",
     [(-74.438, 42.310), (-74.400, 42.200), (-74.380, 42.120)]),
    ("city-tunnel-1", "City Water Tunnel No. 1", "catskill", "tunnel", 1911, 1917, None, "New_York_City_Water_Tunnel_No._3",
     [(-73.8692, 40.9122), (-73.900, 40.850), (-73.945, 40.800), (-73.985, 40.740), (-73.990, 40.690)]),
    ("city-tunnel-2", "City Water Tunnel No. 2", "catskill", "tunnel", 1929, 1936, None, "New_York_City_Water_Tunnel_No._3",
     [(-73.8692, 40.9122), (-73.860, 40.830), (-73.880, 40.750), (-73.940, 40.690), (-74.010, 40.640), (-74.060, 40.610)]),
    ("delaware-aqueduct", "Delaware Aqueduct", "delaware", "tunnel", 1939, 1944, None, "Delaware_Aqueduct",
     [(-74.4475, 41.8360), (-74.360, 41.760), (-74.150, 41.640), (-73.975, 41.570), (-73.950, 41.555), (-73.700, 41.425), (-73.7639, 41.0861), (-73.8692, 40.9122)]),
    ("east-delaware-tunnel", "East Delaware Tunnel", "delaware", "tunnel", 1942, 1955, None, "Pepacton_Reservoir",
     [(-74.820, 42.075), (-74.650, 41.960), (-74.500, 41.850)]),
    ("west-delaware-tunnel", "West Delaware Tunnel", "delaware", "tunnel", 1955, 1964, None, "Cannonsville_Reservoir",
     [(-75.250, 42.080), (-74.950, 41.990), (-74.700, 41.900), (-74.520, 41.860)]),
    ("neversink-tunnel", "Neversink Tunnel", "delaware", "tunnel", 1941, 1954, None, "Neversink_Reservoir",
     [(-74.620, 41.810), (-74.540, 41.830), (-74.500, 41.840)]),
    ("city-tunnel-3", "City Water Tunnel No. 3", "modern", "tunnel", 1970, 1998, None, "New_York_City_Water_Tunnel_No._3",
     [(-73.8692, 40.9122), (-73.880, 40.830), (-73.940, 40.770), (-73.955, 40.760), (-73.985, 40.725)]),
    ("delaware-bypass", "Rondout-West Branch bypass tunnel", "modern", "tunnel", 2013, None, None, "Delaware_Aqueduct",
     [(-73.995, 41.580), (-73.975, 41.570), (-73.950, 41.555)]),
]

EXTRA_EVENTS = [
    (1799, "Manhattan Company begins supplying well water through wooden pipes", "wells", True),
    (1832, "Cholera epidemic pushes the city toward an outside water source", "wells", True),
    (1842, "Croton water reaches the city (July 4) and is celebrated on October 14", "croton", False),
    (1905, "State Water Supply Act creates the Board of Water Supply", "catskill", True),
    (1931, "U.S. Supreme Court decree allows NYC to divert Delaware River water", "delaware", True),
    (1954, "Amended Supreme Court decree raises the Delaware diversion limit", "delaware", True),
    (2019, "Bypass tunnel under the Hudson finished; hookup to the Delaware Aqueduct still pending", "modern", False),
]


def main():
    dams = {f["properties"]["name"]: f for f in json.load(open(f"{ROOT}/data/dams.geojson"))["features"]}
    features, events = [], []
    for rid, name, system, lon, lat, elev, cs, fs, ins, dam, page, extra in RESERVOIRS:
        d = dams.get(dam) if dam else None
        if d and ins is None:
            ins = d["properties"]["year_completed"]
        rec = dict(id=rid, kind="reservoir", name=name, system=system, lon=lon, lat=lat,
                   spillway_elev_m=round(elev, 1) if elev else None,
                   construction_start=cs, fill_start=fs, fill_end=extra.get("fill_end"), in_service=ins,
                   retired=extra.get("retired"), dam_nid_id=d["properties"]["nid_id"] if d else None,
                   dam_height_ft=d["properties"]["height_ft"] if d else None,
                   dam_length_ft=d["properties"]["length_ft"] if d else None,
                   approx=extra.get("approx", []) + ([] if page else ["in_service"]),
                   source=WP + page if page else "NID year completed",
                   note=extra.get("note"), drowned_by=extra.get("drowned_by"), dam=extra.get("dam"))
        features.append(rec)
    aq_geo = []
    for aid, name, system, kind, cs, ins, ret, page, pts in AQUEDUCTS:
        features.append(dict(id=aid, kind=kind, name=name, system=system, construction_start=cs,
                             in_service=ins, retired=ret, source=WP + page, geometry="data/aqueducts.geojson"))
        aq_geo.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": pts},
                       "properties": {"id": aid, "name": name, "system": system, "kind": kind, "schematic": True}})
    for f in features:
        for key, label in (("construction_start", "construction begins"), ("fill_start", "starts filling"),
                           ("in_service", "in service"), ("retired", "retired")):
            if f.get(key):
                events.append(dict(year=f[key], feature=f["id"], type=key, label=f"{f['name']}: {label}",
                                   system=f["system"], approx=key in f.get("approx", [])))
    for yr, label, system, approx in EXTRA_EVENTS:
        events.append(dict(year=yr, feature=None, type="milestone", label=label, system=system, approx=approx))
    events.sort(key=lambda e: (e["year"], e["label"]))
    json.dump(dict(generated_by="pipeline/build_timeline.py", accessed="2026-11-07",
                   notes="'approx' marks years inferred rather than read from the cited source; verify before presenting.",
                   features=features, events=events),
              open(f"{ROOT}/data/timeline.json", "w"), indent=1)
    json.dump({"type": "FeatureCollection",
               "note": "SCHEMATIC routes from hand-placed waypoints; not surveyed alignments.",
               "features": aq_geo}, open(f"{ROOT}/data/aqueducts.geojson", "w"), indent=1)
    print(len(features), "features,", len(events), "events")


if __name__ == "__main__":
    main()
