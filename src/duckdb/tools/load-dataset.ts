import { normalizeFC } from '../../geo-processing.js'
import { DECK_FROM } from '../../render-policy.js'
/** 单一文件加载入口，所有 CSV（包括安全下载的远程文件）共用摄取逻辑。 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FeatureCollection } from 'geojson'
import { loadDataset, resolveSourceLocal } from '../../dataset-load.js'
import { fetchData } from '../../http-fetch.js'
import { ingestBigGeojson, loadCsvSourceData, loadVectorSourceData, VECTOR_SOURCE_EXTS } from '../ingestion.js'
import { text, type DuckToolDeps, type PushExtra } from '../tools-shared.js'

export function registerLoadDatasetTool(ctx: Context, { engine, sess }: DuckToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'webgis_load_dataset',
    description: '加载文件为新图层，保留已有图层。支持 GeoJSON、CSV、shapefile(.zip/.shp)、本地 GDB/GPKG/KML/TAB/MIF/DGN。'
      + 'CSV 自动识别经纬度或 WKT/WKB 几何，支持本地 *.csv 通配合并；lonField/latField、geometryColumn 可指定列。'
      + 'filter 定义 CSV 图层的等值筛选子集，后续筛选与统计均针对该子集。'
      + 'limit 限制**上图预览**行数（正整数）：小文件取前 N 行（确定性），大文件随机抽样 N 行；'
      + '超过 10 万行的图层地图改按缩放层级渲染完整数据，此时 limit 只影响属性预览，不影响地图上看到的量。'
      + 'sourceCrs 指定 CSV/本地矢量源坐标系，转为 WGS84。GDB/GPKG 用 layer 选源图层；shp/tab 需同目录配套文件。'
      + 'url 用绝对路径或公网 http(s) 地址；远程文件受 SSRF、32MB 与超时保护。无需自行转换文件。',
    parameters: {
      url: { type: 'string', required: true, description: '文件绝对路径或公网 http(s) URL；本地 CSV 支持 *.csv' },
      layer: { type: 'string', description: '本地多图层矢量源的图层名' },
      lonField: { type: 'string', description: 'CSV 经度列，需与 latField 一起指定' },
      latField: { type: 'string', description: 'CSV 纬度列，需与 lonField 一起指定' },
      geometryColumn: { type: 'string', description: 'CSV 几何列，优先于坐标列' },
      sourceCrs: { type: 'string', description: 'CSV/本地矢量源 CRS，如 EPSG:3857' },
      filter: { type: 'json', description: 'CSV 初始等值筛选，如 {"city":"广州"}；多字段取交集，后续统计/渲染均限于该子集' },
      limit: { type: 'integer', description: 'CSV 上图预览行数上限（正整数）：小文件取前 N 行，大文件抽样 N 行；不截断后续可分析的全表数据' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, status: { type: 'string' },
          layerId: { type: 'string' }, name: { type: 'string' }, featureCount: { type: 'integer' },
          totalCount: { type: 'integer' }, table: { type: 'string' }, bbox: { type: 'json' }, message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      let tempDir: string | undefined
      let ownedTable: string | undefined
      try {
        const source = args.url.trim()
        if (!source) throw new Error('url 不能为空')
        const remote = /^https?:\/\//i.test(source)
        const clean = remote ? new URL(source).pathname : source
        const ext = clean.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? ''
        const csvOnly = [args.lonField, args.latField, args.geometryColumn, args.filter, args.limit].some(v => v !== undefined)
        if (ext !== 'csv' && csvOnly) throw new Error('lonField/latField/geometryColumn/filter/limit 仅适用于 CSV')
        if (args.layer !== undefined && (remote || !VECTOR_SOURCE_EXTS.includes(ext))) throw new Error('layer 仅适用于本地多图层矢量源')
        if (args.sourceCrs !== undefined && ext !== 'csv' && (remote || !VECTOR_SOURCE_EXTS.includes(ext))) throw new Error('sourceCrs 仅适用于 CSV 或本地矢量源')
        let fc: FeatureCollection
        let extra: PushExtra = { source: 'dataset' }
        let note = ''
        let small = true
        const name = clean.split(/[\\/]/).pop() || 'dataset'
        if (ext === 'csv') {
          let path = resolveSourceLocal(source)
          if (remote) {
            const { buffer } = await fetchData(source, { maxBytes: 32 * 1024 * 1024 })
            tempDir = await mkdtemp(join(tmpdir(), 'dsh-webgis-csv-'))
            path = join(tempDir, 'source.csv')
            await writeFile(path, buffer)
          }
          const csv = await loadCsvSourceData(engine, path, args)
          ownedTable = csv.duckTable
          fc = csv.geojson
          extra = { ...extra, ...csv, cluster: !!csv.duckCoords && !csv.small && csv.totalCount <= DECK_FROM }
          note = csv.note
          small = csv.small
        } else if (!remote && VECTOR_SOURCE_EXTS.includes(ext)) {
          try {
            const vec = await loadVectorSourceData(engine, resolveSourceLocal(source), { layer: args.layer, sourceCrs: args.sourceCrs })
            ownedTable = vec.duckTable
            fc = vec.geojson
            extra = { ...extra, ...vec }
            note = vec.note
            small = vec.small
          } catch (err) {
            // 不忽略显式 CRS / 图层参数，否则回退可能悄悄加载错误数据。
            if (ext !== 'shp' || args.sourceCrs || args.layer) throw err
            const ds = await loadDataset(source)
            fc = normalizeFC(ds.geojson)
          }
        } else {
          const ds = await loadDataset(source)
          fc = normalizeFC(ds.geojson)
        }
        if (fc.type !== 'FeatureCollection') throw new Error('加载结果不是 FeatureCollection')
        if (!extra.duckTable && ext !== 'csv') {
          const big = await ingestBigGeojson(fc, engine).catch(() => null)
          if (big) {
            ownedTable = big.duckTable
            extra = { ...extra, ...big }
            fc = big.geojson
            small = false
          }
        }
        const session = sess(exec)
        const push = await session.pushResult(name, fc, extra)
        ownedTable = undefined // 图层接管表的生命周期
        if ('pick' in session.st) session.st.pick = null
        const total = extra.totalCount ?? fc.features.length
        // 措辞必须与实际渲染一致：>DECK_FROM 的大图层走 arrow 按缩放层级拉**完整**表，
        // 此时"抽样 N 行"只是属性预览，说成"显示 N 行"就是虚报（实测 limit:1000 时地图上
        // 仍可能画出 5 万个点）。不能让模型拿着这个数字向用户断言图上只有 1000 个。
        const arrowNote = !small && total > DECK_FROM
          ? `；地图按缩放层级渲染完整 ${total} 行，抽样的 ${fc.features.length} 行仅用于属性预览`
          : ''
        return { ...push, status: small ? 'small' : 'loaded', totalCount: total,
          table: extra.duckTable ?? '', message: `${push.message}；${note || '已有图层保留，可叠加'}${arrowNote}` }
      } catch (err) {
        return { ok: false, message: `数据集加载失败: ${err instanceof Error ? err.message : String(err)}` }
      } finally {
        if (ownedTable) await engine.dropTable(ownedTable).catch(() => {})
        if (tempDir) await rm(tempDir, { recursive: true, force: true })
      }
    },
  }))
}
