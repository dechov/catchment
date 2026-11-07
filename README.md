# Catchment

A 3D, scrubbable history of New York City's water supply: reservoirs, dams, aqueducts and tunnels, from the Croton system of the 1830s to the Delaware Aqueduct bypass, rendered for the web.

Plan: [NYC Water History in 3D](https://claude.ai/artifact/7ar4CxqWiGdjeNMVFFmz3P). The MVP covers the whole system at low fidelity, with the Ashokan valley reconstructed in detail.

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
- Aqueduct routes are schematic. OpenStreetMap (Overpass) could not be reached from the build environment.
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
