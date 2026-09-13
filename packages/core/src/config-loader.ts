import type { PagesConfig } from '@uni-helper/uni-pages-types'
import type { Plugin } from 'esbuild'
import type { LoadConfigSource } from 'unconfig'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { externalPlugin, injectFileScopePlugin, JS_EXT_RE } from 'bundle-require'
import { build } from 'esbuild'
import { createJiti } from 'jiti'
import { loadConfig } from 'unconfig'
import { normalizePath } from 'vite'

/** 加载后的页面配置及其本地文件依赖 */
export interface LoadedPagesConfig {
  config: PagesConfig
  /** 实际采用的配置入口，使用绝对路径 */
  sources: string[]
  /** 配置静态导入的本地依赖，不含配置入口 */
  dependencies: string[]
}

/** 配置加载失败时，保留可触发重试的本地文件路径 */
export class PageConfigLoadError extends Error {
  constructor(cause: unknown, readonly dependencies: string[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'PageConfigLoadError'
  }
}

const resolveExtensions = ['.tsx', '.ts', '.jsx', '.js', '.css', '.json']

function observeDependencies(): { plugin: Plugin, dependencies: () => string[] } {
  const loaded = new Set<string>()
  const imports = new Map<string, string[]>()

  return {
    plugin: {
      name: 'uni-pages:config-dependencies',
      setup(build) {
        build.onResolve({ filter: /.*/ }, ({ path: specifier, resolveDir }) => {
          if (!specifier.startsWith('.') && !path.isAbsolute(specifier))
            return

          const file = normalizePath(path.resolve(resolveDir, specifier))
          const candidates = [
            file,
            ...resolveExtensions.map(extension => `${file}${extension}`),
            ...resolveExtensions.map(extension => `${file}/index${extension}`),
            `${file}/package.json`,
          ]
          // TypeScript 的 .js/.mjs/.cjs 导入还可能对应同名源码
          const extension = path.extname(file)
          if (extension === '.js')
            candidates.push(`${file.slice(0, -3)}.ts`, `${file.slice(0, -3)}.tsx`)
          else if (extension === '.mjs' || extension === '.cjs')
            candidates.push(file.slice(0, -4) + (extension === '.mjs' ? '.mts' : '.cts'))
          imports.set(file, candidates)
        })
        build.onLoad({ filter: /.*/, namespace: 'file' }, ({ path: file }) => {
          loaded.add(normalizePath(file))
        })
      },
    },
    dependencies: () => [...new Set([
      ...loaded,
      ...[...imports.values()].filter(candidates => !candidates.some(file => loaded.has(file))).flat(),
    ])],
  }
}

/**
 * 加载页面配置并收集本次采用的依赖
 *
 * @description 保留 unconfig 的来源选择与自定义解析规则，每次加载重新计算本地依赖
 */
export async function loadPagesConfig(root: string, sources: LoadConfigSource<PagesConfig>[]): Promise<LoadedPagesConfig> {
  const sourceDependencies = new Map<string, string[]>()
  const configSources = sources.map((source): LoadConfigSource<PagesConfig> => {
    if (source.transform || (source.parser && source.parser !== 'auto' && source.parser !== 'import'))
      return source

    return {
      ...source,
      parser: async (file) => {
        if (source.parser !== 'import') {
          const content = await readFile(file, 'utf8')
          try {
            return JSON.parse(content)
          }
          catch (error) {
            if (!(error instanceof SyntaxError))
              throw error
          }
        }

        if (!JS_EXT_RE.test(file)) {
          const { config } = await loadConfig<PagesConfig>({ sources: [{ files: file, extensions: [], parser: 'import' }] })
          return config
        }

        const observed = observeDependencies()
        try {
          const bundled = await build({
            entryPoints: [file],
            absWorkingDir: root,
            bundle: true,
            write: false,
            metafile: true,
            format: 'esm',
            platform: 'node',
            sourcemap: 'inline',
            tsconfigRaw: {},
            resolveExtensions,
            // 与文件监听使用同一路径，避免符号链接产生两套依赖标识
            preserveSymlinks: true,
            logLevel: 'silent',
            plugins: [externalPlugin(), observed.plugin, injectFileScopePlugin()],
          })
          const jiti = createJiti(file, { fsCache: false, moduleCache: false, interopDefault: true })
          const mod = await jiti.evalModule(bundled.outputFiles[0].text, { filename: file, async: true, forceTranspile: true }) as PagesConfig | undefined
          sourceDependencies.set(normalizePath(file), Object.keys(bundled.metafile.inputs).map(file => normalizePath(path.resolve(root, file))))
          return mod?.default ?? mod
        }
        catch (error) {
          throw new PageConfigLoadError(error, observed.dependencies())
        }
      },
    }
  })

  const loaded = await loadConfig<PagesConfig>({ cwd: root, sources: configSources, defaults: {} })
  const resolvedSources = loaded.sources.map(normalizePath)
  const dependencies = new Set([
    ...(loaded.dependencies ?? []),
    ...resolvedSources.flatMap(file => sourceDependencies.get(file) ?? []),
  ].map(file => normalizePath(path.resolve(root, file))))

  for (const file of resolvedSources)
    dependencies.delete(file)

  return {
    config: loaded.config.default || loaded.config,
    sources: resolvedSources,
    dependencies: [...dependencies],
  }
}
