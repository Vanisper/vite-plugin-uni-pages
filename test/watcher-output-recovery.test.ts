import type { FSWatcher } from 'chokidar'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { PageContext } from '../packages/core/src/context'

it('声明写入失败后保留更新，完整恢复后只通知一次 HMR', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-output-recovery-'))
  const pagesDir = path.join(root, 'src/pages')
  const pagesJson = path.join(root, 'src/pages.json')
  const declarationDir = path.join(root, 'types')
  const declaration = path.join(declarationDir, 'routes.d.ts')
  const ctx = new PageContext({ dts: declaration }, root, 'h5')
  const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })

  try {
    fs.mkdirSync(pagesDir, { recursive: true })
    fs.writeFileSync(path.join(pagesDir, 'index.vue'), '<template><view /></template>')
    await ctx.updatePagesJSON()
    const generate = vi.spyOn(ctx, 'updatePagesJSON')
    const onUpdate = vi.spyOn(ctx, 'onUpdate').mockImplementation(() => {
      expect(fs.readFileSync(pagesJson, 'utf8')).toContain('pages/about')
      expect(fs.readFileSync(declaration, 'utf8')).toContain('/pages/about')
    })
    await ctx.setupWatcher(watcher as unknown as FSWatcher)

    fs.rmSync(declarationDir, { recursive: true })
    fs.writeFileSync(declarationDir, 'blocks the declaration directory')
    const about = path.join(pagesDir, 'about.vue')
    fs.writeFileSync(about, '<template><view /></template>')
    watcher.emit('all', 'add', about)
    await ctx.flushWatcher()

    await expect(generate.mock.results[0].value).rejects.toMatchObject({ code: 'EEXIST' })
    expect(fs.readFileSync(pagesJson, 'utf8')).toContain('pages/about')
    expect(onUpdate).not.toHaveBeenCalled()

    fs.unlinkSync(declarationDir)
    watcher.emit('all', 'change', about)
    await ctx.flushWatcher()
    expect(fs.readFileSync(declaration, 'utf8')).toContain('/pages/about')
    expect(onUpdate).toHaveBeenCalledTimes(1)

    watcher.emit('all', 'change', about)
    await ctx.flushWatcher()
    expect(onUpdate).toHaveBeenCalledTimes(1)
  }
  finally {
    await ctx.disposeWatcher()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
