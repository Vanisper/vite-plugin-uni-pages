import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { loadPagesConfig } from '../packages/core/src/config-loader'

let root: string

function write(file: string, content: string): string {
  const absolute = path.join(root, file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

async function load(entry: string) {
  const result = await loadPagesConfig(path.dirname(entry), [{ files: entry, extensions: [] }])
  return { value: (result.config as { value: unknown }).value, dependencies: result.dependencies }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-config-resolve-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

it.each(['import', 'require'])('%s 从依赖文件所在目录解析外部包，并保留对应导出条件', async (kind) => {
  for (const directory of ['', 'config/']) {
    const packageDir = `${directory}node_modules/config-choice`
    write(`${packageDir}/package.json`, JSON.stringify({
      exports: { module: './module.mjs', import: './import.mjs', require: './require.cjs' },
    }))
    write(`${packageDir}/module.mjs`, 'export default "bundler only"')
    write(`${packageDir}/import.mjs`, `export default "${directory}import"`)
    write(`${packageDir}/require.cjs`, `module.exports = "${directory}require"`)
  }
  write('config/helper.ts', kind === 'import'
    ? 'import value from "config-choice"; export default value'
    : 'export default require("config-choice")')
  const entry = write('pages.config.ts', 'import value from "./config/helper"; export default { value }')

  const { value, dependencies } = await load(entry)
  expect(value).toBe(`config/${kind}`)
  expect(dependencies).toContain(path.join(root, 'config/helper.ts'))
  expect(dependencies.some(file => file.includes('node_modules'))).toBe(false)
})

it.each(['import', 'require'])('%s 保留显式 node_modules 路径的依赖文件基准', async (kind) => {
  write('config/node_modules/config-value/index.cjs', 'module.exports = "nested"')
  write('config/helper.ts', kind === 'import'
    ? 'import value from "./node_modules/config-value/index.cjs"; export default value'
    : 'export default require("./node_modules/config-value/index.cjs")')
  const entry = write('pages.config.ts', 'import value from "./config/helper"; export default { value }')

  const { value, dependencies } = await load(entry)
  expect(value).toBe('nested')
  expect(dependencies.some(file => file.includes('node_modules'))).toBe(false)
})

it('内置模块保持原始名称', async () => {
  const entry = write('pages.config.ts', 'import { basename } from "node:path"; const fs = require("fs"); export default { value: basename("folder/value") + typeof fs.readFileSync }')
  const { value, dependencies } = await load(entry)
  expect(value).toBe('valuefunction')
  expect(dependencies).toEqual([])
})

it('外部包解析不打断本地模块的循环引用', async () => {
  write('config/node_modules/config-value/index.js', 'module.exports = "nested"')
  write('config/a.ts', 'import { read } from "./b"; export const prefix = "cycle"; export function value() { return read() }')
  write('config/b.ts', 'import { prefix } from "./a"; import value from "config-value"; export function read() { return prefix + ":" + value }')
  const entry = write('pages.config.ts', 'import { value } from "./config/a"; export default { value: value() }')
  const result = await load(entry)
  expect(result.value).toBe('cycle:nested')
})

it('缺失的可选依赖仍由配置中的 try/catch 处理', async () => {
  const entry = write('pages.config.ts', 'let value = "missing"; try { value = require("uni-pages-optional-missing-fixture") } catch {} export default { value }')
  const result = await load(entry)
  expect(result.value).toBe('missing')
})

it.each(['import', 'require'])('%s 不会从外部依赖退回配置入口的 node_modules', async (kind) => {
  write('app/node_modules/config-value/index.js', 'module.exports = "entry only"')
  write('shared/helper.ts', kind === 'import'
    ? 'import value from "config-value"; export default value'
    : 'let value = "missing"; try { value = require("config-value") } catch {} export default value')
  const entry = write('app/pages.config.ts', 'import value from "../shared/helper"; export default { value }')

  if (kind === 'import')
    await expect(load(entry)).rejects.toThrow('config-value')
  else
    expect((await load(entry)).value).toBe('missing')
})
