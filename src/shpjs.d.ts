/** shpjs（MIT，无自带类型）最小类型声明。 */
declare module 'shpjs' {
  export type ShpInput =
    | ArrayBuffer
    | ArrayBufferView
    | DataView
    | { shp: ArrayBufferView; dbf?: ArrayBufferView; cpg?: ArrayBufferView; prj?: ArrayBufferView }

  /** 主入口：buffer → zip 解析；对象 → .shp/.dbf/.prj 组合解析。返回 FeatureCollection 或 FeatureCollection[]。 */
  export function getShapefile(input: ShpInput, whiteList?: string[]): Promise<unknown>
  export function parseZip(buffer: ArrayBuffer | ArrayBufferView | DataView, whiteList?: string[]): Promise<unknown>
  export function parseShp(shp: ArrayBufferView, prj?: unknown): unknown
  export function combine(parts: [unknown[], unknown[]]): { type: string; features: unknown[] }
  export default getShapefile
}
