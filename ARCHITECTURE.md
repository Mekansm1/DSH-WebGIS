# dsh-webgis 架构与代码定位

> 目标：以后改任何一个功能，能快速知道「改哪几个文件、从哪个函数/路由/入口进去」。
> 行号会随迭代漂移，本文尽量给「文件名 + 关键符号/路由」，找代码用 Grep 搜这些锚点即可。

---

## 1. 总体架构

- **插件 = DSH host 侧（Node）+ 客户端（React，跑在 DSH 的浏览器/桌面里）**。
  - host 源码 `src/*.ts`（扁平、按域分文件，见 §2），`tsc` 编译到 `lib/`（插件加载的是 `lib/index.js`）。
  - 客户端源码 `src/client/*.tsx/.ts`，`tsconfig.client.json` + `tsdown` 打包。**不再是一个单文件**：`tsdown.config.ts` 输出 5 个 cfg（shell + 4 个懒 chunk），见 §7。
  - `npm run build`（tsc×2 + tsdown 多 chunk + copy-assets）→ `npm test`（node --test tests/*.test.mjs，测的是编译后的 lib 逐文件产物）。
- host 通过 DSH 提供：`ctx.tools.register(defineTool)`（AI 工具）、`ctx.webServer`（`/webgis/*` HTTP 路由）、`ctx.attachments`（图片附件）、`ctx.llm`（视觉/模型）、settings 卡片、`ctx.on('session/disposed')`。
- 状态模型是「**按会话隔离的一张 WebgisState + 图层注册表**」；客户端**轮询 `/webgis/state`**（加 SSE `/webgis/events` 推送加速）+ **每层 rev/内容签名做变更检测**。
- 客户端首包（shell）**不携带任何重型地图依赖**（maplibre/deck/terra/arrow 全按需分 chunk），详见 §7。

## 2. 模块地图（src/）

### host 侧（Node，按域分文件；`src/index.ts` 只做组装）
| 文件 | 职责 / 关键锚点 |
|---|---|
| `index.ts`（~900 行） | **组装器**：插件声明 + Config schema + `apply(ctx, config)`（会话工厂、seedDataset、SSE 推送、配置装载、工具注册、**表驱动路由分发表** `routeDefs`/`route()` 见 §4）。 |
| `session-state.ts` | `WebgisState`/`SessionStateStore`：每会话 dataset/navigate/pick/capture/exportRequest/exportImage/layers；`emptyWebgisState`、`dispose`。 |
| `route-shared.ts` | `RouteApi`/`RouteDef`/`RouteHandler`/`Seqs` 类型 + `route()` 构造器（表驱动分发契约）。 |
| `routes-*.ts` | 各域路由 handler（`routes-pick/state/layers/export/config/misc`），签名 `(req,res,url,pathname,sessionId,state,api)`。 |
| `wait-utils.ts` | `text`/`delay`/`awaitCurrentViewCapture`/`awaitExportCompletion`（工具等待客户端回传的握手）。 |
| `arrow-cache.ts` | Arrow IPC 分档 LRU 缓存（session→layer→tier）+ `dropLayerResources`（duckTable DROP + 清缓存）。 |
| `http-utils.ts` | `json/jsonError/readBody/notFound/headerString/isTrustedLocalRequest/serveAsset/exportName/download` + 请求体上限常量。 |
| `screenshot-utils.ts` | `modelSupportsImage/screenshotMeta/parseScreenshot/parseViewport/decodeDataUrl`。 |
| `dataset-load.ts` | 文件加载 helper：`countFeatures/parseShapefileBuffer/loadShapefile/loadDataset/loadCsv/loadCsvText/detectWktColumn/csvToFeatures` + `resolveSourceLocal`。 |
| `geo-processing.ts` | **图层注册表模型**：`GisLayer`/`LayerSummary`、`makeResultLayer`、`summarize`、`RESULT_COLORS`、Turf 操作全集（纯，零 ctx）。 |
| `geo-tools-runtime.ts` | `createGeoToolRuntime(stateFor,hooks?)`：geo 工具共享运行时（sess/pushResult/applyMode/applyStyle/各 schema/常量）。 |
| `geo-{construct,overlay,query,vector,stats,layer,info}-tools.ts` | `register*Tools(ctx, rt)` 七域工具；`geo-tools.ts`（~70 行）只保留 `registerGeoTools` 组装 + 系统提示纪律段。 |
| `render-policy.ts` | 渲染分档：`DECK_FROM=10万/CHOICE_FROM=5万`、`pickRenderer`、zoom 档位 `ZOOM_ARROW_TIERS` + `arrowCountForZoom/nextArrowCount`。 |
| `duckdb.ts` | DuckDB 引擎封装（含保留列 `DUCK_RID='__rid'`）、`detectSourceCrs/detectSrids`、`rowsToGeoJSON`。 |
| `duckdb-tools.ts` | CSV/大文件工具 `registerDuckDbTools`、`ingestBigGeojson`、`loadCsvSourceData`、**矢量直读 `loadVectorSourceData`**（本地 .shp/.gdb/.gpkg/.kml/.tab/.mif → DuckDB spatial `ST_Read` 灌表，超大 .shp 不经 shpjs 全量物化）、`geomFamiliesOfWkb`/`geomFamiliesOf`、`VECTOR_SOURCE_EXTS`、几何族抽样；**空间筛选/聚合**：`webgis_spatial_filter`（bbox/dwithin/within_polygon/intersects_layer，结果带 scope/sourceCount/resultCount/displayedCount/note）、`webgis_spatial_aggregate`（grid/attribute）。 |
| `db-tools.ts`/`db-manager.ts`/`postgis.ts` | PostGIS 连接/结构/只读查询 → `db_<n>` 图层。 |
| `geoarrow.ts` | host→GeoArrow IPC 编码（`pointsToGeoArrowTable`/`wkbRowsToGeoArrowTable`/`tableToIpc`）。 |
| `geo-export.ts` | 矢量导出 `toCsv/toGeoJSON/toShpZip`。 |
| `enabled.ts`/`tool-guard.ts` | 启停开关 + 工具守卫 + `isWebgisRouteBlocked` 白名单。 |
| `vision-chain.ts`/`http-fetch.ts`/`webgis-services*.ts`/`basemaps.ts` | 视觉委托链 / 抓取(SSRF) / 叠加服务 / 底图目录。 |

### 客户端（src/client/，按 chunk 归属分组）
| 文件 | 归属 chunk | 职责 |
|---|---|---|
| `index.tsx` | shell | 仅注入 settings 卡 + shell.overlay（GisSurface）。maplibre css 注入已移走。 |
| `GisSurface.tsx`/`webgisMode.ts`/`ModeSelector.tsx` | shell | 模式外壳：进 GIS 才 `ensure('gis')` 懒取 MapView + loading 占位。 |
| `WebgisConfigCard.tsx` 等配置卡 | shell | 启停/视觉/PostGIS/叠加服务设置（无重依赖）。 |
| `chunk-loader.ts` | shell(+各 chunk 副本) | **懒 chunk 加载器**：`ensure(name)`/`registerChunk(name,api)`；窗口级 `__dshWebgisAsync` 单例。见 §7。 |
| `chunks/gis.ts`/`deck.ts`/`draw.ts`/`export.ts` | — | 各懒 chunk 入口：registerChunk + re-export（gis 还注入 maplibre css）。 |
| `MapView.tsx` | gis | 地图核心：建图/轮询+SSE/syncLayers/点选/捕获/出图弹窗接入/deck **懒** 获取（`ensureDeckForMap`）。已拆出 `deck/controller` 与 `gis-types`。 |
| `LayerPanel.tsx` | gis | 图层面板（懒取 draw 的 DrawToolbar；出图按钮 → MapView.openExport）。 |
| `AttributeDrawer.tsx`/`BasemapSwitcher.tsx`/`hex-bins.ts` | gis | 属性表/底图切换器/蜂窝纯函数。 |
| `gis-types.ts` | gis | `DisplayMode/LayerSummary/FeaturePayload` 纯类型（供 gis 与 deck 共享，无运行时）。 |
| `deck/controller.ts` | deck | `DeckController` 类：deck 特效 + raw arrow/geojson 大图层 + zoom 分级 + trips 动画 + 点选 proxy（值 import deck.gl/geoarrow/apache-arrow）。 |
| `deck-charts.ts`/`geoarrow-charts.ts`/`geoarrow-utils.ts` | deck | deck 出图层构造 / GeoArrow 层构造 / geojson 原始层纯函数。 |
| `chunks/…` 之外由 gis/deck 各自引用的 css | — | `webgis.module.css` 幂等注入（多 chunk 重复内联只注入一次）。 |
| `DrawToolbar.tsx` | draw | Terra Draw 绘图工具条（terra-draw + adapter + bezier）。 |
| `ExportMapDialog.tsx`/`map-export.ts`/`export-layout.ts` | export | 出图弹窗/合成/纯版式（export-layout 有 node 单测）。 |

### 测试（tests/*.test.mjs，均 import `../lib/...`）
按模块分文件（load-dataset / duckdb-tools / geo-processing / geo-tools / geoarrow(-utils) / export-layout / chunk-loader / session-state / enabled / basemaps…）。**拆 host 文件必须保 barrel**：`lib/index.js` 继续 re-export `loadCsvText/loadDataset/parseShapefileBuffer/dropLayerResources` 等；`lib/geo-tools.js` 保持 `registerGeoTools` 与 36 工具全量。

## 3. 核心数据流

### 3.1 会话状态与同步
- 状态唯一真源 = host 每会话 `WebgisState`（`session-state.ts`）。键 = `exec.agent?.id`（工具写）＝客户端 `?session=`（读）。
- 客户端读：轮询 `/webgis/state`（指纹没变整轮跳过）＋ SSE `/webgis/events`（`sync`→立即 poll）。host 指纹 `stateFingerprint`（含 exportRequest）。
- **图层变更检测**：`rev` + `shape` 签名（geometryTypes/renderer/dataFormat/name/source）。改「换 dataset 不刷新」类问题 → `MapView.syncLayers`/`layerShapeKey`。

### 3.2 图层注册表与渲染路由
- 加图层 = `st.layers.push(GisLayer)`（`makeResultLayer`）。来源：`dataset`/`import`/`csv`/`result`/`db`。
- **渲染决策在 host**：`pickRenderer` + `dataFormat`（有 duckTable 且单几何族 → arrow）。客户端按 summary：maplibre 层（circle/fill/line/heat/hex）、deck 出图（mode∈arc/trips/wall/radial）、deck raw（renderer=deck 点 → `/webgis/arrow` zoom 分级）。
- 大数据 arrow：duckTable + `/webgis/arrow?max=`（`USING SAMPLE`，档位见 `render-policy`），`__rid` 保留列跨档稳定。

### 3.3 数据文件加载
- 统一原则：≤5 万 maplibre；>10 万 DuckDB+arrow+deck；来源无关。`webgis_load_dataset`=叠加成 `ds_N`；CSV 大文件 `loadCsvSourceData`；**本地矢量（.shp/.gdb/.gpkg/.kml/.tab/.mif）走 `loadVectorSourceData`（DuckDB spatial `ST_Read` 直读灌表，超大 .shp 不经 shpjs 全量物化；失败对 .shp 回退旧路径）**；shp/zip/geojson `ingestBigGeojson`；`webgis_load_csv`=纯 DuckDB；GUI `/webgis/import`=import_N。
- 多几何族 → 禁 arrow 回退 geojson 一族一层。

### 3.4 点选属性
- maplibre：`queryRenderedFeatures` 直接弹属性。deck raw：`DeckController.pickObject` → 带 `__rid`（duckGeom）走 `/webgis/arrow-rid`；duckCoords 点按坐标 `/webgis/arrow-attr`；geojson 分族子层 index 对齐 raw*Data。

### 3.5 截图/捕获/出图
- 点击截图 `captureMapScreenshot` → `/webgis/pick` → `decodeDataUrl`+`ctx.attachments.saveImage` → pick.screenshot；`webgis_get_pick` 给模型。
- 捕获当前视图：`state.capture` 握手 `awaitCurrentViewCapture`（置 seq→客户端 POST captureSeq→工具等待）。
- 出图：`exportRequest/exportImage` + `awaitExportCompletion`；客户端 `ExportMapDialog` 合成 PNG → `/webgis/export-image`；`GET /webgis/attachment` 下载。AI 工具 `webgis_export_map`/`webgis_get_export_map`。

## 4. HTTP 路由一览（`/webgis/*`，`src/index.ts` routeDefs 表驱动分发）
state / status / plugin-config / dataset / gis-result / arrow / arrow-attr / arrow-rid / layer-action / import / export / export-image / attachment / pick / events(SSE) / vision-config / postgis-config / postgis-action / services(+remove/visibility) / 静态资源（maplibre css+worker、earcut-worker、**4 个懒 chunk js：gis/deck/draw/export**，白名单在 `http-utils.serveAsset`）。
> 启停关闭：非白名单一律 503（`isWebgisRouteBlocked`）。信任围栏（loopback/CSRF）在最前。分发：信任围栏 → 会话解析 → 启停门 → `routeDefs` 循环命中，未命中 404。

## 5. 改某个功能 → 从哪进（速查）
| 想改什么 | 入口文件/符号 |
|---|---|
| 加载文件（CSV/SHP/GeoJSON/上传） | `dataset-load.ts`、`/webgis/import`、`duckdb-tools` |
| 大数据档位/抽样数 | `render-policy.ts`（`ZOOM_ARROW_TIERS`） |
| 图层形态切换不刷新/残留 | `MapView.tsx` `syncLayers`（seen/shape/clear 各态） |
| 点选属性 | `MapView.tsx` click + `DeckController.pickObject/arrowTableFor`；host `arrow-rid/arrow-attr` |
| 图层面板按钮/右键 | `LayerPanel.tsx`（含懒取 draw 绘图条） |
| 出图 | `ExportMapDialog.tsx`/`map-export.ts`/`export-layout.ts` + host `export-image` + 工具 |
| 点击截图/「这里是什么地方」 | `MapView.tsx` `captureMapScreenshot`、`/webgis/pick`、`vision-chain` |
| 底图切换 | `MapView` `applyBaseMap`、`basemaps.ts`、`BasemapSwitcher` |
| 叠加服务 | `webgis-services*.ts`、`OverlayServicesSection` |
| 绘图/创建要素 | `DrawToolbar.tsx`（draw chunk） |
| PostGIS 查询 | `db-tools/db-manager/postgis` + 配置卡 |
| 会话销毁内存释放 | `index.ts` `session/disposed` + `arrow-cache`/`dropLayerResources` |
| 状态推送 | `MapView` poll/SSE + `index.ts` `stateFingerprint`/`pushSseIfChanged` |
| 懒加载某个新功能 → 该放哪个 chunk | 见 §7 拓扑表 + `chunk-loader.ensure` |
| Duck 大表空间筛选/聚合（全表算、抽样如实标注 scope） | `duckdb-tools.ts` `webgis_spatial_filter` / `webgis_spatial_aggregate` |
| 客户端构建（bundle/chunk 配置） | `tsdown.config.ts`（`makeClientConfig` + 数组） |
| host 路由增改 | `routes-*.ts` + `index.ts` routeDefs + `route-shared` |

## 6. 关键约定与「坑」备忘
- **`__rid`（DUCK_RID）保留列**：duck 建表自动加（行号）。所有「用户可见属性清单」排除它。
- **图层 id 是客户端缓存/注册表键**：`gisSeen/dataCache/rawTableCache/deckRegistry…` 按 layer.id；换内容不换 id 靠 rev+shape 驱动重建；deck↔raw↔maplibre 切换要互清对方状态。
- **Arrow 只能单几何族**：多族 `dataFormat=geojson` 一族一层（防静默丢族）。
- **DuckDB 没有 `rowid()`**；`conn.all` 参数绑定有 bug（值一律内联字面量）。
- **deck interleaved**：截图取 `map.getCanvas()` 即含 deck；活动地图改 setPixelRatio 截图易空白（临时放大容器重渲）。
- **DuckDB arrow 走 community 扩展**（1.2+ arrow 从核心迁出，默认仓 404）：`engine.ensureArrow/arrowIpc` 用 `INSTALL arrow FROM community; LOAD arrow;`；`/webgis/arrow` 的 duckCoords 分支**原生优先**（免 conn.all 的 JS 行物化），缺失/超时自动回退 JS 行路径。渲染要的 GeoArrow 几何仍由 host 构造（`geoarrow.pointsToGeoArrowFromIpc`）。⚠️ arrow 扩展的 `arrowIPCAll` 对「空结果」会让 duckdb 原生段崩溃（实测 `SELECT … WHERE 恒假` → 进程 EXIT 127 无 JS 错误）——**任何可能空的结果（如视野裁剪空窗）必须避开原生 arrowIpc**，走 JS 行路径。
- **arrow 高 zoom 走视口裁剪（bbox）**：客户端 `DeckController` 拉 `/webgis/arrow` 时取 `map.getBounds()` 外扩 ~25% 后按 ~3 位小数取整拼 `&bbox=west,south,east,north`；host 先 `WHERE` 视野（duckCoords=`lon/lat BETWEEN`；duckGeom=`ST_Intersects(<geomExpr>, ST_MakeEnvelope(...))`）再 `USING SAMPLE cap`——高 zoom 不再无差别抽全表 60 万。**缓存只覆盖无 bbox 分档**（视野键难缓存）；bbox 空窗（视野内无要素）返回合法空 arrow（不 500）。客户端去重键 `lastViewKey = ${tier}|${bbox}`，zoomend(`syncRawTiers`) 与 moveend(~350ms 防抖 `viewportRefresh`) 都汇到它兜底去重；带视野不预取下一档。
- **UI 由用户自测**：不做 headless 浏览器 UI 自动化；纯函数拆出来 node 单测。
- **构建/测试**：`npm run typecheck`、`npm run test`（含 build）。多 chunk 并发打包内存峰值高时可 `--concurrency 2`。
- 纯重构（拆文件/搬代码）**不许改行为/契约/console 文本**；拆 host 文件保持 barrel 导出面。

## 7. 客户端按需加载（懒 chunk）—— 2026-09-04 落地

### 拓扑与体积（基线：改造前单 bundle 3.72MB 全内联）
| 产物 | loader id | 内容 | 触发 | 体积(现状) |
|---|---|---|---|---|
| `lib/client.js` (shell) | `dsh-webgis` | index/GisSurface/配置卡/webgisMode/chunk-loader | DSH 启动 | ~71 KB |
| `assets/gis.js` | `dsh-webgis/gis` | MapView+maplibre+地图 UI（deck 已拆出） | 进 GIS 模式 | ~1.22 MB |
| `assets/deck.js` | `dsh-webgis/deck` | DeckController + deck.gl/geoarrow/apache-arrow | 首个需 deck 图层出现 | ~2.22 MB |
| `assets/draw.js` | `dsh-webgis/draw` | DrawToolbar + terra-draw | 「创建」展开 | ~252 KB |
| `assets/export.js` | `dsh-webgis/export` | ExportMapDialog + 合成 | 打开出图弹窗 | ~54 KB |

### 加载协议（重要，改 chunk 相关代码前必读）
- DSH 客户端是自研 `window.__ModuleLoader__.load({ id, factory(require) })` CJS closure loader，**非原生 ESM**。loader 运行时对**新 id** 再 `load()` 不抛错，但 factory **不立即执行**（store-until-required），且无公开运行时 require API。
- **触发 factory 执行的唯一途径** = loader 的 require。tsdown 产物 intro（`INTRO`）把每个 factory 的 `require` 捕获到 `window.__dshWebgisAsync._r`；`chunk-loader.ensure(name)` 注入 `<script src="/webgis/<name>.js">`（其顶层 `load()` 注册）后用捕获的 require 解析 `dsh-webgis/<name>` → factory 执行（顶层 `require('react')` 从 loader 模块表解析，全页共享单 React）→ 取回模块 exports。
- chunk 入口双通道：具名导出（require 取回）与 `registerChunk(name, api)`（副作用）冗余，谁先到用谁。
- **跨 bundle 规则**：静态图互不相交；共享运行时对象只走 window 注册表（`__dshWebgisAsync` 单例，各 bundle 自带一份 `chunk-loader` 实现副本但无状态）；含模块级可变状态的 store（webgisMode）只许在 shell；跨边界一律运行参数注入（deck 控制器拿 maplibre Map 实例等）。纯函数可重复内联。
- **新加功能放哪个 chunk**：地图内功能默认进 gis；Terra Draw 类绘图进 draw；纯导出/弹窗进 export；任何 deck.gl/大图层 arrow 运行时进 deck。**重型依赖禁止进 shell**（否则首包回 3.7MB）。
- **构建**：`tsdown.config.ts` `export default [cfg×5]`（`makeClientConfig` 工厂；全部 `clean:false`——clean 会清 tsc 逐文件产物与 assets check-in 文件）。新 chunk 需同步：新入口 `src/client/chunks/<x>.ts`（tsconfig.client include 已覆盖）→ tsdown cfg（outDir assets）→ `http-utils.serveAsset` 白名单 + `index.ts` routeDefs 静态 match。
- **node 内置模块 shim**（NODE_SHIMS）：必须是「自包含对象 + default + 属性具名导出」——rolldown 会把 `export default {…引用内部函数…}` 惰性化并剪掉只被 default 引用的函数（悬空简写 ReferenceError，如 os.freemem），自包含对象体无此问题。

### i18n（DSH 官方 locale 框架，zh/en）—— 2026-09-06
- 词典单一来源 `src/client/webgis-i18n.ts`（**shell 专属**：只有 index.tsx apply 的 `installWebgisLocale` 能 value-import）。zh 驱动键集（`WebgisKey = keyof typeof zh`），en 缺键即编译错；命名空间 `webgis` 用 `declare module '@deepseek-ai/dsh-client-ui-slots'` 并入 `LocaleNamespaceMap`。`t(key, {name})` 支持 `{name}` 占位符；`{z}/{x}/{y}` 等不在 params 的 `{…}` 保持字面量（可安全放词典值）。
- `ctx.locale` 是 DSH 官方服务：cordis inject 含 `'locale'`，package.json `dsh.client.inject`/peerDeps 加 `@deepseek-ai/dsh-client-locale`。**不得 value import 该包**（不在 tsdown 平台 external，purity 会拒）；只用 `import type {} from '@deepseek-ai/dsh-client-locale/client'`。
- `t` 只由 DSH 渲染器注入声明了 `locale:'webgis'` 的 slot 入口（GisSurface / WebgisConfigCard）。其余组件**一律 props 透传**；跨 chunk 组件引用词典键类型用 `import type { WebgisT }`（编译即擦除），禁止 value-import `./webgis-i18n.js`（词典会复制进 chunk 漂移）。
- 一次性 mount 监听（map click/poll 等）取 t 必须经 ref（MapView `tRef`），避免语言切换后 stale；已打开 Popup / 在途错误不实时换语言（关闭重开即新语言）。
- 数据边界不翻：图层/文件/表名、属性列名、底图 `src/basemaps.ts` 的 category/name（BasemapSwitcher 内只映射 `default`/`esri-imagery` 两项中文名）、叠加服务名、服务器返回的 error.message、OverlayServices URL 模板。DrawToolbar 默认层名、出图默认版权注记是「一次性本地化数据值」，保存/打开时取当前 t 快照（版权注记 pristine 时跟随语言，AI 显式 note 不覆盖）。
- 数字：zh 保持万/亿紧凑（`fmtCount` 逐字不变），en 千分位全数字。出图抽样注记 export-layout 用可选 `t` 注入（无 t 保持中文字面量，`export-layout.test` 锁定），该纯模块不 import 任何 locale 运行时。

### GUI 自测记录（用户验收）
- Run A（5.1–5.3 后）：gis/draw/export 懒加载正常，deck 仍在 gis 内回归通过。
- Run B（5.4 后）：进 GIS 才拉 gis.js；首个大文件/deck 特效才拉 deck.js；二次进入不重拉；点选/出图/绘图/截图全回归通过；console 无错。
- Run C（i18n 落地）：DSH 设置语言 zh 全插件界面无回归；切 en 不刷新即时全英文（含 DSH 设置 WebGIS 卡）；回 zh 即时回中文；图层/列名/服务名不翻；出图 PNG 抽样注记与版权随语言；英文提问 → 英文回复。
