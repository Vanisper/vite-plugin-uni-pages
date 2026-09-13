import type { PagesConfig } from '@uni-helper/uni-pages-types'
import type { Plugin } from 'esbuild'
import type { LoadConfigSource } from 'unconfig'
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { injectFileScopePlugin, JS_EXT_RE } from 'bundle-require'
import { build } from 'esbuild'
import { createJiti } from 'jiti'
import { loadConfig } from 'unconfig'
import { normalizePath } from 'vite'
import { externalConfigImportsPlugin } from './config-resolve'
import { preserveConfigScope } from './config-scope'

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

function observeDependencies(): { plugin: Plugin, dependencies: () => string[], manifests: Set<string>, read: (file: string) => string, assertUnchanged: () => void } {
  const contents = new Map<string, string | undefined>()
  const loaded = new Set<string>()
  const imports = new Map<string, string[]>()
  const manifests = new Set<string>()

  function remember(file: string, content: string | undefined): void {
    const absolute = normalizePath(file)
    if (contents.has(absolute) && contents.get(absolute) !== content)
      throw new Error(`[vite-plugin-uni-pages] Config dependency changed while loading: ${file}`)
    contents.set(absolute, content)
  }

  function read(file: string): string {
    const content = readFileSync(file, 'utf8')
    remember(file, content)
    return content
  }

  return {
    read,
    manifests,
    assertUnchanged() {
      for (const [file, content] of contents) {
        let current: string | undefined
        try {
          current = readFileSync(file, 'utf8')
        }
        catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error
        }
        if (current !== content)
          throw new Error(`[vite-plugin-uni-pages] Config dependency changed while loading: ${file}`)
      }
    },
    plugin: {
      name: 'uni-pages:config-dependencies',
      setup(build) {
        build.onResolve({ filter: /.*/ }, ({ path: specifier, resolveDir }) => {
          if (!specifier.startsWith('.') && !path.isAbsolute(specifier))
            return

          const file = normalizePath(path.resolve(resolveDir, specifier))
          const files = [file, ...resolveExtensions.map(extension => `${file}${extension}`)]
          // TypeScript 的 .js/.mjs/.cjs 导入还可能对应同名源码
          const extension = path.extname(file)
          if (extension === '.js')
            files.push(`${file.slice(0, -3)}.ts`, `${file.slice(0, -3)}.tsx`)
          else if (extension === '.mjs' || extension === '.cjs')
            files.push(file.slice(0, -4) + (extension === '.mjs' ? '.mts' : '.cts'))
          const manifest = `${file}/package.json`
          const candidates = [...files, ...resolveExtensions.map(extension => `${file}/index${extension}`), manifest]
          try {
            // 与传给 esbuild 的扩展名一致；文件优先命中时，同名目录不参与解析
            if (!files.some(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile()) && statSync(file).isDirectory()) {
              manifests.add(manifest)
              // 目录入口可由后续新增的 package.json 改写，缺失状态也参与校验
              let content: string | undefined
              try {
                content = readFileSync(manifest, 'utf8')
              }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                  throw error
              }
              remember(manifest, content)
              const metadata = (content === undefined ? {} : JSON.parse(content)) as { main?: string, module?: string }
              for (const entry of [metadata.main, metadata.module]) {
                if (typeof entry !== 'string')
                  continue
                const target = normalizePath(path.resolve(file, entry))
                candidates.push(target, ...resolveExtensions.map(extension => `${target}${extension}`))
              }
            }
          }
          catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
              throw error
          }
          imports.set(file, candidates)
        })
        build.onLoad({ filter: /.*/, namespace: 'file' }, ({ path: file }) => {
          loaded.add(normalizePath(file))
          if (file.endsWith('.json'))
            return { contents: read(file), loader: 'json' }
        })
      },
    },
    dependencies: () => [...new Set([
      ...loaded,
      ...manifests,
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
            plugins: [
              externalConfigImportsPlugin(),
              observed.plugin,
              injectFileScopePlugin({ readFile: file => preserveConfigScope(observed.read(file), file) }),
            ],
          })
          observed.assertUnchanged()
          const jiti = createJiti(file, { fsCache: false, moduleCache: false, interopDefault: true })
          const mod = await jiti.evalModule(bundled.outputFiles[0].text, { filename: file, async: true, forceTranspile: true }) as PagesConfig | undefined
          observed.assertUnchanged()
          sourceDependencies.set(normalizePath(file), [...new Set([
            ...Object.keys(bundled.metafile.inputs).map(file => normalizePath(path.resolve(root, file))),
            ...observed.manifests,
          ])])
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
