# dsh-webgis

**A WebGIS plugin that lets LLMs truly "see" the geographic world.** Built on DeepSeek Harness (DSH), it embeds a full GIS workbench into an AI conversation: models can load map data, understand maps, and run spatial analysis through dialogue — with the ultimate goal of **genuinely understanding the 3D world**.

> Read the map → Manipulate the map → Understand the 3D world

## Highlights

- **👁 An AI that reads maps**: capture the map view and feed it to a vision model — even text-only models can "see" the map and answer; any pixel on a screenshot and a longitude/latitude are inter-convertible
- **🗺️ Conversational GIS**: load data, fly to locations, and run spatial analysis all driven by natural language, as the AI calls into a chain of geo-processing tools
- **🚀 Massive data without lag**: from million-row local CSVs to database results in the hundreds of thousands of rows, a tiered rendering pipeline keeps the map fluid (see [Massive Data Loading](#massive-data-loading))
- **🧮 A GIS toolbox**: 36+ AI-callable geo tools — buffers, overlays, kernel density, Moran's I, OD matrices, hex-bin heatmaps …
- **🖌️ Manual workflows too**: interactive drawing of points / lines / polygons, layer management, shp / csv / geojson import & export
- **🔌 Multiple data sources**: PostGIS, local files, and online map services in one place

---

## Massive Data Loading

This is where the plugin works hardest: **data from a few hundred rows to millions of rows should never bog the UI down.** The core idea is to "count first, render in tiers, materialize on demand" instead of shoveling everything into the browser at once.

**Huge local CSVs (DuckDB):**
- A CSV is loaded once into a DuckDB in-memory table with indexes — **1.68 million rows in ~2.7 s in our tests**, with millisecond-level filtering afterwards
- Large files are first shown as a sampled view plus clustering, while the full table stays in memory for later filtering by SQL / conditions / polygon fences
- Built-in memory management (LRU eviction of least-recently-used tables + a memory limit) keeps the browser from OOM-ing

**PostGIS databases:**
- Read-only queries; a `count` is issued first to decide whether and how to load the data
- Non-4326 geometries are automatically wrapped in `ST_Transform`; EWKB geometries are converted to GeoJSON for display
- A `statement_timeout` and read-only transactions at the connection layer keep slow or misdirected queries from stalling the conversation

**Sampling is always transparent**: when a large layer shows only a sample, the layer is labeled "N rows total (sampled)", and any statistics derived from the sample are flagged as such — so the AI never mistakes a sample for the full dataset.

Combined with deck.gl's 3D rendering (hex-bin columns, wall extrusions, OD arcs — all GPU-driven), **hundreds of thousands of rows stay smooth to zoom, filter, and analyze**.

---

## Features

### See it: AI vision understanding
- **GIS mode**: new conversations offer a "Standard / GIS" choice; GIS mode fills the page with a map beside the message panel, and you can switch anytime
- **Snapshot on demand**: the AI uses `webgis_get_pick` to capture the current viewport center as an image along with its geographic extent; wherever the user clicked, the pin location and the hit features can be read directly
- **Vision delegation**: text-only models can "see" too — map screenshots are handed to a vision model that returns a textual description (a vision backend can be configured; with none set, a built-in free anonymous vision endpoint is used, so it works out of the box)
- **Pixel ↔ longitude/latitude**: any point on a screenshot converts to real-world coordinates and back, so the AI can state precisely what lies at the center of the screen

### Compute it: conversational GIS analysis
Once data is loaded, just tell the AI "show this as a hex density heatmap" or "which points fall inside this polygon?" — behind the scenes sit 36+ geo-processing tools that chain together:

- **Construct**: buffer, centroid, convex hull, bounding box, dissolve, simplify, explode, smooth, grid, Voronoi, **OD matrix** (origin–destination lines showing flows)
- **Overlay**: clip, intersect, difference, union
- **Query**: filter by attribute, spatial join, select by location
- **Transform**: reprojection between coordinate systems
- **Spatial statistics**: kernel-density heatmap, average nearest neighbor (ANN), global Moran's I
- **Visualization**: switch render modes — raw points / planar heatmap / **hex-bin heatmap** / **arc / trips / wall / radial**; adjust color, size, and stroke width
- **Attribute editing**: batch-update field values, assign sequential numbers, add columns
- **Layer management**: list, remove, show/hide, inspect layer info and feature stats

Every result appears as a new live layer that the next tool can keep processing, forming a complete analysis chain.

### Draw it: manual drawing & editing
- The layer panel lists all layers (dataset / analysis results / database results / imported) with show-hide and delete support
- The **Create** button expands a drawing toolbar on demand: points / lines / polygons, Bézier-curve smoothing, and snapping to vertices of existing layers
- Right-click a layer to inspect its attribute table, **export geojson / csv / shp**, or delete it
- Import shp (.shp/.zip) / csv / geojson (CSV auto-detects a WKT geometry column, or falls back to lon/lat columns)

### Maps & data services
- **Basemap switcher**: vector basemaps (Carto light / dark / Voyager, OpenFreeMap) plus satellite imagery, one click from the bottom-left corner
- **Online overlay services**: register WMTS / WMS / XYZ services as raster overlays (WMS supports the `{bbox-epsg-3857}` template)
- **Data-source routing**: answer first from the data on screen, and query the configured database only when needed — the AI never guesses

---

## Getting Started

**Requirements**: a DSH install (with the web profile) and `pnpm` on your PATH.

```bash
dsh plugin --profile web add dsh-webgis
# after install, restart with: dsh web, then start a new conversation and pick "GIS mode"
```

**Optional configuration** (Settings → Plugins → WebGIS plugin config, or the plugin config file `cordis.patch.yml`):
- Vision model: vision backend provider / model / baseURL / apiKey (leave unset to use the built-in free fallback)
- PostGIS database: host / port / database / user / password (**the password is stored in DSH's credential store, never written to disk in plaintext**)
- DuckDB thresholds and memory limit

**Try asking:**

> - "Load this `xxx.shp` onto the map"
> - "Are these points spatially clustered? Show them as a hex heatmap"
> - "Filter the points from `dataset A` that fall inside `region B`"
> - "Where is this place?" (the AI captures a screenshot and "looks" at it to answer)

---

## Roadmap: from 2D maps to the 3D world

- **Phase 1 (current milestone): 2D map vision understanding** — the AI reads map content and answers "what is where" and "where is this place"
- **Phase 2 (in progress): conversational operation & analysis** — moving from "seeing" to "computing", closing the loop of load → analyze → visualize
- **Phase 3 (long-term goal): truly understanding the 3D world** — from reading 2D symbols toward real 3D spatial comprehension: recognizing buildings and terrain, judging occlusion and spatial relations, reasoning at real-world scale. Today's 3D visuals (hex columns, wall extrusions, OD arcs) are only the beginning; the aim is to give the AI a genuine "spatial worldview" so it can see, reason, and answer within real 3D scenes.

> Long-term vision: **not merely "describing a picture" — the model truly inhabits spatial cognition, understanding the three-dimensional world behind the map.**
