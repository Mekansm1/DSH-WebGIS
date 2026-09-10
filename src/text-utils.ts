/**
 * 文本读取的小工具。
 *
 * {@link stripBom}：Windows 上的编辑器 / PowerShell（`Out-File`、`Set-Content`）/ Excel 导出
 * 常给 UTF-8 文件写入 BOM（EF BB BF），按 utf8 读出来就是开头的 `﻿`。
 * `JSON.parse` 遇到它会直接抛 "Unexpected token"，**而报错信息完全看不出是 BOM 造成的** ——
 * 实测中模型因此以为文件内容有问题，把同一个文件重写了一遍才成功。
 * 所以凡是「读文件文本 → JSON.parse」的入口都应过一道。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
