import type { PagesConfig } from '@uni-helper/uni-pages-types'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPagesConfig } from '../packages/core/src/config-loader'

type ConfigSource = Parameters<typeof loadPagesConfig>[1][number]

describe('pages config loading', () => {
  let root: string

  function write(file: string, content: string): string {
    const absolute = path.join(root, file)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
    return absolute.replace(/\\/g, '/')
  }

  const config = (title: string): PagesConfig => ({ pages: [], globalStyle: { navigationBarTitleText: title } })
  const load = (sources: ConfigSource[] = [{ files: 'pages.config' }]) => loadPagesConfig(root, sources)

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-config-loader-'))
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it.each(['ts', 'cts', 'mts', 'cjs', 'mjs', 'js'])('loads %s configurations with local CommonJS and external package imports', async (extension) => {
    write('node_modules/config-package/package.json', JSON.stringify({ name: 'config-package', main: 'index.cjs' }))
    write('node_modules/config-package/index.cjs', 'exports.define = value => value')
    const dependency = write('config/title.cjs', 'const { basename } = require("node:path"); module.exports = { title: basename("/config/title") }')
    const source = write(`pages.config.${extension}`, extension === 'cjs'
      ? 'const { define } = require("config-package"); const { title } = require("./config/title.cjs"); module.exports = define({ pages: [], globalStyle: { navigationBarTitleText: title } })'
      : 'import { define } from "config-package"; import { title } from "./config/title.cjs"; export default define({ pages: [], globalStyle: { navigationBarTitleText: title } })')

    expect(await load()).toEqual({ config: config('title'), sources: [source], dependencies: [dependency] })
  })

  it.each(['require.resolve', 'dynamic require', 'package import'])('preserves the importing file context for %s', async (kind) => {
    write('pages.config.ts', 'import title from "./config/theme.cjs"; export default { pages: [], globalStyle: { navigationBarTitleText: title } }')
    write('config/data.json', '{"title":"local"}')
    write('config/node_modules/config-value/package.json', '{"main":"index.cjs"}')
    write('config/node_modules/config-value/index.cjs', 'module.exports = "package local"')
    write('config/theme.cjs', kind === 'require.resolve'
      ? 'module.exports = require("node:path").basename(require.resolve("./data.json"))'
      : kind === 'dynamic require'
        ? 'const file = "./data.json"; module.exports = require(file).title'
        : 'module.exports = require("config-value")')

    expect((await load()).config).toEqual(config(kind === 'require.resolve' ? 'data.json' : kind === 'dynamic require' ? 'local' : 'package local'))
  })

  it('preserves runtime TypeScript resolution, require aliases and local bindings', async () => {
    write('config/title.ts', 'export const title = "runtime"')
    write('config/theme.cjs', `
      const file = './title'
      const load = require
      const { require: shorthand } = { require }
      function shadowed(require) { return require(file) }
      function hoisted() { var require = () => 'hoisted'; return require(file) }
      const object = { method(require) { return require(file) } }
      module.exports = [load(file).title, shorthand(file).title, shadowed(() => 'parameter'), hoisted(), object.method(() => 'method')].join('|')
    `)
    write('pages.config.ts', 'import title from "./config/theme.cjs"; export default { globalStyle: { navigationBarTitleText: title } }')
    expect((await load()).config.globalStyle?.navigationBarTitleText).toBe('runtime|runtime|parameter|hoisted|method')
  })

  it('preserves file-local import.meta.resolve', async () => {
    write('config/title.ts', 'export default "value"')
    const helper = write('config/theme.ts', 'export default import.meta.resolve("./title.ts")')
    write('pages.config.ts', 'import title from "./config/theme"; export default { globalStyle: { navigationBarTitleText: title } }')
    expect((await load()).config.globalStyle?.navigationBarTitleText).toBe(pathToFileURL(fs.realpathSync(path.join(path.dirname(helper), 'title.ts'))).href)
  })

  it('keeps injected runtime resolution independent of a top-level require binding', async () => {
    const target = write('config/title.ts', 'export default "value"')
    write('config/theme.ts', 'const require = () => "local"; export default { title: import.meta.resolve("./title.ts"), local: require() }')
    write('pages.config.ts', 'import theme from "./config/theme"; export default { globalStyle: { navigationBarTitleText: theme.title }, local: theme.local }')
    expect((await load()).config).toEqual({
      globalStyle: { navigationBarTitleText: pathToFileURL(fs.realpathSync(target)).href },
      local: 'local',
    })
  })

  it('preserves CommonJS cycles and asynchronous ESM dependencies', async () => {
    write('config/a.cjs', 'exports.name = "a"; const b = require("./b.cjs"); exports.title = exports.name + b.title')
    write('config/b.cjs', 'exports.title = "b" + require("./a.cjs").name')
    write('config/async.mts', 'export const title = await Promise.resolve("async")')
    write('pages.config.ts', 'import cjs from "./config/a.cjs"; import { title } from "./config/async.mts"; export default { globalStyle: { navigationBarTitleText: cjs.title + title } }')
    expect((await load()).config.globalStyle?.navigationBarTitleText).toBe('abaasync')
  })

  it('preserves named-only exports', async () => {
    write('pages.config.ts', 'export const pages = []; export const globalStyle = { navigationBarTitleText: "named" }')
    expect((await load()).config).toEqual(config('named'))
  })

  it('preserves JSON and extensionless config sources', async () => {
    const source = write('pages.config', JSON.stringify(config('json')))
    expect(await load()).toEqual({ config: config('json'), sources: [source], dependencies: [] })
  })

  it('preserves explicitly selected JSON parsing', async () => {
    const source = write('custom.config.ts', JSON.stringify(config('json')))
    expect(await load([{ files: 'custom.config', extensions: ['ts'], parser: 'json' }])).toEqual({
      config: config('json'),
      sources: [source],
      dependencies: [],
    })
  })

  it('retains file scope in both the config entry and imported files without writing bundles', async () => {
    const entry = write('pages.config.ts', 'import scope from "./config/scope"; export default { pages: [], scope, file: __filename, dir: __dirname, url: import.meta.url }')
    const dependency = write('config/scope.ts', 'export default { file: __filename, dir: __dirname, url: import.meta.url }')
    const files = fs.readdirSync(root, { recursive: true }).sort()
    const loaded = await load()

    expect(loaded.config).toEqual({
      pages: [],
      file: entry,
      dir: path.dirname(entry),
      url: pathToFileURL(entry).href,
      scope: { file: dependency, dir: path.dirname(dependency), url: pathToFileURL(dependency).href },
    })
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(files)
  })

  it('keeps tsconfig path aliases out of config module resolution', async () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'config-alias': ['./config/title.ts'] } } }))
    write('config/title.ts', 'export default "application alias"')
    write('pages.config.ts', 'import title from "config-alias"; export default { pages: [], globalStyle: { navigationBarTitleText: title } }')
    await expect(load()).rejects.toThrow(/config-alias/)
  })

  it.each(['custom', 'transform', 'import'] as const)('preserves %s source processing and rewrite order', async (kind) => {
    const title = 'source'
    const source = write('custom.config.ts', kind === 'import' ? `export default ${JSON.stringify(config(title))}` : title)
    const calls: string[] = []
    const options: ConfigSource = {
      files: 'custom.config',
      extensions: ['ts'],
      rewrite(value, file) {
        expect(file).toBe(source)
        expect(value).toEqual(config(title))
        calls.push('rewrite')
        return config('rewritten')
      },
    }
    if (kind === 'custom') {
      options.parser = (file) => {
        expect(fs.readFileSync(file, 'utf8')).toBe(title)
        calls.push('parser')
        return config(title)
      }
    }
    else if (kind === 'transform') {
      options.transform = (content, file) => {
        expect(content).toBe(title)
        expect(file).toBe(source)
        calls.push('transform')
        return `export default ${JSON.stringify(config(title))}`
      }
    }
    else {
      options.parser = 'import'
    }

    expect((await load([options])).config).toEqual(config('rewritten'))
    expect(calls).toEqual(kind === 'import' ? ['rewrite'] : [kind === 'custom' ? 'parser' : 'transform', 'rewrite'])
    expect(fs.readdirSync(root)).toEqual(['custom.config.ts'])
  })

  it.each(['invalid export', 'rewrite rejection', 'skipped error'])('uses the next source after %s and excludes rejected dependencies', async (rejection) => {
    write('ignored.ts', 'export const title = "ignored"')
    write('first.config.ts', rejection === 'skipped error'
      ? 'throw new Error("skip this source")'
      : `import { title } from "./ignored"; export default ${rejection === 'invalid export' ? 'false && title' : '{ pages: [], globalStyle: { navigationBarTitleText: title } }'}`)
    const source = write('second.config.ts', `export default ${JSON.stringify(config('fallback'))}`)
    const rewrite = vi.fn(value => rejection === 'rewrite rejection' ? undefined : value)

    expect(await load([
      { files: 'first.config', extensions: ['ts'], rewrite, skipOnError: rejection === 'skipped error' },
      { files: 'second.config', extensions: ['ts'] },
    ])).toEqual({ config: config('fallback'), sources: [source], dependencies: [] })
    expect(rewrite).toHaveBeenCalledTimes(rejection === 'rewrite rejection' ? 1 : 0)
  })

  it('returns an empty config when no source is present', async () => {
    expect(await load()).toEqual({ config: {}, sources: [], dependencies: [] })
  })
})
