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
  const dynamic = parts.findIndex(part => isDynamicPattern(part))
  return dynamic < 0 ? pattern : parts.slice(0, dynamic).join('/') || '.'
}

/** 监听稳定祖先，并限制遍历范围到扫描路径与配置文件 */
export function watchScope(ctx: ScanContext): { roots: string[], ignored: (file: string) => boolean } {
  const prefixes = ctx.options.mergePages
    ? scanPatterns(ctx).map(pattern => normalizePath(path.resolve(ctx.root, staticScanPrefix(pattern))))
    : []
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
      return !prefixes.some(prefix => within(absolute, prefix) || within(prefix, absolute))
        && !configPaths().some(config => absolute === config || within(config, absolute))
    },
  }
}
