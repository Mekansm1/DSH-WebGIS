# dsh-webgis

A WebGIS plugin that lets LLMs truly see the geographic world. Built on DeepSeek Harness (DSH), it embeds a full GIS workbench into an AI conversation: models can load map data, understand maps, and run spatial analysis through dialogue. Its long-term goal is genuine 3D spatial understanding.

Author: Frank Wang · Feedback: [cywanghn@gmail.com](mailto:cywanghn@gmail.com)

## Compatibility

- **Requires DSH `0.2.0`** (built and tested against `0.2.0-rc.2`). This release is **not compatible with earlier harness versions**. If you are on an older DSH, upgrade the harness before updating this plugin.
- Targets the DSH **Web profile** and requires the host `webServer` service. The official Desktop transport is not yet supported.
- Install: `npx --yes @deepseek-ai/dsh plugin --profile web add dsh-webgis`
- pnpm ≥ 10 needs no `approve-builds` step: DuckDB ships as the official Node Neo package (`@duckdb/node-api`) with a platform-specific prebuilt binding through optional dependencies. A normal `pnpm install` is sufficient. The platform still has to be one DuckDB Node Neo supports, and packages must be fetchable from the npm registry.

## What's New in 0.2.0

### Harness 0.2.0 adaptation

This release retargets the plugin at DSH `0.2.0`. **No source changes were needed** — every harness API this plugin depends on is unchanged from 0.1.7: the slot registry and its dispatch, the `shell.overlay` and `settings.plugins.tab` slots, the client module-loader protocol that lazy chunks use, the host DOM the GIS layout measures, and the session-list lookup behind the 0.1.5 fix below.

The upgrade was verified by installing both harness versions side by side and diffing their type declarations and client bundles file by file, then confirming typecheck, build, and the full test suite against 0.2.0.

- `@deepseek-ai/cordis` is now `^4.0.4`, matching the peer range the 0.2.0 packages declare. (The previous `^4.0.1` allowed the 4.0.2 we had pinned, so npm never raised it.)
- Everything in the 0.1.5 section below still applies, including the session-alignment fix — 0.2.0 leaves that code untouched.

## What's New in 0.1.5

### Harness 0.1.7 adaptation

Three harness APIs changed in 0.1.7; all three are adapted here.

- **Current-session lookup.** The harness removed `SessionListState.current`. On 0.1.7 the previous lookup silently returned nothing, so the browser half could not tell the host which conversation it was in. The two sides then wrote to different state buckets, and **every tool that waits for the browser to answer — `webgis_get_pick`, `webgis_export_basemap`, `webgis_export_map` — timed out**, while the map itself kept rendering, picking and navigating normally. Resolved through the harness's own `retainedBy.mainView` rule.
- **Plugin settings page.** The `settings.plugin.item` slot was removed — that page is now a read-only inventory of the plugins a deployment ships. The WebGIS card is registered as a tab through `settings.plugins.tab` instead.
- **Vision chain message source.** The shared `'plugin'` message-source kind was removed from the harness vocabulary; the plugin now declares its own kind, which is how the harness documents producers extending that union.

Behaviour note: now that the browser half resolves a real session id, the GIS / traditional mode choice is stored **per conversation** again — it had been collapsing into a single shared slot. Each conversation is selected once.

### Tools: unified and auto-routed

- File loading is one entry point, `webgis_load_dataset`, covering GeoJSON, CSV, shapefile (`.zip` / `.shp`) and GDAL-readable vectors (`.gdb` / `.gpkg` / `.kml` / `.tab` / `.mif` / `.dgn`). CSV options: `lonField`, `latField`, `geometryColumn`, `sourceCrs`, `filter`, `limit`; local `*.csv` wildcards and SSRF-protected remote CSV downloads are supported.
- Attribute filters, location filters, field summaries and spatial filtering/aggregation now **choose their own data path**. A layer displaying a sample is analysed over its full backing data; when the full data is unavailable the tool reports an error instead of quietly answering from the sample.
- CSV `filter` defines the layer's real subset — rendering and later analysis both follow it. `limit` caps displayed rows without discarding data: small files take the first N rows in source order (repeatable), large files sample N at random. Above 100k rows the map renders the complete data by zoom level, and the tool message says so rather than claiming to show N rows.
- Empty style updates are rejected; a partly invalid style update leaves the layer unchanged. Spatial aggregation reports truncated group/grid output explicitly.
- Tool descriptions are shorter and standard GIS operations stay separate. 55 tools are exposed.

