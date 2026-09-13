import type { GenerationObserver, PageContext } from './context'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createConfigLoader } from 'unconfig'
import { normalizePath } from 'vite'
import writeFileAtomic from 'write-file-atomic'
import { getPageFiles, withFileLock } from './files'
import { resolvePageDirs, resolveSubPackages } from './options'

interface PreparedSnapshot {
  inputs: string
  outputs: string
}

function readOutput(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
}

function outputFiles(ctx: PageContext): string[] {
  return ctx.options.dts
    ? [ctx.resolvedPagesJSONPath, ctx.options.dts]
    : [ctx.resolvedPagesJSONPath]
}

function fingerprint(files: Iterable<string>, contents?: Map<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) {
    hash.update(file)
    hash.update(contents?.get(file) ?? readOutput(file) ?? '\0missing')
  }
  return hash.digest('hex')
}

function inputFingerprint(ctx: PageContext, includeDependencies = true): string {
  const { dir, subPackages } = ctx.scanOptions
  const dirs = resolvePageDirs(dir, ctx.root, ctx.options.exclude)
  const sub = resolveSubPackages(subPackages, ctx.root, ctx.options.outDir, ctx.options.exclude)
  const sources = createConfigLoader({ cwd: ctx.root, sources: ctx.options.configSource, defaults: {} })
    .findConfigs
    .sync()
    .map(normalizePath)
  const files = new Set(sources)
  if (includeDependencies) {
    for (const file of ctx.pagesConfigDependencyPaths)
      files.add(file)
  }
  if (ctx.options.mergePages) {
    for (const directory of [...dirs, ...sub.dirs]) {
      const absolute = path.resolve(ctx.root, directory)
      for (const file of getPageFiles(absolute, ctx.options))
        files.add(normalizePath(path.resolve(absolute, file)))
    }
  }
  return createHash('sha256')
    .update(JSON.stringify([dirs, [...sub.roots]]))
    .update(fingerprint(files))
    .digest('hex')
}

function changedInputError(): Error {
  return new Error('[vite-plugin-uni-pages] Page inputs or generated outputs changed after prepare(); recreate the plugin before downstream plugins read pages.json')
}

/** 校验后续插件读到的产物与准备完成时一致 */
export function assertPreparedContext(ctx: PageContext, snapshot: PreparedSnapshot): void {
  if (inputFingerprint(ctx) !== snapshot.inputs || fingerprint(outputFiles(ctx)) !== snapshot.outputs)
    throw changedInputError()
}

/** 生成完整快照；失败时仅恢复本次写入且未被外部修改的产物 */
export async function prepareContext(ctx: PageContext): Promise<PreparedSnapshot> {
  const files = outputFiles(ctx)
  const previous = new Map(files.map(file => [file, readOutput(file)]))
  const expected = new Map<string, Buffer>()
  const written = new Set<string>()
  const before = inputFingerprint(ctx, false)
  let loaded: string | undefined
  const observer: GenerationObserver = {
    onConfigLoaded() {
      loaded = inputFingerprint(ctx)
    },
    onOutput(file, content, updated) {
      expected.set(file, Buffer.from(content))
      if (updated)
        written.add(file)
    },
  }
  try {
    await ctx.updatePagesJSON(undefined, observer)
    const inputs = inputFingerprint(ctx)
    const outputs = fingerprint(files, expected)
    if (before !== inputFingerprint(ctx, false) || loaded !== inputs || outputs !== fingerprint(files))
      throw changedInputError()
    return { inputs, outputs }
  }
  catch (error) {
    for (const file of written) {
      try {
        await withFileLock(file, async () => {
          const content = readOutput(file)
          if (!content?.equals(expected.get(file)!))
            return
          const original = previous.get(file)
          if (original === undefined)
            await fs.promises.rm(file, { force: true })
          else
            await writeFileAtomic(file, original)
        })
      }
      catch (restoreError) {
        ctx.logger?.error(`Could not restore ${file}: ${String(restoreError)}`)
      }
    }
    throw error
  }
}
