import type { FSWatcher } from 'chokidar'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import chokidar from 'chokidar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageContext } from '../packages/core/src/context'
import { watchScope } from '../packages/core/src/scan'
import { attachWatcher } from '../packages/core/src/watcher'

const roots: string[] = []
const cleanups: (() => Promise<unknown>)[] = []

function writeFile(root: string, file: string, content = '<template><view /></template>'): void {
  const absolute = path.join(root, file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
}

function project(directory?: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-watch-glob-'))
  roots.push(workspace)
  const root = directory ? path.join(workspace, directory) : workspace
  writeFile(root, 'src/pages/index.vue')
  return root
}

function readPages(root: string): { pages: { path: string }[], subPackages?: { root: string, pages: { path: string, style?: { navigationBarTitleText?: string } }[] }[], globalStyle?: { navigationBarTitleText: string } } {
  return JSON.parse(fs.readFileSync(path.join(root, 'src/pages.json'), 'utf8').split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n'))
}

function routes(root: string): string[] {
  const output = readPages(root)
  return [
    ...output.pages.map(page => `/${page.path}`),
    ...(output.subPackages ?? []).flatMap(pkg => pkg.pages.map(page => `/${pkg.root}/${page.path}`)),
  ].sort()
}

async function expectRoutes(root: string, expected: string[]): Promise<void> {
  await expect.poll(() => routes(root), { timeout: 5_000 }).toEqual(expected.toSorted())
  await expect.poll(() => {
    const declaration = fs.readFileSync(path.join(root, 'routes.d.ts'), 'utf8')
    return [...new Set([...declaration.matchAll(/"(\/[^"\n]+)"/g)].map(match => match[1]))].sort()
  }, { timeout: 5_000 }).toEqual(expected.toSorted())
}

async function startWatcher(ctx: PageContext, watcher: FSWatcher): Promise<void> {
  cleanups.push(() => watcher.close())
  await once(watcher, 'ready')
  await ctx.setupWatcher(watcher)
  cleanups.push(() => ctx.disposeWatcher())
  // 确认原生事件已可达，再开始目录拓扑变更
  const hmr = vi.spyOn(ctx, 'onUpdate')
  let revision = 0
  try {
    await expect.poll(() => {
      if (hmr.mock.calls.length)
        return true
      writeFile(ctx.root, 'src/pages/index.vue', `<script setup>definePage({ style: { navigationBarTitleText: "Ready ${revision++}" } })</script>`)
      return false
    }, { timeout: 5_000, interval: 50 }).toBe(true)
    await ctx.flushWatcher()
  }
  finally {
    hmr.mockRestore()
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

describe('glob directory watchers', () => {
  it.each(['shared', 'standalone'] as const)('%s watcher discovers packages after add, delete, recreate and rename', async (mode) => {
    const root = project()
    const ctx = new PageContext({
      subPackages: [{ dir: 'src/packages/*/pages', root: dir => path.posix.dirname(dir).slice(4) }],
      exclude: ['**/components/**', '**/_*.vue', '**/.*/**'],
      dts: path.join(root, 'routes.d.ts'),
    }, root, 'h5')
    await ctx.updatePagesJSON()
    const scope = watchScope(ctx)
    const watcher = mode === 'shared'
      ? chokidar.watch(root, { ignoreInitial: true })
      : chokidar.watch(scope.roots, { ignored: scope.ignored, ignoreInitial: true })
    await startWatcher(ctx, watcher)
    await expectRoutes(root, ['/pages/index'])

    writeFile(root, 'src/packages/empty/components/Card.vue')
    writeFile(root, 'src/packages/.hidden/pages/index.vue')
    writeFile(root, 'src/packages/alpha/pages/components/Card.vue')
    writeFile(root, 'src/packages/alpha/pages/_draft.vue')
    writeFile(root, 'src/packages/alpha/nested/pages/index.vue')
    writeFile(root, 'src/packages/alpha/pages/index.vue')
    await expectRoutes(root, ['/pages/index', '/packages/alpha/pages/index'])

    fs.rmSync(path.join(root, 'src/packages/alpha'), { recursive: true })
    await expectRoutes(root, ['/pages/index'])
    writeFile(root, 'src/packages/alpha/pages/index.vue', '<script setup>definePage({ style: { navigationBarTitleText: "Recreated" } })</script>')
    await expectRoutes(root, ['/pages/index', '/packages/alpha/pages/index'])
    expect(readPages(root).subPackages?.[0].pages[0].style?.navigationBarTitleText).toBe('Recreated')

    fs.renameSync(path.join(root, 'src/packages/alpha'), path.join(root, 'src/packages/beta'))
    await expectRoutes(root, ['/pages/index', '/packages/beta/pages/index'])
    fs.rmSync(path.join(root, 'src/packages'), { recursive: true })
    await expectRoutes(root, ['/pages/index'])
    writeFile(root, 'src/packages/gamma/pages/index.vue')
    await expectRoutes(root, ['/pages/index', '/packages/gamma/pages/index'])
  }, 25_000)

  it('detects config file creation, deletion and re-creation with no initial config', async () => {
    const root = project()
    const ctx = new PageContext({ dts: false }, root, 'h5')
    await ctx.updatePagesJSON()
    const scope = watchScope(ctx)
    const watcher = chokidar.watch(scope.roots, { ignored: scope.ignored, ignoreInitial: true })
    await startWatcher(ctx, watcher)

    const config = 'pages.config.json'
    writeFile(root, config, JSON.stringify({ globalStyle: { navigationBarTitleText: 'Created' } }))
    await expect.poll(() => readPages(root).globalStyle?.navigationBarTitleText).toBe('Created')
    fs.unlinkSync(path.join(root, config))
    await expect.poll(() => readPages(root).globalStyle).toBeUndefined()
    writeFile(root, config, JSON.stringify({ globalStyle: { navigationBarTitleText: 'Recreated' } }))
    await expect.poll(() => readPages(root).globalStyle?.navigationBarTitleText).toBe('Recreated')
  })

  it('bounds standalone traversal to scan and config ancestors', () => {
    const root = project()
    const ctx = new PageContext({ subPackages: ['src/packages/*/pages'], dts: false }, root, 'h5')
    const scope = watchScope(ctx)
    expect(scope.roots).toEqual([root])
    expect(scope.ignored(root)).toBe(false)
    expect(scope.ignored(path.join(root, 'src'))).toBe(false)
    expect(scope.ignored(path.join(root, 'src/packages'))).toBe(false)
    expect(scope.ignored(path.join(root, 'pages.config.ts'))).toBe(false)
    expect(scope.ignored(path.join(root, 'node_modules'))).toBe(true)
    expect(scope.ignored(path.join(root, 'dist'))).toBe(true)
    expect(scope.ignored(path.join(root, 'src/pages-other'))).toBe(true)
  })

  it('prunes unrelated package trees while preserving explicitly imported configuration files', async () => {
    const root = project()
    for (const file of [
      'src/packages/demo/pages/index.vue',
      'src/packages/demo/pages/components/Card.vue',
      'src/packages/demo/pages/components/theme.ts',
      'src/packages/demo/node_modules/vendor/index.js',
      'src/packages/demo/node_modules/config/theme.ts',
      'src/packages/demo/docs/readme.md',
    ]) {
      writeFile(root, file)
    }
    const ctx = new PageContext({
      subPackages: ['src/packages/*/pages'],
      exclude: ['**/components/**'],
      dts: false,
    }, root, 'h5')
    ctx.pagesConfigDependencyPaths = [
      path.join(root, 'src/packages/demo/node_modules/config/theme.ts'),
      path.join(root, 'src/packages/demo/pages/components/theme.ts'),
    ]
    const scope = watchScope(ctx)
    const watcher = chokidar.watch(scope.roots, { ignored: scope.ignored, ignoreInitial: true })
    cleanups.push(() => watcher.close())
    await once(watcher, 'ready')

    const watched = Object.fromEntries(Object.entries(watcher.getWatched())
      .map(([directory, files]) => [path.relative(root, directory).replaceAll('\\', '/'), files]))
    expect(watched['src/packages/demo/docs']).toBeUndefined()
    expect(watched['src/packages/demo/node_modules/vendor']).toBeUndefined()
    expect(watched['src/packages/demo/node_modules/config']).toEqual(['theme.ts'])
    expect(watched['src/packages/demo/pages/components']).toEqual(['theme.ts'])
    expect(watched['src/packages/demo/pages']).toContain('index.vue')
  })

  it.each([
    'src/packages/**/pages',
    'src/{packages,features}/*/pages',
    'src/packages/+(demo|other)/pages',
    'src/{packages/demo,features/demo}/pages',
  ])('keeps newly created directories reachable for %s', async (pattern) => {
    const root = project()
    const ctx = new PageContext({ subPackages: [pattern], dts: false }, root, 'h5')
    await ctx.updatePagesJSON()
    const scope = watchScope(ctx)
    const watcher = chokidar.watch(scope.roots, { ignored: scope.ignored, ignoreInitial: true })
    await startWatcher(ctx, watcher)

    writeFile(root, 'src/packages/demo/pages/index.vue')
    await expect.poll(() => {
      const output = readPages(root)
      return output.subPackages?.flatMap(subPackage => subPackage.pages.map(page =>
        path.resolve(root, ctx.options.outDir, subPackage.root, `${page.path}.vue`)))
    }, { timeout: 5_000 }).toEqual([path.join(root, 'src/packages/demo/pages/index.vue')])
  }, 10_000)

  it('treats project roots and configuration filenames as literal paths', async () => {
    const root = project('app[demo]')
    writeFile(root, 'theme[dark].ts', 'export const title = "Before"')
    const config = 'import { title } from "./theme[dark]"; export default { globalStyle: { navigationBarTitleText: title } }'
    writeFile(root, 'pages[demo].config.ts', config)
    const ctx = new PageContext({ configSource: 'pages[demo].config', subPackages: ['src/packages/*/pages'], dts: false }, root, 'h5')
    await ctx.updatePagesJSON()
    expect(readPages(root).globalStyle?.navigationBarTitleText).toBe('Before')

    const scope = watchScope(ctx)
    expect(scope.roots).toEqual([root])
    expect(scope.ignored(path.join(root, 'src/pages'))).toBe(false)
    expect(scope.ignored(path.join(root, 'src/packages/demo/pages'))).toBe(false)
    expect(scope.ignored(path.join(root, 'theme[dark].ts'))).toBe(false)
    expect(scope.ignored(path.join(root, 'node_modules'))).toBe(true)
    expect(scope.ignored(path.join(root, '../appd/src/pages'))).toBe(true)

    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
    const state = attachWatcher(ctx, watcher as unknown as FSWatcher)
    cleanups.push(() => state.dispose())
    writeFile(root, 'theme[dark].ts', 'export const title = "Dependency changed"')
    watcher.emit('all', 'change', path.join(root, 'theme[dark].ts'))
    await state.flush()
    expect(readPages(root).globalStyle?.navigationBarTitleText).toBe('Dependency changed')

    writeFile(root, 'pages[demo].config.ts', config.replace('navigationBarTitleText: title', 'navigationBarTitleText: title + " / Config changed"'))
    watcher.emit('all', 'change', path.join(root, 'pages[demo].config.ts'))
    await state.flush()
    expect(readPages(root).globalStyle?.navigationBarTitleText).toBe('Dependency changed / Config changed')

    writeFile(root, 'src/pages/index.vue', '<script setup>definePage({ style: { navigationBarTitleText: "Page changed" } })</script>')
    watcher.emit('all', 'change', path.join(root, 'src/pages/index.vue'))
    await state.flush()
    expect(ctx.pageMetaData[0].style?.navigationBarTitleText).toBe('Page changed')

    writeFile(root, 'src/packages/demo/pages/detail.vue')
    watcher.emit('all', 'addDir', path.join(root, 'src/packages/demo'))
    await state.flush()
    expect(routes(root)).toEqual(['/packages/demo/pages/detail', '/pages/index'])

    const update = vi.spyOn(ctx, 'updatePagesJSON')
    watcher.emit('all', 'change', path.join(root, 'pagesd.config.ts'))
    watcher.emit('all', 'change', path.join(root, 'themed.ts'))
    await state.flush()
    expect(update).not.toHaveBeenCalled()
  })

  it('preserves external directory patterns for a project root containing brackets', async () => {
    const root = project('app[demo]')
    const ctx = new PageContext({ subPackages: [{ dir: '../shared/*/pages', root: 'features/shared' }], dts: false }, root, 'h5')
    await ctx.updatePagesJSON()
    const scope = watchScope(ctx)
    expect(scope.roots).toEqual([path.dirname(root)])
    expect(scope.ignored(path.join(root, '../shared/demo/pages'))).toBe(false)
    expect(scope.ignored(path.join(root, '../unrelated'))).toBe(true)

    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
    const state = attachWatcher(ctx, watcher as unknown as FSWatcher)
    cleanups.push(() => state.dispose())
    writeFile(root, '../shared/demo/pages/index.vue')
    watcher.emit('all', 'addDir', path.join(root, '../shared/demo'))
    await state.flush()
    const output = readPages(root)
    expect(output.subPackages).toHaveLength(1)
    const subPackage = output.subPackages![0]
    expect(subPackage.pages).toHaveLength(1)
    const source = path.resolve(root, ctx.options.outDir, subPackage.root, `${subPackage.pages[0].path}.vue`)
    expect(source).toBe(path.resolve(root, '../shared/demo/pages/index.vue'))
    expect(fs.existsSync(source)).toBe(true)
  })

  it('subscribes to recovery dependencies after generation fails', async () => {
    const root = project()
    const ctx = new PageContext({ dts: false }, root, 'h5')
    const dependency = path.join(root, 'theme[dark].ts')
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
    const update = vi.spyOn(ctx, 'updatePagesJSON')
      .mockImplementationOnce(async () => {
        ctx.pagesConfigDependencyPaths = [dependency]
        throw new Error('Dependency is not ready')
      })
      .mockResolvedValueOnce(true)
    const hmr = vi.spyOn(ctx, 'onUpdate')
    const state = attachWatcher(ctx, watcher as unknown as FSWatcher)
    cleanups.push(() => state.dispose())
    watcher.emit('all', 'change', path.join(root, 'pages.config.ts'))
    await state.flush()
    expect(watcher.add).toHaveBeenLastCalledWith([dependency])
    expect(hmr).not.toHaveBeenCalled()

    watcher.emit('all', 'change', dependency)
    await state.flush()
    expect(update).toHaveBeenCalledTimes(2)
    expect(hmr).toHaveBeenCalledOnce()
  })

  it('discovers a new directory subtree from its ancestor event', async () => {
    const root = project()
    const ctx = new PageContext({ subPackages: ['src/packages/*/pages'], dts: false }, root, 'h5')
    await ctx.updatePagesJSON()
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
    const state = attachWatcher(ctx, watcher as unknown as FSWatcher)
    cleanups.push(() => state.dispose())

    writeFile(root, 'src/packages/alpha/pages/index.vue')
    watcher.emit('all', 'addDir', path.join(root, 'src/packages/alpha'))
    await state.flush()
    expect(routes(root)).toEqual(['/packages/alpha/pages/index', '/pages/index'])

    writeFile(root, 'src/packages/alpha/pages/nested/detail.vue')
    watcher.emit('all', 'addDir', path.join(root, 'src/packages/alpha/pages/nested'))
    await state.flush()
    expect(routes(root)).toEqual(['/packages/alpha/pages/index', '/packages/alpha/pages/nested/detail', '/pages/index'])
  })

  it('reloads every changed page macro in one event batch', async () => {
    const root = project()
    const page = (title: string): string => `<script setup>definePage({ style: { navigationBarTitleText: '${title}' } })</script>`
    writeFile(root, 'src/pages/one.vue', page('Before one'))
    writeFile(root, 'src/pages/two.vue', page('Before two'))
    const ctx = new PageContext({ dts: false }, root, 'h5')
    await ctx.updatePagesJSON()
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
    const state = attachWatcher(ctx, watcher as unknown as FSWatcher)
    cleanups.push(() => state.dispose())
    const update = vi.spyOn(ctx, 'updatePagesJSON')

    writeFile(root, 'src/pages/one.vue', page('After one'))
    writeFile(root, 'src/pages/two.vue', page('After two'))
    watcher.emit('all', 'change', path.join(root, 'src/pages/one.vue'))
    watcher.emit('all', 'change', path.join(root, 'src/pages/two.vue'))
    await state.flush()
    expect(update).toHaveBeenCalledTimes(1)
    expect(readPages(root).pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'pages/one', style: { navigationBarTitleText: 'After one' } }),
      expect.objectContaining({ path: 'pages/two', style: { navigationBarTitleText: 'After two' } }),
    ]))
  })

  it('serializes updates and emits HMR only after a completed output write', async () => {
    const root = project()
    const ctx = new PageContext({ dts: false }, root, 'h5')
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
    const complete: (() => void)[] = []
    const update = vi.spyOn(ctx, 'updatePagesJSON').mockImplementation(() => new Promise<boolean>((resolve) => {
      complete.push(() => resolve(true))
    }))
    const hmr = vi.spyOn(ctx, 'onUpdate')
    const state = attachWatcher(ctx, watcher as unknown as FSWatcher)
    cleanups.push(() => state.dispose())
    const file = path.join(root, 'src/pages/index.vue')

    watcher.emit('all', 'change', file)
    const first = state.flush()
    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(1)
    expect(hmr).not.toHaveBeenCalled()
    watcher.emit('all', 'change', file)
    const second = state.flush()
    expect(update).toHaveBeenCalledTimes(1)
    complete[0]()
    await first
    expect(hmr).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(2)
    complete[1]()
    await second
    expect(hmr).toHaveBeenCalledTimes(2)
  })
})
