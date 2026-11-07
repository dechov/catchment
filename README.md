# Catchment

A 3D, scrubbable history of New York City's water supply: reservoirs, dams, aqueducts and tunnels, from the Croton system of the 1830s to the Delaware Aqueduct bypass, rendered for the web.

Plan: [NYC Water History in 3D](https://claude.ai/artifact/7ar4CxqWiGdjeNMVFFmz3P). The MVP covers the whole system at low fidelity, with the Ashokan valley reconstructed in detail.

## Run the 3D scene

```sh
cd web
npm install
npm run dev        # then open the printed localhost URL
```

Drag the time bar or press play to watch 1830 to 2030. The buttons at the top right fly to the whole system, Ashokan, the Croton watershed, or the city. The URL keeps the year and view, so `?t=1913&view=ashokan` opens on Ashokan filling. Add `q=low` for a lighter mesh on slow machines.

`pipeline/export_web.py` writes the scene's data into `web/public/data/`: Terrarium-encoded heightmaps, a reservoir-outline mask found from flat water surfaces, the Ashokan before/after terrain, the old-map texture, and `scene.json`.

`pipeline/osm_water.py` adds what comes from OpenStreetMap (raw extracts in `data/osm/`): `water_mask.png`, the region's natural lakes, ponds, rivers and other towns' reservoirs (NYC's own are left to the timeline), and `routes.json`, the real aqueduct and tunnel routes split into cut-and-cover runs (drawn on the ground) and rock tunnels (drawn 120 m underground with shafts at the portals, and dotted where seen through the terrain). Data © OpenStreetMap contributors, ODbL.

![Ashokan filling, 1913](docs/scene_ashokan_1913.jpg)


### Detail patches: the valleys before the dams

`pipeline/patches.py` adds seven high-resolution valleys (Croton watershed, Kensico, Schoharie, Rondout, Neversink, Pepacton, Cannonsville), each with the last USGS 1:62,500 survey made before its dam draped over the terrain, as Ashokan already has. Terrain comes from zoom-12 tiles (~30 m, four times the region's resolution), and the region mesh itself is now drawn at full resolution. The maps stay up through the construction years and fade as the last reservoir in the valley fills; a legend checkbox turns them off.

| Valley | Sheets (year) |
| --- | --- |
| Croton | Tarrytown 1893, Carmel 1894, West Point 1899, Stamford 1899 |
| Kensico | Tarrytown 1902, Stamford 1899 |
| Schoharie | Gilboa 1903, Hobart 1904 |
| Rondout | Slide Mountain 1905, Neversink 1910 |
| Neversink | Neversink 1910 |
| Pepacton | Margaretville 1904, Andes 1924, Walton 1925 |
| Cannonsville | Walton 1925, Deposit 1944 |

```sh
python3 -m venv .venv && .venv/bin/pip install rasterio numpy scipy pillow
.venv/bin/python pipeline/patches.py plan  out/patches                   # choose sheets via the USGS TNM API
.venv/bin/python pipeline/patches.py fetch out/patches                   # ~120 MB of GeoTIFFs + terrain tiles
.venv/bin/python pipeline/patches.py build out/patches web/public/data
```

## Status: phase 1 (data spike)

| Path | What it is | Source |
| --- | --- | --- |
| `pipeline/terrain.py` | Fetches elevation tiles for a bounding box, writes a 16-bit heightmap, metadata and a hillshade preview | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (mostly USGS 3DEP here) |
| `pipeline/nid_dams.py` → `data/dams.geojson` | The 24 dams owned by NYC DEP: location, height, length, year completed | [National Inventory of Dams](https://nid.sec.usace.army.mil/) |
| `pipeline/build_timeline.py` → `data/timeline.json` | 33 features (reservoirs, aqueducts, tunnels) and 84 dated events | Wikipedia articles cited per feature, plus NID |
| `data/aqueducts.geojson` | **Schematic** aqueduct and tunnel routes, hand-placed waypoints | Approximate, to be replaced by OpenStreetMap geometry |
| `pipeline/preview_map.py` → `docs/alignment_check.png` | Everything drawn over the regional hillshade to check that it lines up | |

### Known gaps

- Years flagged `approx` in `timeline.json` are inferred and need checking against primary sources.
- Aqueduct routes come from OpenStreetMap except City Water Tunnels 1-3, the Delaware bypass and High Bridge, which are still schematic. Tunnel depths are a fixed 120 m, not surveyed.
- Spillway elevations are missing for the smaller Croton reservoirs.
- Modern terrain shows each reservoir as a flat surface. Pre-dam reconstruction (historic USGS topo maps) is the next step for Ashokan.

## Phase 2 (in progress): Ashokan before the dam

`pipeline/ashokan_predam.py` rebuilds the Esopus valley under Ashokan Reservoir as it was before filling began in 1912. It masks the reservoir's flat surface in modern terrain, removes the Olive Bridge Dam, and drops the old Esopus Creek and Beaver Kill (hand-traced from the 1903 and 1905 USGS sheets into `data/ashokan_thalwegs.geojson`) to their old beds. It then fills the basin between those creeks and the shoreline. The deepest point comes out at 57 m below today's water level; the published maximum depth is 190 ft (58 m).

![Ashokan before and after](docs/ashokan_before_after.jpg)

`pipeline/compare_contours.py` draws the reconstruction's 20 ft contours (magenta) over the old maps to check it against the survey: [docs/ashokan_contour_check.jpg](docs/ashokan_contour_check.jpg).

Limits: the valley floor between the creeks is interpolated, not surveyed, so small hills and terraces under the water are missing. Which way the Beaver Kill flowed in the east basin is uncertain (both ends are lower than Ashton in the middle).

## Regenerating the data

```sh
pip install numpy pillow
curl -o nid.csv https://nid.sec.usace.army.mil/api/nation/csv
python pipeline/nid_dams.py nid.csv data/dams.geojson
python pipeline/build_timeline.py
python pipeline/terrain.py region 12 -75.55 40.5 -73.45 42.45 out/terrain out/tiles   # ~28 m/px, ~775 tiles
python pipeline/terrain.py ashokan 14 -74.33 41.90 -74.04 42.02 out/terrain out/tiles # ~7 m/px
python pipeline/preview_map.py out/terrain docs/alignment_check.png
# pre-dam Ashokan: put NY_Slide Mountain_148515_1905_62500_geo.tif and NY_Rosendale_148354_1903_62500_geo.tif
# (USGS topoView / prd-tnm.s3.amazonaws.com/StagedProducts/Maps/HistoricalTopo/GeoTIFF/NY/) in out/topo
pip install rasterio scipy
python pipeline/ashokan_predam.py out/terrain out/topo
python pipeline/compare_contours.py out/terrain out/ashokan_contour_check.png
python pipeline/render_before_after.py out/terrain out/ashokan_before_after.png
```

Terrain outputs (about 90 MB) are not committed.
