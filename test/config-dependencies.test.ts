import type { PagesConfig } from '@uni-helper/uni-pages-types'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import chokidar from 'chokidar'
import { parse } from 'comment-json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPagesConfig, PageConfigLoadError } from '../packages/core/src/config-loader'
import { PageContext } from '../packages/core/src/context'
import { assertPreparedContext, prepareContext } from '../packages/core/src/preparation'
import { watchScope } from '../packages/core/src/scan'

describe('pages config dependencies', () => {
  let root: string

  function write(file: string, content: string): string {
    const absolute = path.join(root, file)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
    return absolute.replace(/\\/g, '/')
  }

  const load = () => loadPagesConfig(root, [{ files: 'pages.config' }])
  const entry = (dependency: string) => `import { theme } from ${JSON.stringify(dependency)}; export default { pages: [], globalStyle: { navigationBarTitleText: [theme.one, theme.two, theme.json, theme.cjs].join("|") } }`
  const theme = (one: number) => `import { deep } from "./deep"; export const theme = { one: ${one}, ...deep }`
  const deep = (two: number) => `import palette from "./palette.json"; import legacy from "./legacy.cjs"; export const deep = { two: ${two}, json: palette.value, cjs: legacy.value }`

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-config-dependencies-'))
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('tracks direct and transitive TS, JSON and CommonJS inputs and reloads fresh values', async () => {
    const source = write('pages.config.ts', entry('./config/theme'))
    const inputs = [
      write('config/theme.ts', theme(0)),
      write('config/deep.ts', deep(0)),
      write('config/palette.json', JSON.stringify({ value: 0 })),
      write('config/legacy.cjs', 'module.exports = { value: 0 }'),
    ]

    async function expectTitle(title: string): Promise<void> {
      const loaded = await load()
      expect(loaded.config.globalStyle?.navigationBarTitleText).toBe(title)
      expect(loaded.sources).toEqual([source])
      expect(loaded.dependencies.sort()).toEqual([...inputs].sort())
    }

    await expectTitle('0|0|0|0')
    write('config/theme.ts', theme(1))
    await expectTitle('1|0|0|0')
    write('config/deep.ts', deep(2))
    await expectTitle('1|2|0|0')
    write('config/palette.json', JSON.stringify({ value: 3 }))
    await expectTitle('1|2|3|0')
    write('config/legacy.cjs', 'module.exports = { value: 4 }')
    await expectTitle('1|2|3|4')
  })

  it('replaces the dependency graph when imports change and recovers after missing dependencies are restored', async () => {
    write('pages.config.ts', entry('./config/theme'))
    write('config/theme.ts', 'export const theme = { one: 1, two: 2, json: 3, cjs: 4 }')
    await load()

    const alternate = write('alternate/theme.ts', 'export const theme = { one: 5, two: 6, json: 7, cjs: 8 }')
    write('pages.config.ts', entry('./alternate/theme'))
    const loaded = await load()
    expect(loaded.dependencies).toEqual([alternate])
    expect(loaded.config.globalStyle?.navigationBarTitleText).toBe('5|6|7|8')

    fs.unlinkSync(alternate)
    await expect(load()).rejects.toThrow()
    write('alternate/theme.ts', 'export const theme = { one: 9, two: 6, json: 7, cjs: 8 }')
    expect((await load()).config.globalStyle?.navigationBarTitleText).toBe('9|6|7|8')
    expect(loaded.config.globalStyle?.navigationBarTitleText).toBe('5|6|7|8')
  })

  it('keeps file resolution ahead of an unrelated directory with the same name', async () => {
    write('pages.config.ts', 'import title from "./config"; export default { globalStyle: { navigationBarTitleText: title } }')
    const dependency = write('config.ts', 'export default "file"')
    write('config/package.json', '{"main":')
    const loaded = await load()
    expect(loaded.config.globalStyle?.navigationBarTitleText).toBe('file')
    expect(loaded.dependencies).toEqual([dependency])
  })

  it('tracks the local package manifest that selects a directory import entry', async () => {
    write('pages.config.ts', 'import title from "./config"; export default { globalStyle: { navigationBarTitleText: title } }')
    write('config/a.ts', 'export default "A"')
    const alternate = write('config/b.ts', 'export default "B"')
    const manifest = write('config/package.json', '{"main":"a.ts"}')
    const first = await load()
    expect(first.config.globalStyle?.navigationBarTitleText).toBe('A')
    expect(first.dependencies).toContain(manifest)
    write('config/package.json', '{"main":"b.ts"}')
    const second = await load()
    expect(second.config.globalStyle?.navigationBarTitleText).toBe('B')
    expect(second.dependencies.sort()).toEqual([alternate, manifest].sort())
  })

  it.each(['change', 'add'])('updates directory import entries through a native watcher on manifest %s', async (event) => {
    fs.mkdirSync(path.join(root, 'src'))
    write('pages.config.ts', 'import title from "./config"; export default { pages: [{ path: "pages/index" }], globalStyle: { navigationBarTitleText: title } }')
    const initial = event === 'change' ? 'config/a.ts' : 'config/index.ts'
    write(initial, 'export default "A"')
    write('config/b.ts', 'export default "B"')
    if (event === 'change')
      write('config/package.json', '{"main":"a.ts"}')
    const ctx = new PageContext({ mergePages: false, dts: false }, root, 'mp-weixin')
    await ctx.updatePagesJSON()
    const scope = watchScope(ctx)
    const watcher = chokidar.watch(scope.roots, { ignoreInitial: true, ignored: scope.ignored })
    const onUpdate = vi.spyOn(ctx, 'onUpdate')
    const readTitle = () => (parse(fs.readFileSync(path.join(root, 'src/pages.json'), 'utf8')) as PagesConfig).globalStyle?.navigationBarTitleText
    try {
      await once(watcher, 'ready')
      await ctx.setupWatcher(watcher)
      let revision = 0
      await expect.poll(() => {
        if (onUpdate.mock.calls.length)
          return true
        write(initial, `export default "Ready ${revision++}"`)
        return false
      }, { interval: 50, timeout: 5_000 }).toBe(true)
      await ctx.flushWatcher()
      write('config/package.json', '{"main":"b.ts"}')
      await expect.poll(readTitle, { timeout: 5_000 }).toBe('B')
    }
    finally {
      await ctx.disposeWatcher()
      await watcher.close()
    }
  })

  it('keeps dependencies under a symlinked directory on the paths seen by the watcher', async () => {
    write('actual/theme.ts', 'export const title = "linked"')
    fs.symlinkSync(path.join(root, 'actual'), path.join(root, 'linked'), 'junction')
    write('pages.config.ts', 'import { title } from "./linked/theme"; export default { pages: [], globalStyle: { navigationBarTitleText: title } }')
    expect((await load()).dependencies).toEqual([path.join(root, 'linked/theme.ts').replace(/\\/g, '/')])
  })

  it('preserves load errors and limits retry candidates to unresolved local imports', async () => {
    const source = write('pages.config.ts', 'import { title } from "./config/theme"; export default { pages: [], globalStyle: { navigationBarTitleText: title } }')
    const dependency = write('config/theme.ts', 'export { title } from "./new/title"')
    const files = fs.readdirSync(root, { recursive: true }).sort()
    const error = await load().catch(error => error)

    expect(error).toBeInstanceOf(PageConfigLoadError)
    expect(error.message).toBe(error.cause.message)
    expect(error.dependencies).toContain(source)
    expect(error.dependencies).toContain(dependency)
    expect(error.dependencies).toContain(path.join(root, 'config/new/title.ts').replace(/\\/g, '/'))
    expect(error.dependencies).toContain(path.join(root, 'config/new/title/index.ts').replace(/\\/g, '/'))
    expect(error.dependencies).not.toContain(`${dependency}.ts`)
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(files)
  })

  it.each(['missing file', 'syntax error', 'missing index', 'missing package entry', 'invalid package manifest'])('recovers from a newly imported dependency with %s without touching the config again', async (failure) => {
    fs.mkdirSync(path.join(root, 'src'))
    const configSource = (specifier: string) => `import { title } from ${JSON.stringify(specifier)}; export default { pages: [{ path: "pages/index" }], globalStyle: { navigationBarTitleText: title } }`
    const source = write('pages.config.ts', configSource('./initial'))
    const previous = write('initial.ts', 'export const title = "initial"')
    const ctx = new PageContext({ mergePages: false, dts: false, outDir: 'src' }, root, 'h5')
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
    const onUpdate = vi.spyOn(ctx, 'onUpdate').mockImplementation(() => {})
    const readOutput = () => fs.readFileSync(path.join(root, 'src/pages.json'), 'utf8')
    const target = failure === 'missing index' ? 'new/title/index.ts' : failure.includes('package') ? 'new/title/content.ts' : 'new/title.ts'
    const absoluteTarget = path.join(root, target).replace(/\\/g, '/')

    try {
      await ctx.updatePagesJSON()
      await ctx.setupWatcher(watcher as any)
      const original = readOutput()
      write('pages.config.ts', configSource('./new/theme'))
      write('new/theme.ts', 'export { title } from "./title"')
      if (failure === 'missing package entry')
        write('new/title/package.json', '{"main":"content.ts"}')
      if (failure === 'invalid package manifest') {
        write('new/title/package.json', '{"main":')
        write(target, 'export const title = "recovered"')
      }
      if (failure === 'syntax error')
        write(target, 'export const title =')
      const files = fs.readdirSync(root, { recursive: true }).sort()

      watcher.emit('all', 'change', source)
      await ctx.flushWatcher()
      expect(onUpdate).not.toHaveBeenCalled()
      expect(readOutput()).toBe(original)
      const recoveryPath = failure === 'invalid package manifest' ? path.join(root, 'new/title/package.json').replace(/\\/g, '/') : absoluteTarget
      expect(ctx.pagesConfigDependencyPaths).toContain(recoveryPath)
      expect(watcher.add).toHaveBeenLastCalledWith(expect.arrayContaining([recoveryPath]))
      expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(files)

      write(target, 'export const title = "recovered"')
      if (failure === 'invalid package manifest')
        write('new/title/package.json', '{"main":"content.ts"}')
      watcher.emit('all', failure === 'syntax error' || failure === 'invalid package manifest' ? 'change' : 'add', recoveryPath)
      await ctx.flushWatcher()
      expect(onUpdate).toHaveBeenCalledTimes(1)
      expect((parse(readOutput()) as PagesConfig).globalStyle?.navigationBarTitleText).toBe('recovered')
      expect(ctx.pagesConfigDependencyPaths.sort()).toEqual([
        path.join(root, 'new/theme.ts').replace(/\\/g, '/'),
        absoluteTarget,
        ...(failure === 'missing index' || failure.includes('package') ? [path.join(root, 'new/title/package.json').replace(/\\/g, '/')] : []),
      ].sort())

      const loads = vi.spyOn(ctx, 'loadUserPagesConfig')
      watcher.emit('all', 'change', previous)
      await ctx.flushWatcher()
      expect(loads).not.toHaveBeenCalled()
    }
    finally {
      await ctx.disposeWatcher()
    }
  })

  it('rejects a prepared snapshot when an indirect JSON dependency changes and preserves generated outputs', async () => {
    fs.mkdirSync(path.join(root, 'src'))
    write('pages.config.ts', 'import { title } from "./config/theme"; export default { pages: [{ path: "pages/index" }], globalStyle: { navigationBarTitleText: title } }')
    write('config/theme.ts', 'import palette from "./palette.json"; export const title = palette.title')
    write('config/palette.json', JSON.stringify({ title: 'initial' }))
    const ctx = new PageContext({ mergePages: false, dts: 'uni-pages.d.ts', outDir: 'src' }, root, 'h5')
    const snapshot = await prepareContext(ctx)
    const readOutputs = () => ['src/pages.json', 'uni-pages.d.ts'].map(file => fs.readFileSync(path.join(root, file), 'utf8'))
    const outputs = readOutputs()

    expect(() => assertPreparedContext(ctx, snapshot)).not.toThrow()
    write('config/palette.json', JSON.stringify({ title: 'changed' }))
    expect(() => assertPreparedContext(ctx, snapshot)).toThrow(/changed after prepare/)
    expect(readOutputs()).toEqual(outputs)
  })

  it.each(['h5', 'mp-weixin'])('refreshes %s outputs before HMR and ignores imports removed from the dependency graph', async (platform) => {
    fs.mkdirSync(path.join(root, 'src'))
    write('pages.config.ts', 'import { settings } from "./config/theme"; export default { pages: settings.pages, globalStyle: { navigationBarTitleText: settings.title } }')
    write('config/theme.ts', 'import settings from "./settings.json"; export { settings }')
    const dependency = write('config/settings.json', JSON.stringify({ title: 'initial', pages: [{ path: 'pages/initial' }] }))
    const alternate = write('alternate/settings.json', JSON.stringify({ title: 'alternate', pages: [{ path: 'pages/alternate' }] }))
    const ctx = new PageContext({ mergePages: false, dts: 'uni-pages.d.ts', outDir: 'src' }, root, platform)
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
    const readOutput = () => parse(fs.readFileSync(path.join(root, 'src/pages.json'), 'utf8')) as PagesConfig
    const readDeclaration = () => fs.readFileSync(path.join(root, 'uni-pages.d.ts'), 'utf8')
    const updates: string[] = []
    const loads = vi.spyOn(ctx, 'loadUserPagesConfig')
    vi.spyOn(ctx, 'onUpdate').mockImplementation(() => {
      const output = readOutput()
      expect(readDeclaration()).toContain(`"/${output.pages![0].path}"`)
      updates.push(output.globalStyle!.navigationBarTitleText!)
    })

    try {
      await ctx.updatePagesJSON()
      await ctx.setupWatcher(watcher as any)
      write('config/settings.json', JSON.stringify({ title: 'changed', pages: [{ path: 'pages/changed' }] }))
      watcher.emit('all', 'change', dependency)
      await ctx.flushWatcher()
      expect(updates).toEqual(['changed'])

      const source = write('config/theme.ts', 'import settings from "../alternate/settings.json"; export { settings }')
      watcher.emit('all', 'change', source)
      await ctx.flushWatcher()
      expect(updates).toEqual(['changed', 'alternate'])
      expect(ctx.pagesConfigDependencyPaths).toContain(alternate)
      expect(ctx.pagesConfigDependencyPaths).not.toContain(dependency)
      expect(watcher.add).toHaveBeenLastCalledWith(expect.arrayContaining([alternate]))

      loads.mockClear()
      write('config/settings.json', JSON.stringify({ title: 'obsolete', pages: [{ path: 'pages/obsolete' }] }))
      watcher.emit('all', 'change', dependency)
      await ctx.flushWatcher()
      expect(loads).not.toHaveBeenCalled()
      expect(readOutput().globalStyle?.navigationBarTitleText).toBe('alternate')

      write('alternate/settings.json', JSON.stringify({ title: 'active', pages: [{ path: 'pages/active' }] }))
      watcher.emit('all', 'change', alternate)
      await ctx.flushWatcher()
      expect(updates).toEqual(['changed', 'alternate', 'active'])
    }
    finally {
      await ctx.disposeWatcher()
      expect(watcher.listenerCount('all')).toBe(0)
    }
  })
})
