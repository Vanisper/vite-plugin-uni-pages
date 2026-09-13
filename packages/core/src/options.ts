import type { PagesConfig } from '@uni-helper/uni-pages-types'
import type { LoadConfigSource } from 'unconfig'
import type { ResolvedOptions, UserOptions } from './types'
import path, { resolve } from 'node:path'
import process from 'node:process'
import { globSync } from 'tinyglobby'
import { normalizePath } from 'vite'

/**
 * 解析用户配置项
 * 将用户提供的配置与默认值合并，并处理路径解析
 *
 * @param userOptions - 用户配置项
 * @param viteRoot - Vite 项目根目录
 * @returns 解析后的配置项
 */
export function resolveOptions(userOptions: UserOptions, viteRoot: string = process.cwd()): ResolvedOptions {
  const {
    dts = true,
    configSource = 'pages.config',
    homePage = ['pages/index', 'pages/index/index'],
    mergePages = true,
    platformSuffix = false,
    dir = 'src/pages',
    subPackages = [],

    outDir = 'src',
    exclude = ['node_modules', '.git', '**/__*__/**'],
    minify = false,
    insertFinalNewline = false,
    indent = 2,
    eol = '\n',
    debug = false,

    onBeforeLoadUserConfig = () => {},
    onAfterLoadUserConfig = () => {},
    onBeforeScanPages = () => {},
    onAfterScanPages = () => {},
    onBeforeMergePageMetaData = () => {},
    onAfterMergePageMetaData = () => {},
    onBeforeWriteFile = () => {},
    onAfterWriteFile = () => {},
  } = userOptions

  const root = viteRoot || normalizePath(process.env.VITE_ROOT_DIR || process.cwd())
  const resolvedDirs = resolvePageDirs(dir, root, exclude)

  const { dirs: resolvedSubDirs, roots: subPackageRootMap } = resolveSubPackages(subPackages, root, outDir, exclude)

  const resolvedHomePage = typeof homePage === 'string' ? [homePage] : homePage
  const resolvedConfigSource = typeof configSource === 'string' ? [{ files: configSource } as LoadConfigSource<PagesConfig>] : configSource
  const resolvedDts = !dts ? false : resolve(root, typeof dts === 'string' ? dts : 'uni-pages.d.ts')

  const resolvedOptions: ResolvedOptions = {
    dts: resolvedDts,
    configSource: Array.isArray(resolvedConfigSource) ? resolvedConfigSource : [resolvedConfigSource],
    homePage: resolvedHomePage,
    mergePages,
    platformSuffix,
    dirs: resolvedDirs,
    subPackages: resolvedSubDirs,
    subPackageRootMap,
    outDir,
    exclude,
    root,
    minify,
    insertFinalNewline,
    indent,
    eol,
    debug,
    onBeforeLoadUserConfig,
    onAfterLoadUserConfig,
    onBeforeScanPages,
    onAfterScanPages,
    onBeforeMergePageMetaData,
    onAfterMergePageMetaData,
    onBeforeWriteFile,
    onAfterWriteFile,
  }

  return resolvedOptions
}

/**
 * 根据给定的 glob 模式解析页面目录
 * @param dir - 页面目录 glob 模式
 * @param root - 项目根目录
 * @param exclude - 需要排除的 glob 模式
 * @returns 匹配到的目录路径
 */
export function resolvePageDirs(dir: string, root: string, exclude: string[]): string[] {
  const dirs = globSync(normalizePath(dir), {
    ignore: exclude,
    onlyDirectories: true,
    expandDirectories: false,
    dot: true,
    cwd: root,
  })
  return dirs
}

/** 展开子包目录，并验证物理目录与输出 root 的一一对应关系 */
export function resolveSubPackages(sources: NonNullable<UserOptions['subPackages']>, root: string, outDir: string, exclude: string[]): { dirs: string[], roots: Map<string, string> } {
  const roots = new Map<string, string>()
  const dirsByRoot = new Map<string, string>()

  for (const source of sources) {
    const pattern = typeof source === 'string' ? source : source.dir
    const dirs = resolvePageDirs(pattern, root, exclude)
      .map(dir => normalizePath(path.relative(root, path.resolve(root, dir))))
      .sort()

    for (const dir of dirs) {
      const configuredRoot = typeof source === 'string' ? undefined : source.root
      const outputRoot = typeof configuredRoot === 'function'
        ? configuredRoot(dir)
        : configuredRoot ?? normalizePath(path.relative(path.resolve(root, outDir), path.resolve(root, dir)))
      if (typeof outputRoot !== 'string' || !outputRoot.trim())
        throw new Error(`[vite-plugin-uni-pages] Invalid subPackage root for "${dir}": expected a non-empty string`)

      const normalizedRoot = normalizePath(outputRoot)
      if (roots.has(dir) && roots.get(dir) !== normalizedRoot)
        throw new Error(`[vite-plugin-uni-pages] SubPackage directory "${dir}" maps to conflicting roots "${roots.get(dir)}" and "${normalizedRoot}"`)
      if (dirsByRoot.has(normalizedRoot) && dirsByRoot.get(normalizedRoot) !== dir)
        throw new Error(`[vite-plugin-uni-pages] SubPackage root "${normalizedRoot}" maps to conflicting directories "${dirsByRoot.get(normalizedRoot)}" and "${dir}"`)

      roots.set(dir, normalizedRoot)
      dirsByRoot.set(normalizedRoot, dir)
    }
  }

  return { dirs: [...roots.keys()], roots }
}
