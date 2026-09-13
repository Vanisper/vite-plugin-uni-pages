import type { FSWatcher } from 'chokidar'
import type { Plugin, ViteDevServer } from 'vite'
import type { PipelineOverrides } from './pipeline'
import type { UserOptions } from './types'
import path from 'node:path'
import process from 'node:process'
import { platform as uniEnvPlatform } from '@uni-helper/uni-env'
import chokidar from 'chokidar'
import MagicString from 'magic-string'
import { createLogger, normalizePath } from 'vite'
import {
  FILE_EXTENSIONS,
  MODULE_ID_VIRTUAL,
  RESOLVED_MODULE_ID_VIRTUAL,
} from './constant'
import { PageContext } from './context'
import { checkPagesJsonFileSync, resolvePagesJsonPath } from './files'
import { findDefinePageMacro } from './macro'
import { assertPreparedContext, prepareContext } from './preparation'
import { watchScope } from './scan'

export * from './condition'
export * from './config'
export * from './constant'
export * from './context'
export * from './files'
export * from './logger'
export * from './macro'
export * from './options'
export * from './page'
export * from './pages-json'
export * from './pipeline'
export type * from './types'
export type * from '@uni-helper/uni-pages-types'

/** 支持提前准备页面配置的 Vite 插件 */
export interface UniPagesPlugin extends Plugin {
  /**
   * 提前生成 pages.json 与声明文件，完成后可供下游插件读取
   *
   * @description
   * - 在 Vite 初始化前调用，并显式设置 platformSuffix
   * - 同一环境的并发或重复调用复用结果；失败后可重试
   * - Vite 接管时校验根目录、平台、输入文件与生成产物未变化
   */
  prepare: (overrides?: PipelineOverrides) => Promise<void>
}

/**
 * vite-plugin-uni-pages 插件主入口
 *
 * 自动扫描页面目录并生成 pages.json 配置文件
 * 支持 definePage 宏定义页面配置
 * 支持多平台条件编译
 * 支持分包配置
 * 支持 TypeScript 声明文件生成
 *
 * @param userOptions - 用户配置项
 * @returns Vite 插件实例
 */
