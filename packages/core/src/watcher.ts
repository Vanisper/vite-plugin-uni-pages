import type { FSWatcher } from 'chokidar'
import type { Logger } from 'vite'
import type { ScanContext } from './scan'
import path from 'node:path'
import { normalizePath } from 'vite'
import { isTargetFile } from './files'
import { debug } from './logger'
import { configFilePatterns, scanPatterns } from './scan'

interface WatchContext extends ScanContext {
  logger?: Logger
  updatePagesJSON: () => Promise<boolean>
  onUpdate: () => void
}

/** 单个页面上下文的监听订阅与生成队列 */
export interface PageWatcher {
  watcher: FSWatcher
  flush: () => Promise<void>
  dispose: () => Promise<void>
}

function isRelevantEvent(ctx: ScanContext, event: string, absolute: string): boolean {
  const configs = [...ctx.pagesConfigSourcePaths, ...ctx.pagesConfigDependencyPaths, ...configFilePatterns(ctx)]
  if (configs.includes(absolute))
    return true
  if (!ctx.options.mergePages)
    return false

  const relative = (file: string): string => normalizePath(path.relative(ctx.root, file)) || '.'
  const excluded = (file: string): boolean => ctx.options.exclude.some(pattern => path.posix.matchesGlob(file, normalizePath(pattern)))
  if (excluded(relative(absolute)))
    return false

  const patterns = scanPatterns(ctx)
  if (event === 'addDir' || event === 'unlinkDir') {
    // 新目录可能连同子树一次出现；父级事件也要能触发首次发现
    for (const pattern of patterns) {
      for (let ancestor = pattern; ; ancestor = path.posix.dirname(ancestor)) {
        if (path.posix.matchesGlob(relative(absolute), ancestor))
          return true
        if (ancestor === path.posix.dirname(ancestor))
          break
      }
    }
  }
  else if (!isTargetFile(absolute)) {
    return false
  }

  for (let ancestor = event.endsWith('Dir') ? absolute : path.dirname(absolute); ; ancestor = path.dirname(ancestor)) {
    if (patterns.some(pattern => path.posix.matchesGlob(relative(ancestor), pattern))) {
      const pagePath = normalizePath(path.relative(ancestor, absolute))
      return !pagePath.split('/').some(part => part.startsWith('.')) && !excluded(pagePath)
    }
    if (ancestor === path.dirname(ancestor))
      return false
  }
}

/** 合并连续文件事件，串行生成完整产物后再通知 HMR */
export function attachWatcher(ctx: WatchContext, watcher: FSWatcher): PageWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let disposed = false
  let chain = Promise.resolve()

  const flush = (): Promise<void> => {
    clearTimeout(timer)
    if (!pending || disposed)
      return chain
    pending = false
    chain = chain.then(async () => {
      if (disposed)
        return

      try {
        const updated = await ctx.updatePagesJSON()
        if (updated && !disposed)
          ctx.onUpdate()
      }
      finally {
        if (!disposed)
          watcher.add([...ctx.pagesConfigSourcePaths, ...ctx.pagesConfigDependencyPaths])
      }
    }).catch((error: unknown) => {
      ctx.logger?.error(error instanceof Error ? error.stack ?? error.message : String(error))
      debug.error(error)
    })
    return chain
  }

  const listener = (event: string, file: string): void => {
    if (!['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event))
      return
    const absolute = normalizePath(path.resolve(ctx.root, file))
    if (!isRelevantEvent(ctx, event, absolute))
      return

    pending = true
    clearTimeout(timer)
    timer = setTimeout(flush, 25)
  }
  watcher.add([...ctx.pagesConfigSourcePaths, ...ctx.pagesConfigDependencyPaths])
  watcher.on('all', listener)

  return {
    watcher,
    flush,
    async dispose() {
      disposed = true
      clearTimeout(timer)
      watcher.off('all', listener)
      await chain
    },
  }
}
