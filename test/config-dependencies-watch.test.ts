import type { FSWatcher } from 'vite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'comment-json'
import { build, createServer, normalizePath } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UniPages from '../packages/core/src'
import { PageContext } from '../packages/core/src/context'

vi.hoisted(() => vi.stubEnv('UNI_PLATFORM', 'h5'))

let root: string
let close: (() => Promise<unknown>) | undefined
const write = (file: string, content: string): void => fs.writeFileSync(path.join(root, file), content)
const output = (): any => parse(fs.readFileSync(path.join(root, 'src/pages.json'), 'utf8'))
async function waitTitle(title: string): Promise<void> {
  await vi.waitFor(() => expect(output().globalStyle.navigationBarTitleText).toBe(title), { timeout: 10000, interval: 20 })
}

beforeEach(() => {
  vi.stubEnv('UNI_PLATFORM', 'h5')
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-watch-deps-')))
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true })
  write('package.json', '{"type":"module"}')
  write('src/pages/index.vue', '<template><view/></template>')
  write('entry.js', 'export const value = 1')
  write('pages.config.ts', `import { title } from './leaf.ts'; export default { globalStyle: { navigationBarTitleText: title } }`)
  write('leaf.ts', `export const title = 'initial'`)
  vi.stubEnv('VITE_ROOT_DIR', root)
})
afterEach(async () => {
  await close?.()
  close = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

async function start(mode: 'dev' | 'build'): Promise<{ watcher: FSWatcher, scheduledUpdates: () => number, settleUpdates: () => Promise<void> }> {
  const updates = vi.spyOn(PageContext.prototype, 'updatePagesJSON')
  const settleUpdates = async (): Promise<void> => {
    await Promise.allSettled(updates.mock.results.map(result => result.value))
  }
  let watched: FSWatcher | undefined
  let ready!: () => void
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve
  })
  const setup = PageContext.prototype.setupWatcher
  vi.spyOn(PageContext.prototype, 'setupWatcher').mockImplementation(async function (this: PageContext, watcher) {
    watched = watcher as unknown as FSWatcher
    watched.once('ready', ready)
    return setup.call(this, watcher)
  })
  const plugin = UniPages({ dts: true })
  if (mode === 'dev') {
    const server = await createServer({
      root,
      configFile: false,
      plugins: [plugin],
      css: { postcss: {} },
      server: { middlewareMode: true, hmr: false },
      logLevel: 'silent',
    })
    close = () => server.close()
  }
  else {
    const result = await build({
      root,
      configFile: false,
      plugins: [plugin],
      css: { postcss: {} },
      logLevel: 'silent',
      build: { watch: {}, lib: { entry: path.join(root, 'entry.js'), formats: ['es'] }, minify: false },
    })
    if (Array.isArray(result) || !('on' in result))
      throw new Error('Expected a watch build')
    close = () => result.close()
  }
  await readyPromise
  await settleUpdates()
  expect(watched).toBeDefined()
  return { watcher: watched!, scheduledUpdates: () => updates.mock.calls.length, settleUpdates }
}

