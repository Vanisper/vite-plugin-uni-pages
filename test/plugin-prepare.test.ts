import type { PagesConfig, UserOptions } from '../packages/core/src'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseJSON } from 'comment-json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UniPages from '../packages/core/src'

const runtime = vi.hoisted(() => ({ platform: 'h5' }))

vi.mock('../packages/core/node_modules/@uni-helper/uni-env', () => ({
  get platform() { return runtime.platform },
}))

let root: string
let pagesPath: string
let declarationPath: string

function writeFile(relativePath: string, content: string): void {
  const destination = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, content)
}

function page(metadata: Record<string, unknown> = {}): string {
  return `<script setup>definePage(${JSON.stringify(metadata)})</script><template><view /></template>`
}

function createPlugin(options: UserOptions = {}) {
  return UniPages({
    dir: 'src/pages',
    subPackages: [{ dir: 'src/packages/demo/pages', root: 'packages/demo' }],
    dts: declarationPath,
    platformSuffix: true,
    ...options,
  })
}

async function configure(plugin: ReturnType<typeof UniPages>, { configRoot = root, withPlatformPlugin = false } = {}): Promise<void> {
  const hook = plugin.configResolved!
  const handler = typeof hook === 'function' ? hook : hook.handler
  await handler({
    root: configRoot,
    command: 'build',
    build: { watch: false },
    plugins: withPlatformPlugin ? [{ name: 'vite-plugin-uni-platform' }] : [],
  } as unknown as Parameters<typeof handler>[0])
}

function readPages(): PagesConfig {
  return parseJSON(fs.readFileSync(pagesPath, 'utf8')) as PagesConfig
}

function readOutputs(): string[] {
  return [pagesPath, declarationPath].map(file => fs.readFileSync(file, 'utf8'))
}

