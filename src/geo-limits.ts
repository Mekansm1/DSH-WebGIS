/**
 * 算子级规模上限的**单一出处**。
 *
 * 为什么单独一个文件:上限原本散在各处(`MAX_GRID_CELLS` 在 `geo-stats.ts`、`KNN_MAX_N` 是
 * 模块私有),而下限消费者横跨 `geo-processing` / `geo-stats` / `geo-indices` / worker 门控。
 * 谁 import 谁都容易绕成环,所以把这些"纯数字"抽出来 —— 本文件**零 import**,可以安全地被任何
 * 模块引用。
 *
 * 分层约定:
 * - **本文件** = 单个算子内部的硬上限(防 runaway,OOM 之前先拒绝)。
 * - `geo-job-policy.ts` = 决定"这个活该不该丢进 worker"的**门控阈值**(性能取舍,不是安全阀)。
 * 两者性质不同,别混:门控调错了只是慢,上限调错了会崩。
 */

/**
 * 核密度网格上限(防 runaway)。`opKernelDensity` 超限直接返回 `{ok:false}`;
 * `geo-indices.suggestKernel` 用它反推建议格距(自动放大到不超限)。
 */
export const MAX_GRID_CELLS = 40000

/**
 * knn 空间权重矩阵可支持的最大要素数(O(n²) 排序;超过请改用 distance/queen)。
 * 由 `makeWeightMatrix` 的 knn 分支检查,间接约束 Moran / Local Moran / Getis-Ord。
 */
export const KNN_MAX_N = 5000

/**
 * 规则格网的格数上限(防 OOM)。
 *
 * ⚠️ 这一条与上面两条**性质不同**:`opRegularGrid` 的规模**与图层无关** —— 它由工具参数
 * bbox + cellSize 直接决定,`cellSize` 传 0.0001 覆盖全国就是 10⁸ 个格子,turf 会在主线程
 * 直接 OOM,而 `timeoutMs` 对同步代码毫无作用。所以它是"防荒谬输入",不是"防慢"。
 *
 * 取 200 万是**估算值**(约等于 1414×1414 格):远高于正常用法,又远低于会打死进程的量级。
 * 待实测标定(见实施计划第 8 步)。
 */
export const MAX_REGULAR_GRID_CELLS = 2_000_000

// 规则格网的**门控**阈值不在这里 —— 它属于性能取舍,统一放在 `geo-job-policy.ts` 的
// `GEO_JOB_GATE.regularGrid`(实测：2 万格只要 2ms,所以门控几乎不介入,真正防线是上面的硬上限)。

// 注:格数计算函数不在这里 —— 它必须复用 turf 自己的 `convertLength` 才可能与
// `opRegularGrid` 生成格网时的换算一致,所以放在 geo-processing.ts 里紧挨着那个算子。
// 本文件保持"零 import 的纯常量",避免任何环。