describe('真实配置依赖 watcher', () => {
  it.each(['dev', 'build'] as const)('%s 监听依赖变更、切换依赖及删除恢复，并释放监听', async (mode) => {
    fs.mkdirSync(path.join(root, 'node_modules/unused'), { recursive: true })
    write('node_modules/unused/index.js', 'export default {}')
    write('old-leaf.ts', `export const suffix = ''`)
    write('pages.config.ts', `import { title } from './leaf.ts'; import { suffix } from './old-leaf.ts'; export default { globalStyle: { navigationBarTitleText: title + suffix } }`)
    const { watcher, scheduledUpdates, settleUpdates } = await start(mode)
    await waitTitle('initial')
    expect(Object.keys(watcher.getWatched()).some(directory => normalizePath(directory).includes('/node_modules'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'uni-pages.d.ts'), 'utf8')).toContain('pages/index')
    write('leaf.ts', `export const title = 'changed'`)
    await waitTitle('changed')
    write('next.json', '{"title":"next"}')
    write('pages.config.ts', `import value from './next.json'; export default { globalStyle: { navigationBarTitleText: value.title } }`)
    await waitTitle('next')
    await settleUpdates()
    let before = 0
    let unusedEventUpdates: number | undefined
    const isUnusedFile = (file: string): boolean => normalizePath(file) === normalizePath(path.join(root, 'old-leaf.ts'))
    const beforeEvent = (file: string): void => {
      if (isUnusedFile(file))
        before = scheduledUpdates()
    }
    const afterEvent = (file: string): void => {
      if (!isUnusedFile(file))
        return
      watcher.off('change', beforeEvent)
      watcher.off('change', afterEvent)
      unusedEventUpdates = scheduledUpdates() - before
    }
    // 只比较当前事件的调度，已排队的初始化或配置生成不会影响断言
    watcher.prependListener('change', beforeEvent)
    watcher.on('change', afterEvent)
    write('old-leaf.ts', `export const suffix = 'unused'`)
    await vi.waitFor(() => expect(unusedEventUpdates).toBe(0))
    write('next.json', '{"title":"json-updated"}')
    await waitTitle('json-updated')

    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Promise<void>((resolve) => {
      const load = PageContext.prototype.loadUserPagesConfig
      vi.spyOn(PageContext.prototype, 'loadUserPagesConfig').mockImplementation(async function (this: PageContext) {
        try {
          await load.call(this)
        }
        catch (error) {
          resolve()
          throw error
        }
      })
    })
    fs.unlinkSync(path.join(root, 'next.json'))
    await failure
    expect(output().globalStyle.navigationBarTitleText).toBe('json-updated')
    write('next.json', '{"title":"recovered"}')
    await waitTitle('recovered')
    logger.mockRestore()

    fs.unlinkSync(path.join(root, 'pages.config.ts'))
    await vi.waitFor(() => expect(output().globalStyle).toBeUndefined())
    write('pages.config.ts', `export default { globalStyle: { navigationBarTitleText: 'entry-restored' } }`)
    await waitTitle('entry-restored')

    await close!()
    close = undefined
    expect(Object.keys(watcher.getWatched())).toEqual([])
  }, 30000)

  it.each([
    ['./leaf-next', 'leaf-next.tsx'],
    ['./dot.name', 'dot.name.ts'],
    ['./typed.js', 'typed.ts'],
  ])('h5 缺失导入 %s 在创建 %s 后恢复', async (specifier, filename) => {
    await start('dev')
    await waitTitle('initial')
    const load = PageContext.prototype.loadUserPagesConfig
    let failed = false
    vi.spyOn(PageContext.prototype, 'loadUserPagesConfig').mockImplementation(async function (this: PageContext) {
      try {
        await load.call(this)
      }
      catch (error) {
        failed = true
        throw error
      }
    })
    write('pages.config.ts', `import { title } from '${specifier}'; export default { globalStyle: { navigationBarTitleText: title } }`)
    await vi.waitFor(() => expect(failed).toBe(true))
    write(filename, `export const title = 'resolved'`)
    await waitTitle('resolved')
  }, 15000)

  it('h5 新依赖执行失败后，只修复依赖也能恢复', async () => {
    await start('dev')
    await waitTitle('initial')
    const load = PageContext.prototype.loadUserPagesConfig
    let failed = false
    vi.spyOn(PageContext.prototype, 'loadUserPagesConfig').mockImplementation(async function (this: PageContext) {
      try {
        await load.call(this)
      }
      catch (error) {
        failed = true
        throw error
      }
    })
    write('throws.ts', `throw new Error('runtime failure'); export const title = 'unused'`)
    write('pages.config.ts', `import { title } from './throws.ts'; export default { globalStyle: { navigationBarTitleText: title } }`)
    await vi.waitFor(() => expect(failed).toBe(true))
    expect(output().globalStyle.navigationBarTitleText).toBe('initial')
    write('throws.ts', `export const title = 'runtime-fixed'`)
    await waitTitle('runtime-fixed')
  }, 15000)

  it('h5 的语法错误和新增缺失导入修复后继续更新', async () => {
    await start('dev')
    await waitTitle('initial')
    const load = PageContext.prototype.loadUserPagesConfig
    let failed = 0
    vi.spyOn(PageContext.prototype, 'loadUserPagesConfig').mockImplementation(async function (this: PageContext) {
      try {
        await load.call(this)
      }
      catch (error) {
        failed++
        throw error
      }
    })
    write('leaf.ts', 'export const title =')
    await vi.waitFor(() => expect(failed).toBeGreaterThan(0))
    write('leaf.ts', `export const title = 'syntax-fixed'`)
    await waitTitle('syntax-fixed')
    const previous = failed
    write('pages.config.ts', `import { title } from './missing/title'; export default { globalStyle: { navigationBarTitleText: title } }`)
    await vi.waitFor(() => expect(failed).toBeGreaterThan(previous))
    fs.mkdirSync(path.join(root, 'missing'))
    write('missing/title.ts', `export const title = 'created'`)
    await waitTitle('created')
  }, 30000)
})
