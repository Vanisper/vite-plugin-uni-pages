import type { ResolvedOptions, UserOptions } from './types'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isDynamicPattern } from 'tinyglobby'
import { defaultExtensions } from 'unconfig'
import { normalizePath } from 'vite'
import { resolvePageDirs, resolveSubPackages } from './options'

/** 保留未展开的扫描规则，供文件系统变更后重新解析 */
export interface ScanOptions {
  dir: string
  subPackages: NonNullable<UserOptions['subPackages']>
}

/** 目录发现与监听范围计算所需的上下文 */
export interface ScanContext {
  root: string
  options: ResolvedOptions
  scanOptions: ScanOptions
  pagesConfigSourcePaths: string[]
  pagesConfigDependencyPaths: string[]
}

/** 将扫描规则统一为相对 root 的模式，避免将项目路径误作 glob */
export function scanPatterns(ctx: ScanContext): string[] {
  const { dir, subPackages } = ctx.scanOptions
  return [dir, ...subPackages.map(source => typeof source === 'string' ? source : source.dir)]
    .map(dir => normalizePath(path.relative(ctx.root, path.resolve(ctx.root, dir))) || '.')
}

/** 刷新目录列表与子包 root 映射 */
export function refreshScanDirs(ctx: ScanContext): void {
  const { dir, subPackages } = ctx.scanOptions
  const dirs = resolvePageDirs(dir, ctx.root, ctx.options.exclude)
  const sub = resolveSubPackages(subPackages, ctx.root, ctx.options.outDir, ctx.options.exclude)
  ctx.options.dirs = dirs
  ctx.options.subPackages = sub.dirs
  ctx.options.subPackageRootMap = sub.roots
}

/** 配置候选路径包含尚未创建的文件 */
export function configFilePatterns(ctx: ScanContext): string[] {
  return ctx.options.configSource.flatMap((source) => {
    const files = Array.isArray(source.files) ? source.files : [source.files]
    const extensions = source.extensions ?? defaultExtensions
    return files.flatMap(file => (extensions.length ? extensions : [''])
      .map(ext => normalizePath(path.resolve(ctx.root, `${file}${ext ? `.${ext}` : ''}`))))
  })
}

/** 判断绝对路径是否位于目录内，包含目录自身 */
export function within(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir.endsWith('/') ? dir : `${dir}/`)
}

function staticScanPrefix(pattern: string): string {
  const parts = pattern.split('/')
  const dynamic = parts.findIndex(part => isDynamicPattern(part) || /[{}()]/.test(part))
  return dynamic < 0 ? pattern : parts.slice(0, dynamic).join('/') || '.'
}

function ancestors(file: string): string[] {
  const result = [file]
  while (file !== path.posix.dirname(file)) {
    file = path.posix.dirname(file)
    result.push(file)
  }
  return result
}

function scanMatcher(pattern: string, exclude: string[]): (file: string) => boolean {
  const parents = ancestors(pattern)
  const prefix = staticScanPrefix(pattern)
  const excluded = (file: string): boolean => exclude.some(pattern => path.posix.matchesGlob(file, pattern)
    || path.posix.matchesGlob(`${file}/`, pattern))

  return (file) => {
    if (excluded(file))
      return false

    const directory = ancestors(file).find(directory => path.posix.matchesGlob(directory, pattern))
    if (directory !== undefined)
      return !excluded(path.posix.relative(directory, file))

    // 组合模式可能跨目录，保留其稳定祖先范围，避免截断 brace 或 extglob
    if (/[{}()]/.test(pattern))
      return within(file, prefix) || within(prefix, file) || prefix === '.'

    return parents.some(parent => path.posix.matchesGlob(file, parent))
  }
}

/** 监听稳定祖先，并限制遍历范围到扫描路径与配置文件 */
export function watchScope(ctx: ScanContext): { roots: string[], ignored: (file: string) => boolean } {
  const patterns = ctx.options.mergePages ? scanPatterns(ctx) : []
  const prefixes = patterns.map(pattern => normalizePath(path.resolve(ctx.root, staticScanPrefix(pattern))))
  const matches = patterns.map(pattern => scanMatcher(pattern, ctx.options.exclude.map(normalizePath)))
  const configPaths = (): string[] => [...configFilePatterns(ctx), ...ctx.pagesConfigSourcePaths, ...ctx.pagesConfigDependencyPaths]
  const roots = new Set([ctx.root])
  for (const target of [...prefixes, ...configPaths()]) {
    if (within(target, ctx.root))
      continue

    let ancestor = path.dirname(target)
    while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor))
      ancestor = path.dirname(ancestor)
    roots.add(normalizePath(ancestor))
  }

  return {
    roots: [...roots].filter((root, index, all) => !all.some((other, otherIndex) => index !== otherIndex && within(root, other))),
    ignored(file) {
      const absolute = normalizePath(path.resolve(file))
      if (configPaths().some(config => absolute === config || within(config, absolute)))
        return false
      const relative = normalizePath(path.relative(ctx.root, absolute)) || '.'
      return !matches.some(matches => matches(relative))
    },
  }
}
