#!/usr/bin/env node
/**
 * 构建前裁剪 onnxruntime 的原生库。
 *
 * 官方包把全平台二进制都塞了进来（darwin 86MB / win32 135MB），其中大部分
 * 用不到：DirectML 相关 DLL 40MB（我们只用 CPU），另一份重复的 dylib 43MB。
 * 按目标平台裁到最小，安装包才不至于翻倍。
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bin = join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6')
const target = process.argv[2] ?? process.platform

const drop = []
if (target === 'darwin') {
  drop.push('win32', 'linux', 'darwin/x64', 'darwin/arm64/libonnxruntime.1.30.0.dylib')
} else if (target === 'win32') {
  drop.push(
    'darwin',
    'linux',
    'win32/arm64',
    'win32/x64/DirectML.dll',
    'win32/x64/dxcompiler.dll',
    'win32/x64/dxil.dll',
  )
} else {
  drop.push('darwin', 'win32')
}

for (const rel of drop) {
  const full = join(bin, rel)
  if (existsSync(full)) {
    rmSync(full, { recursive: true, force: true })
    console.log('裁剪', rel)
  }
}
console.log('onnxruntime 已按', target, '裁剪')
