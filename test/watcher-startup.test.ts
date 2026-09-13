import type { PagesConfig } from '../packages/core/src'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'comment-json'
import { expect, it, vi } from 'vitest'
import UniPages from '../packages/core/src'

vi.mock('../packages/core/node_modules/@uni-helper/uni-env', () => ({ platform: 'h5' }))

it('build watch includes files created during startup and stays active between bundles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-watch-startup-'))
  const pagesDir = path.join(root, 'src/pages')
  fs.mkdirSync(pagesDir, { recursive: true })
  const writePage = (name: string): void => {
    fs.writeFileSync(path.join(pagesDir, `${name}.vue`), '<template><view /></template>')
  }
  writePage('index')
  vi.stubEnv('VITE_ROOT_DIR', root)
  let added = false
  const plugin = UniPages({
    onAfterWriteFile() {
      if (!added) {
        added = true
        writePage('during-startup')
      }
    },
  })
  const hook = plugin.configResolved!
  const configure = typeof hook === 'function' ? hook : hook.handler
  const callClose = async (name: 'closeBundle' | 'closeWatcher'): Promise<void> => {
    const hook = plugin[name]!
    const handler = typeof hook === 'function' ? hook : hook.handler
    await handler.call({} as ThisParameterType<typeof handler>)
  }
  const routes = (): string[] => {
    const config = parse(fs.readFileSync(path.join(root, 'src/pages.json'), 'utf8')) as PagesConfig
    return config.pages!.map(page => page.path).sort()
  }
  try {
    await configure({ root, command: 'build', build: { watch: {} }, plugins: [] } as unknown as Parameters<typeof configure>[0])
    expect(routes()).toEqual(['pages/during-startup', 'pages/index'])
    expect(fs.readFileSync(path.join(root, 'uni-pages.d.ts'), 'utf8')).toContain('/pages/during-startup')
    await callClose('closeBundle')
    writePage('next-bundle')
    await vi.waitFor(() => {
      expect(routes()).toContain('pages/next-bundle')
      expect(fs.readFileSync(path.join(root, 'uni-pages.d.ts'), 'utf8')).toContain('/pages/next-bundle')
    }, { timeout: 5000 })
  }
  finally {
    await callClose('closeWatcher')
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
