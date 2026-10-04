import type { UserOptions } from '../packages/core/src'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'comment-json'
import { build, createServer, normalizePath } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UniPages, { PageContext } from '../packages/core/src'
import { isPageDirectoryEvent, isPageFileInDirectories, resolvePageWatchDirectories } from '../packages/core/src/directories'

vi.hoisted(() => vi.stubEnv('UNI_PLATFORM', 'h5'))

const roots: string[] = []
const closers: (() => Promise<unknown>)[] = []
function fixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-glob-watch-')))
  roots.push(root)
  return root
}
function page(root: string, name: string, title = name): void {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `<script setup>definePage({ style: { navigationBarTitleText: ${JSON.stringify(title)} } })</script><template><view /></template>`)
}
function read(root: string): any {
  return parse(fs.readFileSync(path.join(root, 'pages.json'), 'utf8'))
}
async function waitForPackages(root: string, expected: string[]): Promise<void> {
  await vi.waitFor(() => expect((read(root).subPackages ?? []).map((pkg: any) => pkg.root)).toEqual(expected), { timeout: 10000, interval: 25 })
}
afterEach(async () => {
  for (const close of closers.splice(0).reverse())
    await close()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

const options: UserOptions = {
  outDir: '.',
  dts: false,
  dir: 'main/*/pages',
  subPackages: [{ dir: 'nested/deep/packages/*/pages', root: dir => path.posix.dirname(dir) }],
}

async function start(root: string, mode: 'serve' | 'build', overrides: UserOptions = {}): Promise<() => Promise<unknown>> {
  vi.stubEnv('VITE_ROOT_DIR', root)
  vi.stubEnv('UNI_PLATFORM', 'h5')
  fs.writeFileSync(path.join(root, 'pages.config.json'), JSON.stringify({ pages: [{ path: 'home', type: 'home' }] }))
  let scans = 0
  const plugin = UniPages({
    ...options,
    ...overrides,
    onAfterScanPages: (pages, subPages) => {
      scans++
      overrides.onAfterScanPages?.(pages, subPages)
    },
  })
  if (mode === 'serve') {
    const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [plugin], server: { middlewareMode: true } })
    const close = () => server.close()
    closers.push(close)
    await vi.waitFor(() => expect(scans).toBeGreaterThanOrEqual(2), { timeout: 10000 })
    return close
  }
  fs.writeFileSync(path.join(root, 'entry.js'), 'export const example = 1')
  const watcher = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    build: { watch: {}, outDir: 'dist', lib: { entry: path.join(root, 'entry.js'), formats: ['es'], fileName: 'entry' } },
  })
  if (Array.isArray(watcher) || !('close' in watcher))
    throw new Error('Expected a Rollup watcher')
  const close = () => watcher.close()
  closers.push(close)
  await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'dist/entry.mjs'))).toBe(true), { timeout: 10000 })
  await vi.waitFor(() => expect(scans).toBeGreaterThanOrEqual(2), { timeout: 10000 })
  return close
}

describe.each(['serve', 'build'] as const)('%s 真实目录监听', (mode) => {
  it('发现多级缺失目录，并处理新增、重命名、删除、重建和页面元数据修改', async () => {
    const root = fixture()
    let foundEmptyDirectory = false
    await start(root, mode, {
      onAfterScanPages: (_, subPages) => {
        foundEmptyDirectory ||= subPages.has('nested/deep/packages/account/pages')
      },
    })
    await waitForPackages(root, [])
    fs.mkdirSync(path.join(root, 'nested/deep/packages/account/pages'), { recursive: true })
    await vi.waitFor(() => expect(foundEmptyDirectory).toBe(true))
    await waitForPackages(root, [])
    page(root, 'nested/deep/packages/account/pages/profile.vue', '初始')
    await waitForPackages(root, ['nested/deep/packages/account'])
    expect(read(root).subPackages[0].pages[0].path).toBe('pages/profile')
    fs.renameSync(path.join(root, 'nested/deep/packages/account'), path.join(root, 'nested/deep/packages/profile'))
    await waitForPackages(root, ['nested/deep/packages/profile'])
    fs.rmSync(path.join(root, 'nested'), { recursive: true })
    await waitForPackages(root, [])
    page(root, 'nested/deep/packages/account/pages/profile.vue', '重建')
    page(root, 'nested/deep/packages/account/pages/detail.vue', '详情')
    await waitForPackages(root, ['nested/deep/packages/account'])
    await vi.waitFor(() => expect(read(root).subPackages[0].pages).toHaveLength(2))
    page(root, 'nested/deep/packages/account/pages/profile.vue', '修改一')
    page(root, 'nested/deep/packages/account/pages/detail.vue', '修改二')
    await vi.waitFor(() => expect(read(root).subPackages[0].pages.map((page: any) => page.style.navigationBarTitleText).sort()).toEqual(['修改一', '修改二']), { timeout: 10000 })
    page(root, 'main/account/pages/index.vue')
    await vi.waitFor(() => expect(read(root).pages.some((page: any) => page.path === 'main/account/pages/index')).toBe(true))
  }, 30000)

  it('关闭后不再更新 pages.json', async () => {
    const root = fixture()
    const close = await start(root, mode)
    page(root, 'nested/deep/packages/account/pages/profile.vue')
    await waitForPackages(root, ['nested/deep/packages/account'])
    await close()
    closers.splice(closers.indexOf(close), 1)
    const before = fs.readFileSync(path.join(root, 'pages.json'), 'utf8')
    page(root, 'nested/deep/packages/order/pages/list.vue')
    // 负向断言需给文件系统事件足够时间，确认已关闭的 watcher 没有继续生成
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(fs.readFileSync(path.join(root, 'pages.json'), 'utf8')).toBe(before)
  }, 30000)

  it('发现项目根以外新增的多级目录', async () => {
    const workspace = fixture()
    const root = path.join(workspace, 'app')
    fs.mkdirSync(root)
    await start(root, mode, { subPackages: ['../external/deep/*/pages'] })
    page(workspace, 'external/deep/account/pages/profile.vue')
    await waitForPackages(root, ['../external/deep/account/pages'])
    expect(read(root).subPackages[0].pages[0].path).toBe('profile')
  }, 30000)
})