export function VitePluginUniPages(userOptions: UserOptions = {}): UniPagesPlugin {
  let ctx: PageContext
  let ownedWatcher: FSWatcher | undefined
  let server: ViteDevServer | undefined
  let watchBuild = false
  let resolved = false
  let preparePromise: Promise<void> | undefined
  let prepared: Awaited<ReturnType<typeof prepareContext>> | undefined
  let prepareEnvironment: { root: string, platform: string, platformSuffix: boolean } | undefined

  const assertPrepared = (): void => {
    if (prepared)
      assertPreparedContext(ctx, prepared)
  }

  const onWatcherError = (error: unknown): void => {
    ctx.logger?.error(error instanceof Error ? error.stack ?? error.message : String(error))
  }
  const dispose = async (): Promise<void> => {
    server?.httpServer?.off('close', onServerClose)
    await ctx?.disposeWatcher()
    const watcher = ownedWatcher
    ownedWatcher = undefined
    if (watcher) {
      watcher.off('error', onWatcherError)
      await watcher.close()
    }
  }
  function onServerClose(): void {
    void dispose()
  }

  // 同步保留占位行为，完整产物由 prepare 或 configResolved 生成
  const resolvedPagesJSONPath = resolvePagesJsonPath(
    process.env.VITE_ROOT_DIR || process.cwd(),
    userOptions.outDir ?? 'src',
  )
  checkPagesJsonFileSync(resolvedPagesJSONPath)

  return {
    name: 'vite-plugin-uni-pages',
    enforce: 'pre',
    prepare(overrides = {}) {
      if (resolved)
        return Promise.reject(new Error('[vite-plugin-uni-pages] prepare() must run before configResolved'))
      if (typeof userOptions.platformSuffix !== 'boolean')
        return Promise.reject(new Error('[vite-plugin-uni-pages] prepare() requires an explicit platformSuffix option'))
      const environment = {
        root: normalizePath(path.resolve(overrides.root ?? process.env.VITE_ROOT_DIR ?? process.cwd())),
        platform: overrides.platform ?? uniEnvPlatform,
        platformSuffix: userOptions.platformSuffix,
      }
      if (preparePromise) {
        if (JSON.stringify(environment) !== JSON.stringify(prepareEnvironment))
          return Promise.reject(new Error('[vite-plugin-uni-pages] prepare() root, platform and platformSuffix must remain unchanged'))
        return preparePromise
      }
      prepareEnvironment = environment
      preparePromise = (async () => {
        const candidate = new PageContext(userOptions, environment.root, environment.platform)
        candidate.setLogger(createLogger(undefined, { prefix: '[vite-plugin-uni-pages]' }))
        const snapshot = await prepareContext(candidate)
        ctx = candidate
        prepared = snapshot
      })().catch((error: unknown) => {
        preparePromise = undefined
        prepareEnvironment = undefined
        throw error
      })
      return preparePromise
    },
    /**
     * Vite configResolved 钩子
     * 初始化 PageContext，设置 logger，生成初始 pages.json
     */
    async configResolved(config) {
      resolved = true
      await preparePromise
      const suffix = userOptions.platformSuffix ?? config.plugins.some(plugin => plugin.name === 'vite-plugin-uni-platform')
      if (prepared) {
        if (prepareEnvironment!.root !== normalizePath(path.resolve(config.root))
          || prepareEnvironment!.platform !== uniEnvPlatform
          || prepareEnvironment!.platformSuffix !== suffix) {
          throw new Error('[vite-plugin-uni-pages] Resolved root, platform or platformSuffix differs from prepare(); recreate the plugin with the final environment')
        }
        assertPrepared()
      }
      else {
        ctx = new PageContext(userOptions, config.root)
        ctx.withUniPlatform = suffix
        ctx.setLogger(createLogger(undefined, { prefix: '[vite-plugin-uni-pages]' }))
        await ctx.updatePagesJSON()
      }

      watchBuild = config.command === 'build' && !!config.build.watch
      if (watchBuild) {
        const scope = watchScope(ctx)
        const watcher = chokidar.watch(scope.roots, { ignoreInitial: true, ignored: scope.ignored })
        ownedWatcher = watcher
        watcher.on('error', onWatcherError)
        try {
          await new Promise<void>((resolve, reject) => {
            function onReady(): void {
              watcher.off('error', onError)
              resolve()
            }
            function onError(error: unknown): void {
              watcher.off('ready', onReady)
              reject(error)
            }
            watcher.once('ready', onReady)
            watcher.once('error', onError)
          })
          assertPrepared()
          await ctx.setupWatcher(watcher)
          // 普通初始化补齐监听建立期间的变更；提前准备则必须保持既有快照
          if (!prepared)
            await ctx.updatePagesJSON()
        }
        catch (error) {
          await dispose()
          throw error
        }
      }
    },
    /**
     * 代码转换钩子
     * 从 Vue SFC 中移除 definePage 宏调用，避免运行时报错
     */
    async transform(code: string, id: string) {
      if (!FILE_EXTENSIONS.some(ext => id.endsWith(ext))) {
        return null
      }

      // 每个 script 块单独解析（在宏模块里）：一个块有语法错误
      // （比如 @babel/parser 8 删掉的旧 `assert { ... }` 写法），
      // 另一个块的宏照样能找到、照样删
      const macro = findDefinePageMacro(code, id, {
        onParseError: (block, error) => {
          this.warn(`[vite-plugin-uni-pages] Failed to parse ${block} in ${id}, its definePage macro may stay in the output: ${error instanceof Error ? error?.message : error}`)
        },
      })

      if (!macro)
        return null

      const s = new MagicString(code)
      s.remove(macro.start!, macro.end!)

      if (s.hasChanged()) {
        return {
          code: s.toString(),
          // magic-string v1 给 `sourcesContent` 的类型是
          // `(string | null)[]`，和 rollup 的 `ExistingRawSourceMap`
          // 对不上；转成 JSON 字符串后 `SourceMapInput` 能收，
          // 绕开了类型不匹配
          map: s.generateMap({
            source: id,
            includeContent: true,
            file: `${id}.map`,
          }).toString(),
        }
      }
    },
    /**
     * 配置开发服务器钩子
     * 设置文件监听与 HMR 支持
     */
    configureServer(viteServer) {
      assertPrepared()
      server = viteServer
      ctx.setupViteServer(server)
      server.httpServer?.once('close', onServerClose)
    },
    async closeBundle() {
      // watch 构建的每轮产出都会关闭 bundle，监听保留到 closeWatcher
      if (!watchBuild)
        await dispose()
    },
    async closeWatcher() {
      await dispose()
    },
    /**
     * 模块解析钩子
     * 将虚拟模块标识符解析为内部路径
     */
    resolveId(id) {
      if (id === MODULE_ID_VIRTUAL)
        return RESOLVED_MODULE_ID_VIRTUAL
    },
    /**
     * 模块加载钩子
     * 返回虚拟模块的代码内容
     */
    load(id) {
      if (id === RESOLVED_MODULE_ID_VIRTUAL)
        return ctx.virtualModule()
    },
  }
}

export default VitePluginUniPages