beforeEach(() => {
  runtime.platform = 'h5'
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-prepare-'))
  pagesPath = path.join(root, 'src/pages.json')
  declarationPath = path.join(root, 'src/routes.d.ts')
  vi.stubEnv('VITE_ROOT_DIR', root)

  writeFile('pages.config.mjs', `export default {
    pages: [],
    globalStyle: { navigationBarTitleText: '共享配置' },
    tabBar: { color: '#999999', selectedColor: '#000000' },
  }`)
  writeFile('src/pages/index.vue', page({ tabBar: { text: '首页', index: -1 } }))
  writeFile('src/pages/profile.h5.vue', page({ tabBar: { text: '网页', index: 1 } }))
  writeFile('src/pages/profile.mp-weixin.vue', page({ tabBar: { text: '微信', index: 1 } }))
  writeFile('src/packages/demo/pages/detail.h5.vue', page({ style: { navigationBarTitleText: '网页详情' } }))
  writeFile('src/packages/demo/pages/detail.mp-weixin.vue', page({ style: { navigationBarTitleText: '微信详情' } }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('插件提前准备', () => {
  it.each(['h5', 'mp-weixin'])('%s 的并发准备、重复准备和 Vite 接管复用一次完整扫描', async (platform) => {
    runtime.platform = platform
    const onBeforeScanPages = vi.fn()
    const plugin = createPlugin({ onBeforeScanPages })
    const environment = { root, platform }

    expect(plugin.name).toBe('vite-plugin-uni-pages')
    expect(plugin).not.toHaveProperty('then')
    await expect(Promise.all([plugin.prepare(environment), plugin.prepare({ ...environment })])).resolves.toEqual([undefined, undefined])
    await plugin.prepare(environment)

    const prepared = readOutputs()
    const output = readPages()
    expect(onBeforeScanPages).toHaveBeenCalledTimes(1)
    expect(output.globalStyle?.navigationBarTitleText).toBe('共享配置')
    expect(output.pages!.map(page => page.path)).toEqual(['pages/index', 'pages/profile'])
    expect(output.subPackages).toEqual([expect.objectContaining({
      root: 'packages/demo',
      pages: [expect.objectContaining({
        path: 'pages/detail',
        style: { navigationBarTitleText: platform === 'h5' ? '网页详情' : '微信详情' },
      })],
    })])
    expect(output.tabBar?.list).toEqual([
      { pagePath: 'pages/index', text: '首页' },
      { pagePath: 'pages/profile', text: platform === 'h5' ? '网页' : '微信' },
    ])
    expect(prepared[1]).toContain('"/packages/demo/pages/detail"')
    expect(prepared[1]).toContain('"/pages/profile"')
    expect(prepared[1]).not.toMatch(/\.h5|\.mp-weixin/)

    await configure(plugin, { withPlatformPlugin: true })
    expect(onBeforeScanPages).toHaveBeenCalledTimes(1)
    expect(readOutputs()).toEqual(prepared)
  })

  it('省略环境时使用 VITE_ROOT_DIR 与运行平台', async () => {
    runtime.platform = 'mp-weixin'
    const plugin = createPlugin()
    await plugin.prepare()
    expect(readPages().tabBar?.list?.[1]?.text).toBe('微信')
    await configure(plugin)
  })

  it('关闭声明生成时只准备页面配置', async () => {
    const plugin = createPlugin({ dts: false })
    await plugin.prepare()
    expect(readPages().pages?.[0].path).toBe('pages/index')
    expect(fs.existsSync(declarationPath)).toBe(false)
    await configure(plugin)
  })

  it('相对声明路径以 prepare 指定的根目录解析', async () => {
    const overrideRoot = path.join(root, 'application')
    writeFile('application/src/pages/index.vue', page())
    const plugin = createPlugin({ dts: 'src/routes.d.ts', subPackages: [] })

    await plugin.prepare({ root: overrideRoot, platform: 'h5' })
    const declaration = fs.readFileSync(path.join(overrideRoot, 'src/routes.d.ts'), 'utf8')
    expect(declaration).toContain('"/pages/index"')
    expect(fs.existsSync(declarationPath)).toBe(false)
    await configure(plugin, { configRoot: overrideRoot })
    expect(fs.readFileSync(path.join(overrideRoot, 'src/routes.d.ts'), 'utf8')).toBe(declaration)
  })

  it('准备前必须显式确定平台后缀规则，并保留既有文件', async () => {
    writeFile('src/pages.json', '{"pages":[{"path":"pages/previous"}]}')
    writeFile('src/routes.d.ts', '// previous declaration')
    const original = readOutputs()
    const plugin = createPlugin({ platformSuffix: undefined })

    await expect(plugin.prepare({ root, platform: 'h5' })).rejects.toThrow(/platformSuffix/)
    expect(readOutputs()).toEqual(original)
  })

  it('在 Vite 初始化后拒绝再启动提前准备', async () => {
    const plugin = createPlugin()
    await configure(plugin)
    const original = readOutputs()

    await expect(plugin.prepare({ root, platform: 'h5' })).rejects.toThrow(/configResolved/)
    expect(readOutputs()).toEqual(original)
  })

  it.each(['扫描前', '写入后'])('%s失败保留既有产物，修正后可重试并复用成功结果', async (stage) => {
    writeFile('src/pages.json', '{"pages":[{"path":"pages/previous"}]}')
    writeFile('src/routes.d.ts', '// previous declaration')
    const original = readOutputs()
    const failure = new Error('配置暂未就绪')
    let fail = true
    const onBeforeScanPages = vi.fn(() => {
      if (fail && stage === '扫描前')
        throw failure
    })
    const plugin = createPlugin({
      onBeforeScanPages,
      onAfterWriteFile() {
        if (fail && stage === '写入后')
          throw failure
      },
    })

    const attempts = await Promise.allSettled([plugin.prepare(), plugin.prepare()])
    expect(attempts).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    expect(onBeforeScanPages).toHaveBeenCalledTimes(1)
    expect(readOutputs()).toEqual(original)

    fail = false
    await plugin.prepare()
    expect(onBeforeScanPages).toHaveBeenCalledTimes(2)
    expect(readPages().pages?.[0].path).toBe('pages/index')
    expect(readOutputs()[1]).toContain('"/pages/profile"')
    await configure(plugin)
    expect(onBeforeScanPages).toHaveBeenCalledTimes(2)
  })

  it('回滚只恢复仍是本次生成内容的文件，不覆盖外部修改', async () => {
    writeFile('src/pages.json', '{"pages":[{"path":"pages/previous"}]}')
    writeFile('src/routes.d.ts', '// previous declaration')
    const failure = new Error('后置校验失败')
    const external = '{"pages":[{"path":"pages/external"}]}'
    const plugin = createPlugin({
      onAfterWriteFile() {
        fs.writeFileSync(pagesPath, external)
        throw failure
      },
    })

    await expect(plugin.prepare()).rejects.toBe(failure)
    expect(readOutputs()).toEqual([external, '// previous declaration'])
  })

  it('写入后失败会移除本次创建的声明文件', async () => {
    const plugin = createPlugin({
      onAfterWriteFile() {
        throw new Error('校验失败')
      },
    })
    const placeholder = fs.readFileSync(pagesPath, 'utf8')

    await expect(plugin.prepare()).rejects.toThrow('校验失败')
    expect(fs.readFileSync(pagesPath, 'utf8')).toBe(placeholder)
    expect(fs.existsSync(declarationPath)).toBe(false)
  })

  it('准备期间页面变化会拒绝结果并恢复既有产物', async () => {
    writeFile('src/pages.json', '{"pages":[{"path":"pages/previous"}]}')
    writeFile('src/routes.d.ts', '// previous declaration')
    const original = readOutputs()
    const plugin = createPlugin({
      onAfterScanPages() {
        writeFile('src/pages/late.vue', page())
      },
    })

    await expect(plugin.prepare()).rejects.toThrow()
    expect(readOutputs()).toEqual(original)
    expect(fs.existsSync(path.join(root, 'src/pages/late.vue'))).toBe(true)
  })

  it('准备期间产物被外部改写会拒绝结果并保留该修改', async () => {
    writeFile('src/pages.json', '{"pages":[{"path":"pages/previous"}]}')
    writeFile('src/routes.d.ts', '// previous declaration')
    const external = '{"pages":[{"path":"pages/external"}]}'
    const plugin = createPlugin({
      onAfterWriteFile() {
        fs.writeFileSync(pagesPath, external)
      },
    })

    await expect(plugin.prepare()).rejects.toThrow()
    expect(readOutputs()).toEqual([external, '// previous declaration'])
  })

  it('成功准备后拒绝改变根目录或平台，原环境仍可接管', async () => {
    const plugin = createPlugin()
    await plugin.prepare({ root, platform: 'h5' })
    const prepared = readOutputs()

    await expect(plugin.prepare({ root: path.join(root, 'other'), platform: 'h5' })).rejects.toThrow()
    await expect(plugin.prepare({ root, platform: 'mp-weixin' })).rejects.toThrow()
    await expect(configure(plugin, { configRoot: path.join(root, 'other') })).rejects.toThrow()
    expect(readOutputs()).toEqual(prepared)
    await configure(plugin)
  })

  it('实际运行平台与显式准备平台不同时拒绝 Vite 接管', async () => {
    runtime.platform = 'mp-weixin'
    const plugin = createPlugin()
    await plugin.prepare({ root, platform: 'h5' })
    const prepared = readOutputs()

    await expect(configure(plugin)).rejects.toThrow(/platform/)
    expect(readOutputs()).toEqual(prepared)
  })

  it.each(['新增页面', '修改页面', '修改配置'])('准备后%s时拒绝接管，并保留下游已读取的产物', async (change) => {
    const onBeforeScanPages = vi.fn()
    const plugin = createPlugin({ onBeforeScanPages })
    await plugin.prepare()
    const prepared = readOutputs()

    if (change === '新增页面')
      writeFile('src/pages/late.vue', page())
    else if (change === '修改页面')
      writeFile('src/pages/index.vue', page({ style: { navigationBarTitleText: '新标题' } }))
    else
      writeFile('pages.config.mjs', 'export default { globalStyle: { navigationBarTitleText: "新配置" } }')

    await expect(configure(plugin)).rejects.toThrow()
    expect(onBeforeScanPages).toHaveBeenCalledTimes(1)
    expect(readOutputs()).toEqual(prepared)
  })

  it.each([0, 1])('产物 %i 被外部修改后拒绝接管，并保留外部内容', async (index) => {
    const plugin = createPlugin()
    await plugin.prepare()
    const prepared = readOutputs()
    const file = [pagesPath, declarationPath][index]
    const external = index === 0 ? '{"pages":[{"path":"pages/external"}]}' : '// externally changed declaration'
    fs.writeFileSync(file, external)

    await expect(configure(plugin)).rejects.toThrow()
    prepared[index] = external
    expect(readOutputs()).toEqual(prepared)
  })
})

describe('平台后缀配置', () => {
  it.each([
    { suffix: true, detected: false, normalized: true },
    { suffix: false, detected: true, normalized: false },
    { suffix: undefined, detected: true, normalized: true },
    { suffix: undefined, detected: false, normalized: false },
  ])('显式规则 $suffix 优先于插件检测 $detected', async ({ suffix, detected, normalized }) => {
    const plugin = createPlugin({ platformSuffix: suffix })
    await configure(plugin, { withPlatformPlugin: detected })
    const output = readPages()
    const paths = normalized ? ['pages/index', 'pages/profile'] : ['pages/index', 'pages/profile.h5', 'pages/profile.mp-weixin']

    expect(output.pages!.map(page => page.path)).toEqual(paths)
    expect(output.tabBar?.list?.map(item => item!.pagePath)).toEqual(paths)
    expect(output.subPackages?.[0].pages.map(page => page.path)).toEqual(normalized
      ? ['pages/detail']
      : ['pages/detail.h5', 'pages/detail.mp-weixin'])
  })

  it.each(['h5', 'mp-weixin'])('%s 的手动页面和 TabBar 按声明顺序合并平台变体', async (platform) => {
    runtime.platform = platform
    const variants = [
      { suffix: '', text: '默认' },
      { suffix: '.h5', text: '网页' },
      { suffix: '.mp-weixin', text: '微信' },
    ]
    writeFile('pages.config.mjs', `export default ${JSON.stringify({
      pages: variants.map(({ suffix, text }) => ({ path: `pages/profile${suffix}`, style: { navigationBarTitleText: text } })),
      tabBar: { list: variants.map(({ suffix, text }) => ({ pagePath: `pages/profile${suffix}`, text })) },
    })}`)
    const plugin = createPlugin({ mergePages: false, homePage: 'pages/profile' })

    await plugin.prepare()
    const prepared = readOutputs()
    const output = readPages()
    const text = platform === 'h5' ? '网页' : '微信'
    expect(output.pages).toEqual([expect.objectContaining({ path: 'pages/profile', style: { navigationBarTitleText: text } })])
    expect(output.tabBar?.list).toEqual([{ pagePath: 'pages/profile', text }])
    expect(output.subPackages ?? []).toEqual([])
    await configure(plugin)
    expect(readOutputs()).toEqual(prepared)
  })

  it.each(['h5', 'mp-weixin'])('%s 的后缀首页归一化后仍排在首位', async (platform) => {
    runtime.platform = platform
    fs.unlinkSync(path.join(root, 'src/pages/index.vue'))
    writeFile('src/pages/aaa.vue', page())
    writeFile('src/pages/index.h5.vue', page())
    writeFile('src/pages/index.mp-weixin.vue', page())
    const plugin = createPlugin({ homePage: 'pages/index' })

    await plugin.prepare()
    expect(readPages().pages?.[0].path).toBe('pages/index')
    await configure(plugin)
    expect(readPages().pages?.[0].path).toBe('pages/index')
  })
})