describe('目录监听边界', () => {
  it('页面目录和排除项使用目录边界，不接受相邻前缀', () => {
    const root = fixture()
    const ctx = new PageContext({ dir: 'src/pages', subPackages: ['src/packages/*/pages'], exclude: ['**/hidden/**', '**/__*__/**'] }, root)
    expect(isPageFileInDirectories(path.join(root, 'src/pages-sub/a.vue'), ctx.options)).toBe(false)
    expect(isPageFileInDirectories(path.join(root, 'src/packages/account/pages/a.vue'), ctx.options)).toBe(true)
    expect(isPageFileInDirectories(path.join(root, 'src/packages/hidden/pages/a.vue'), ctx.options)).toBe(false)
    expect(isPageFileInDirectories(path.join(root, 'src/packages/account/pages/__private__/a.vue'), ctx.options)).toBe(false)
    expect(isPageDirectoryEvent(path.join(root, 'src/packages/hidden/pages'), ctx.options)).toBe(false)
    expect(isPageDirectoryEvent(path.join(root, 'src/components'), ctx.options)).toBe(false)
    expect(resolvePageWatchDirectories(ctx.options)).toEqual([normalizePath(root)])
  })

  it('项目根外的缺失目录使用外部已有祖先', () => {
    const root = fixture()
    const app = path.join(root, 'app')
    fs.mkdirSync(app)
    const ctx = new PageContext({ dir: 'pages', subPackages: ['../external/deep/*/pages'] }, app)
    expect(resolvePageWatchDirectories(ctx.options)).toEqual([normalizePath(root)])
    expect(isPageFileInDirectories(path.join(root, 'external/deep/account/pages/a.vue'), ctx.options)).toBe(true)
  })

  it('完整生成串行执行并保留随后修改页面的 filepath', async () => {
    const root = fixture()
    page(root, 'pages/a.vue', '旧 A')
    page(root, 'pages/b.vue', '旧 B')
    const ctx = new PageContext({ dir: 'pages', outDir: '.', dts: false }, root, 'h5')
    await ctx.updatePagesJSON()
    const load = ctx.loadUserPagesConfig.bind(ctx)
    let running = 0
    let maximum = 0
    vi.spyOn(ctx, 'loadUserPagesConfig').mockImplementation(async () => {
      running++
      maximum = Math.max(maximum, running)
      await load()
      await new Promise(resolve => setTimeout(resolve, 10))
      running--
    })
    page(root, 'pages/a.vue', '新 A')
    page(root, 'pages/b.vue', '新 B')
    await Promise.all([
      ctx.updatePagesJSON(),
      ctx.updatePagesJSON(normalizePath(path.join(root, 'pages/a.vue'))),
      ctx.updatePagesJSON(normalizePath(path.join(root, 'pages/b.vue'))),
    ])
    expect(maximum).toBe(1)
    expect(read(root).pages.map((page: any) => page.style.navigationBarTitleText).sort()).toEqual(['新 A', '新 B'])
  })

  it('解绑后共享 Vite watcher 仍可服务其他监听者', async () => {
    const root = fixture()
    const ctx = new PageContext({ dir: 'pages', outDir: '.', dts: false }, root, 'h5')
    await ctx.updatePagesJSON()
    let ready = false
    const server = await createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true },
      plugins: [{
        name: 'observe-watcher-ready',
        configureServer(server) {
          server.watcher.on('ready', () => {
            ready = true
          })
        },
      }],
    })
    closers.push(() => server.close())
    ctx.setupViteServer(server)
    await vi.waitFor(() => expect(ready).toBe(true))
    const onAdd = vi.fn()
    server.watcher.on('add', onAdd)
    await ctx.disposeWatchers()
    const before = fs.readFileSync(path.join(root, 'pages.json'), 'utf8')
    page(root, 'pages/a.vue')
    await vi.waitFor(() => expect(onAdd).toHaveBeenCalled())
    expect(fs.readFileSync(path.join(root, 'pages.json'), 'utf8')).toBe(before)
  })
})