| Previous call | Replacement |
| --- | --- |
| `webgis_load_csv({path, ...})` | `webgis_load_dataset({url, ...})` |
| `webgis_set_layer_color({layer, color})` | `webgis_set_layer_style({layer, color})` |
| `webgis_set_attribute({...})` | `webgis_edit_field({action: "set", ...})` |
| `webgis_add_column({...})` | `webgis_edit_field({action: "add", ...})` |
| `webgis_add_sequence({...})` | `webgis_edit_field({action: "sequence", ...})` |

The previous names are no longer registered. `webgis_feature_summary` returns one requested field statistic; `webgis_layer_stats` returns a count/distribution overview — both over the complete layer, independent of the display sample. Geometry-dependent operations still need the DuckDB spatial extension on the full-table path.

### Failures now say what went wrong

- A browser-to-host reply that fails is no longer swallowed. Screenshot and basemap replies used to discard transport errors silently, leaving a bare timeout as the only symptom; a failed reply is now reported back and surfaced as a named error.
- Those timeouts also name their cause — whether the browser never connected, connected but is not attached to this conversation, or is polling normally and simply did not finish the step.

## What's New in 0.1.4

- Added a Worker-based execution path for geometry and spatial-statistics operations, selected by operation-specific workload thresholds.
- Worker jobs forward cancellation signals, enforce time budgets, and terminate on completion, cancellation or timeout. Plugin disposal requests cleanup of active workers and queued jobs.
- Added transferable geometry payloads, bounded job concurrency, shared timeout policies, and regression tests for encoding, dispatch, cancellation and timeouts.
- Added a regular-grid size guard with actionable input guidance.

Scope: small workloads still execute synchronously on the host thread. Workload thresholds do not guarantee that every complex geometry runs off-thread; this release does not promise universally non-blocking execution. Worker payload encoding and result decoding also require host-thread work.

