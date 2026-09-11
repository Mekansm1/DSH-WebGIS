# dsh-webgis

A WebGIS plugin that lets LLMs truly "see" the geographic world. Built on DeepSeek Harness (DSH), it embeds a full GIS workbench into an AI conversation: models can load map data, understand maps, and run spatial analysis through dialogue — with the ultimate goal of genuinely understanding the 3D world.

Author: Frank Wang · Feedback: [cywanghn@gmail.com](mailto:cywanghn@gmail.com)

## What's new in 0.1.2

- Adapted for DSH 0.1.5-rc1. Retargeted at the new shell layout (the conversation moved into the host's `main` slot), and migrated to the 0.1.5 package set.
- Export vector features from the basemap. "Export the map data in the current view" pulls the real features out of the vector tiles into new layers — split into point / line / polygon by default, or filtered to a single kind ("export the rivers").
- A spatial-statistics suite. On top of Moran's I: Gini, Shannon entropy, and Getis-Ord Gi\* (hot-spot analysis, with Benjamini–Hochberg FDR correction). Every index first inspects your layer's fields, tells you what it found, and asks you to confirm the inputs before computing.
- Unified click highlight — deep-blue outline with a blue fill for polygons, a heavy blue line for lines, a blue dot for points, always drawn on top.

### What was new in 0.1.1

- Fix the "API key required" watermark on the default Carto raster basemap.
- Fix the Carto vector basemaps (Positron / Dark / Voyager) not rendering.
- Add a Measure tool: line length, auto-snap to the points you have already drawn, and — when you click back on the start point — close a polygon to show its perimeter and area.
- Optimize loading performance for very large SHP files.

Tested against DSH `0.1.5-rc1`.

Install: `npx --yes @deepseek-ai/dsh plugin --profile web add dsh-webgis`

### pnpm note — DuckDB native build

If install reports `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: duckdb@1.4.4`: the plugin depends on DuckDB for huge local files, but its native binding is not compiled automatically when the plugin is installed (pnpm ≥ 10 blocks dependency build scripts by default).

After installing, open a terminal in the profile directory (e.g. `C:\Users\Administrator\.dsh\profiles\web`), allow the build script, then rebuild:

```bash
pnpm approve-builds      # tick / confirm duckdb (double-check duckdb is selected before pressing Enter)
pnpm rebuild duckdb
pnpm install
```

Then confirm `node_modules\duckdb\lib\binding\duckdb.node` exists and restart DSH. Downloading the DuckDB binary needs to reach its binary host (GitHub / official CDN) — on a weak network this step can fail.



## Highlights

- 🗺️ Conversational GIS — load data, fly to locations, and run spatial analysis, all driven by natural language as the AI calls into a chain of geo-processing tools
- 🚀 Massive data without lag — from million-row local CSVs to database results in the hundreds of thousands of rows, a tiered rendering pipeline keeps the map fluid (see [Massive Data Loading](#massive-data-loading))
- 🧮 A GIS toolbox — 60+ AI-callable geo tools: buffers, overlays, kernel density, Moran's I, Gini, Shannon entropy, Getis-Ord Gi\*, OD matrices, hex-bin heatmaps …
- 🛰️ Read the basemap too — the vector basemap's own features (rivers, roads, buildings, place names) can be pulled out into layers and analyzed like any other data
- 🖌️ Manual workflows too — interactive drawing of points / lines / polygons, layer management, shp / csv / geojson import & export
- 🔌 Multiple data sources in one place — PostGIS, local files, the basemap itself, and online map services

---


## Quick Start

1. Open DeepSeek Harness and start a new conversation.
2. Pick GIS mode.
3. Choose your task workspace.
4. Ask the model — for example: *"Load xxx and show it on the map."*

---


## Features

### Compute: conversational GIS analysis

Once data is loaded, just tell the AI *"show this as a hex density heatmap"* or *"which points fall inside this polygon?"* — behind the scenes sit 60+ geo-processing tools that chain together:

- Construct — buffer, centroid, convex hull, bounding box, dissolve, simplify, explode, smooth, grid, Voronoi, OD matrix (origin–destination lines showing flows)
- Overlay — clip, intersect, difference, union
- Query — filter by attribute, spatial join, select by location
- Transform — reprojection between coordinate systems
- Spatial statistics — kernel-density heatmap, average nearest neighbor (ANN), global Moran's I with LISA local clusters, Gini, Shannon entropy, Getis-Ord Gi\* hot-spot analysis
- Visualization — switch render modes: raw points / planar heatmap / hex-bin heatmap / arc / trips / wall / radial; adjust color, size, and stroke width
- Attribute editing — batch-update field values, assign sequential numbers, add columns
- Basemap extraction — turn the vector basemap's own features into layers (see [Reading the basemap](#reading-the-basemap))
- Layer management — list, remove, show/hide, inspect layer info and feature stats

Every result appears as a new live layer that the next tool can keep processing, forming a complete analysis chain.

Indices ask before they compute. Statistics tools work in an *inspect → confirm → compute* loop: ask for a Moran's I, and the tool first reports which fields are numeric, how many values are missing, and which geometry family your layer holds — then waits for you to confirm the inputs before it runs. If a required parameter is missing, it says what it needs instead of guessing.

### Reading the basemap

The vector basemaps carry real feature data — waterways, roads, buildings, parks, land use, boundaries, points of interest, place names. The plugin can lift those features out of the tiles in the current view into ordinary layers:

> - "Export the map data in the current view" → three layers: points / lines / polygons
> - "Export the rivers in this view" → one layer, same-named segments merged into a single feature

From there they behave like any imported data: measure them, buffer them, run statistics on them. Note this is "turn what you can see into a layer", not bulk extraction — vector tiles are cut per zoom level, so the further out you are, the fewer layers exist (POI and buildings only appear at city/street zoom). For bulk data, use Geofabrik or Overpass and import the file.

### Draw: manual drawing & editing

- The layer panel lists all layers (dataset / analysis results / database results / imported), with show-hide and delete support
- The Create button expands a drawing toolbar on demand: points / lines / polygons, Bézier-curve smoothing, and snapping to vertices of existing layers
- Right-click a layer to inspect its attribute table, export geojson / csv / shp, or delete it
- Import shp (.shp/.zip) / csv / geojson (CSV auto-detects a WKT geometry column, or falls back to lon/lat columns)

### Maps & data services

- Basemap switcher — vector basemaps (Carto light / dark / Voyager, OpenFreeMap) plus satellite imagery, one click from the bottom-left corner
- Online overlay services — register WMTS / WMS / XYZ services as raster overlays (WMS supports the `{bbox-epsg-3857}` template)
- Data-source routing — answer first from the data already on screen, and query the configured database only when needed — the AI never guesses

---

## Massive Data Loading

From a few hundred rows to millions of rows, nothing should bog the UI down. The core idea is to "count first, render in tiers, materialize on demand" instead of shoveling everything into the browser at once.

Huge local CSVs (DuckDB):
- A CSV is loaded once into a DuckDB in-memory table with indexes — 1.68 million rows in ~2.7 s in our tests, with millisecond-level filtering afterwards
- Large files are first shown as a sampled view plus clustering, while the full table stays in memory for later filtering by SQL / conditions / polygon fences
- Built-in memory management (LRU eviction of least-recently-used tables + a memory limit) keeps the browser from OOM-ing

PostGIS databases:
- Read-only queries; a `count` is issued first to decide whether and how to load the data
- Non-4326 geometries are automatically wrapped in `ST_Transform`; EWKB geometries are converted to GeoJSON for display
- A `statement_timeout` and read-only transactions at the connection layer keep slow or misdirected queries from stalling the conversation

Sampling is always transparent: when a large layer shows only a sample, the layer is labeled "N rows total (sampled)", and any statistics derived from the sample are flagged as such — so the AI never mistakes a sample for the full dataset.

Combined with deck.gl's 3D rendering (hex-bin columns, wall extrusions, OD arcs — all GPU-driven), hundreds of thousands of rows stay smooth to zoom, filter, and analyze.

---

## Installation & Configuration

Requirements: a DSH install (with the web profile) and `pnpm` on your PATH.

```bash
dsh plugin --profile web add dsh-webgis
# after install, restart with: dsh web, then start a new conversation and pick "GIS mode"
```

Optional configuration (Settings → Plugins → WebGIS plugin config, or the plugin config file `cordis.patch.yml`):
- Vision model — provider / model / baseURL / apiKey. Set this to enable the plugin's vision features ("where is this place?", reading the map from a screenshot). If your main model is itself multimodal, the plugin uses it directly and this can stay empty; if your main model is text-only and no vision model is configured, the vision tools still return their structured coordinate/feature data, they just don't do any picture analysis.
- PostGIS database — host / port / database / user / password (the password is stored in DSH's credential store, never written to disk in plaintext)
- DuckDB thresholds and memory limit

### Example prompts

> - "Load this `xxx.shp` onto the map"
> - "Are these points spatially clustered? Show them as a hex heatmap"
> - "Filter the points from `dataset A` that fall inside `region B`"
> - "Export the map data in the current view"
> - "Is the population of these counties clustered, or is it random?" (runs Moran's I)
> - "Where is this place?" (the AI captures a screenshot and "looks" at it to answer)

---

## Roadmap: from 2D maps to the 3D world

- Phase 1 (in progress): 2D map vision understanding — the AI reads map content and answers "what is where" and "where is this place"
- Phase 2 (in progress): conversational operation & analysis — moving from "seeing" to "computing", closing the loop of load → analyze → visualize
- Phase 3 (long-term goal): truly understanding the 3D world — from reading 2D symbols toward real 3D spatial comprehension: recognizing buildings and terrain, judging occlusion and spatial relations, reasoning at real-world scale. Today's 3D visuals (hex columns, wall extrusions, OD arcs) are only the beginning; the aim is to give the AI a genuine "spatial worldview" so it can see, reason, and answer within real 3D scenes.

> Long-term vision: not merely "describing a picture" — the model truly inhabits spatial cognition, understanding the three-dimensional world behind the map.

> Note: DeepSeek's vision models were released only recently and are still iterating quickly, so the vision-related features have not yet been deeply tested.

---
