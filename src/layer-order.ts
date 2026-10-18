/**
 * 图层叠放顺序（纯函数，零依赖，可单测）。
 *
 * 约定：`state.layers` 数组**从下到上**（数组末尾 = 地图最上层）。
 * - 新建图层 append 到末尾 → 新图层默认在最上面（与历史行为一致）。
 * - 图层面板显示时反转（顶部 = 地图最上层），拖动"上移"= 数组下标增大。
 *
 * 不在这里碰渲染：客户端按数组顺序用 map.moveLayer 施加 z-order。
 */

/** 把 id 对应的元素移动到 toIndex（越界钳制）。找不到 id 时原样返回（不报错，调用方先行校验）。 */
export function moveLayerTo<T extends { id: string }>(layers: T[], id: string, toIndex: number): T[] {
  const from = layers.findIndex((l) => l.id === id)
  if (from < 0) return layers
  if (!Number.isFinite(toIndex)) return layers
  const rest = layers.filter((_, i) => i !== from)
  const to = Math.max(0, Math.min(rest.length, Math.round(toIndex)))
  return [...rest.slice(0, to), layers[from]!, ...rest.slice(to)]
}

/** 按方向移动：up=上移一层（更顶）/ down=下移一层 / top=置顶 / bottom=置底。 */
export function moveLayerBy<T extends { id: string }>(
  layers: T[],
  id: string,
  direction: 'up' | 'down' | 'top' | 'bottom',
): T[] {
  const from = layers.findIndex((l) => l.id === id)
  if (from < 0) return layers
  const last = layers.length - 1
  const to = direction === 'top' ? last
    : direction === 'bottom' ? 0
      : direction === 'up' ? Math.min(last, from + 1)
        : Math.max(0, from - 1)
  return moveLayerTo(layers, id, to)
}