Compatibility: this release targets the DSH **Web profile** and requires the host's `webServer` service. The official Desktop transport is **not yet supported**. That release's DSH `0.1.5-rc1` baseline was superseded in 0.1.5 — see [Compatibility](#compatibility).

## What's New in 0.1.3

- Migrated to DuckDB's official Node Neo driver (`@duckdb/node-api`). Installing the plugin no longer requires compiling the legacy `duckdb` native module, `pnpm approve-builds`, or `pnpm rebuild duckdb`.
- Optimized very large CSV coordinate-point layers: DuckDB reads coordinates in columnar chunks and builds GeoArrow directly, avoiding huge numbers of `{ lon, lat }` JavaScript objects.
- Sampling, viewport culling, empty-view behavior, and picking semantics remain unchanged. Line, polygon, and geometry-column layers continue to use the established WKB conversion path.

## What's New in 0.1.2

- Adapted for DSH `0.1.5-rc1`: retargeted the new shell layout (the conversation moved into the host `main` slot) and migrated to the 0.1.5 package set.
- Export vector features from the basemap. “Export the map data in the current view” extracts real vector-tile features into new point, line, and polygon layers; a request such as “export the rivers” can limit the output to one kind.
- Added a spatial-statistics suite: Gini, Shannon entropy, and Getis-Ord Gi\* hot-spot analysis with Benjamini–Hochberg FDR correction, in addition to Moran's I. Each index inspects fields, reports what it finds, and asks you to confirm inputs before computing.
- Unified click highlighting: polygons use a deep-blue outline and blue fill, lines use a thick blue stroke, and points use blue dots, always rendered on top.

## What's New in 0.1.1

- Fixed the “API key required” watermark on the default Carto raster basemap.
- Fixed Carto vector basemaps (Positron / Dark / Voyager) not rendering.
- Added a Measure tool: line length, snapping to previously drawn vertices, and closing a polygon at its start point to show perimeter and area.
- Improved loading performance for very large SHP files.


## pnpm and the DuckDB runtime

The plugin uses DuckDB's official Node Neo package (`@duckdb/node-api`). It installs a platform-specific prebuilt binding through optional dependencies, so pnpm ≥ 10 does **not** need `pnpm approve-builds` or `pnpm rebuild duckdb`. A normal `pnpm install` is sufficient. The target platform must still be supported by DuckDB Node Neo and be able to download packages from the npm registry.

## Highlights

- 🗺️ Conversational GIS — load data, navigate maps, and run spatial analysis through natural-language tool calls
- 🚀 Smooth massive-data rendering — from million-row local CSV files to database results with hundreds of thousands of rows, a tiered rendering pipeline keeps the map responsive (see [Massive Data Loading](#massive-data-loading))
- 🧮 GIS toolbox — 55 AI-callable tools: buffers, overlays, kernel density, Moran's I, Gini, Shannon entropy, Getis-Ord Gi\*, OD matrices, and hex-bin heatmaps
- 🛰️ Read the basemap too — extract rivers, roads, buildings, place names, and other real vector-basemap features into analysable layers
- 🖌️ Manual workflows — interactively draw points, lines, and polygons; manage layers; import and export SHP / CSV / GeoJSON
- 🔌 Multiple data sources — PostGIS, local files, the basemap itself, and online map services

---

## Quick Start

1. Open DeepSeek Harness and start a new conversation.
2. Select GIS mode.
3. Choose your task workspace.
4. Ask the model, for example: *“Load xxx and show it on the map.”*

---

## Features

### Compute: conversational GIS analysis

Once data is loaded, tell the AI something like *“show this as a hex density heatmap”* or *“which points fall inside this polygon?”*. 55 tools can be chained behind the scenes:

- Construct — buffer, centroid, convex hull, bounding box, dissolve, simplify, explode, smooth, grid, Voronoi, and OD matrices that show origin–destination flows
- Overlay — clip, intersect, difference, and union
- Query — attribute filtering, spatial joins, and selection by location
- Transform — coordinate-system reprojection
- Spatial statistics — kernel-density heatmaps, average nearest neighbor (ANN), global Moran's I with LISA local clusters, Gini, Shannon entropy, and Getis-Ord Gi\* hot-spot analysis
- Visualization — raw points, planar heatmaps, hex-bin heatmaps, arcs, trips, walls, and radial modes; adjust colors, sizes, and stroke widths
- Attribute editing — batch-update field values, assign sequence numbers, and add columns
- Basemap extraction — turn vector-basemap features into layers (see [Reading the Basemap](#reading-the-basemap))
- Layer management — list, remove, show/hide, inspect layer details, and view feature statistics

Every result becomes a new live layer that the next tool can continue to process, forming a complete analysis chain.

Indices ask before computing. Statistical tools follow an *inspect → confirm → compute* loop: a Moran's I request first reports numeric fields, missing-value counts, and the geometry family, then waits for confirmation. If a required parameter is missing, the tool explains what it needs instead of guessing.

### Reading the Basemap

Vector basemaps contain real feature data: waterways, roads, buildings, parks, land use, boundaries, points of interest, and place names. The plugin can extract features from tiles in the current view into normal layers:

> - “Export the map data in the current view” → three layers: points / lines / polygons
> - “Export the rivers in this view” → one layer, with same-named segments merged into one feature

The extracted layers behave like any imported data: measure, buffer, and analyse them. This turns visible map content into layers; it is not bulk extraction. Vector tiles are cut by zoom level, so farther zoom levels expose fewer layers, and POIs/buildings generally appear only at city or street zoom. For bulk data, use Geofabrik or Overpass and import a file.

### Draw: manual drawing and editing

- The layer panel lists datasets, analysis results, database results, and imported layers, with show/hide and delete controls
- The Create button opens a drawing toolbar on demand: points, lines, polygons, Bézier smoothing, and snapping to existing-layer vertices
- Right-click a layer to inspect its attribute table, export GeoJSON / CSV / SHP, or delete it
- Import SHP (`.shp` / `.zip`), CSV, or GeoJSON; CSV automatically detects a WKT geometry column and otherwise tries longitude/latitude columns

### Maps and data services

- Basemap switcher — Carto Light / Dark / Voyager, OpenFreeMap, and satellite imagery, selectable from the lower-left corner
- Online overlay services — register WMTS / WMS / XYZ raster services; WMS supports the `{bbox-epsg-3857}` template
- Data-source routing — prefer data already on screen, and query the configured database only when needed; the AI does not invent data

---

## Massive Data Loading

From hundreds of rows to millions, the UI should remain responsive. The core idea is “count first, render in tiers, materialize on demand”, rather than pushing everything to the browser at once.

Huge local CSV files (DuckDB):

- A CSV is loaded once into a DuckDB in-memory table, with millisecond-level filtering afterwards; 1.68 million rows loaded in roughly 2.7 seconds in our tests
- Large files initially show a sampled view with clustering, while the full table remains in memory for later SQL, conditional, or polygon-fence filtering
- Coordinate point layers read coordinates in DuckDB columnar chunks and build GeoArrow without million-scale JS row objects; the client still controls fetch volume by zoom tier and viewport
- Built-in memory management — LRU table eviction plus a memory limit — helps prevent host OOM failures

PostGIS databases:

- Read-only queries; a `count` is issued first to decide whether and how to load results
- Non-4326 geometries are automatically wrapped in `ST_Transform`; EWKB geometries are converted to GeoJSON for display
- `statement_timeout` and read-only transactions prevent slow or misdirected queries from blocking the conversation

Sampling is always transparent: when a large layer displays only a sample, it is labelled “N rows total (sampled)”, and statistics derived from the sample are flagged as such. The AI should never mistake a sample for the full dataset.

Combined with deck.gl's GPU-driven 3D rendering — hex columns, wall extrusions, and OD arcs — hundreds of thousands of rows remain smooth to zoom, filter, and analyse.

---

## Installation and Configuration

Requirements: **DSH `0.2.0`** with the web profile, plus `pnpm` on your PATH. (0.2.0 is not compatible with earlier harness versions — see [Compatibility](#compatibility).)

```bash
dsh plugin --profile web add dsh-webgis
# After installation restart with: dsh web
# Then start a new conversation and select GIS mode.
```

Optional configuration (Settings → Plugins → the **WebGIS** tab, or the plugin configuration file `cordis.patch.yml`):

- Vision model — provider / model / baseURL / apiKey. Configure this for visual features such as “where is this place?” and reading a map from a screenshot. If the main model is multimodal, the plugin uses it directly and this can remain empty. If the main model is text-only and no vision model is configured, visual tools still return structured coordinate and feature data, but do not analyse images.
- PostGIS database — host / port / database / user / password. Passwords are stored in DSH's credential store and never written to disk in plaintext.
- DuckDB thresholds and memory limit.

### Example prompts

> - “Load this `xxx.shp` onto the map”
> - “Are these points spatially clustered? Show them as a hex heatmap”
> - “Filter the points from `dataset A` that fall inside `region B`”
> - “Export the map data in the current view”
> - “Is the population of these counties clustered, or random?” (runs Moran's I)
> - “Where is this place?” (the AI captures a screenshot and analyses it)

---

## Roadmap: from 2D maps to the 3D world

- Phase 1 (in progress): 2D map-vision understanding — the AI reads map content and answers “what is where” and “where is this place”.
- Phase 2 (in progress): conversational operation and analysis — moving from seeing to computing, closing the load → analyse → visualise loop.
- Phase 3 (long-term): genuine 3D-world understanding — moving from reading 2D symbols to understanding buildings and terrain, occlusion and spatial relations, and real-world-scale reasoning. Today's 3D visuals — hex columns, wall extrusions, and OD arcs — are only the beginning. The goal is for AI to see, reason, and answer within real 3D scenes with a genuine spatial worldview.

> Long-term vision: not merely describing a picture, but giving the model spatial cognition that understands the 3D world behind the map.

> Note: DeepSeek vision models are still evolving quickly, and vision-related features have not yet received extensive deep testing.
