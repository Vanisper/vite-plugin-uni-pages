import type { UserOptions } from '../packages/core/src/types'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateAll } from '../packages/core/src/pipeline'

const workspaces: string[] = []

function writeFile(root: string, file: string, content = '<template><view /></template>'): void {
  const absolute = path.join(root, file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
}

function workspace(): { workspace: string, root: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-sub-root-'))
  workspaces.push(workspace)
  const root = path.join(workspace, 'apps/client')
  writeFile(root, 'src/pages/index.vue')
  return { workspace, root }
}

async function generate(root: string, subPackages: UserOptions['subPackages'], platform = 'h5') {
  const { ctx } = await generateAll({
    subPackages,
    platformSuffix: true,
    dts: path.join(root, 'routes.d.ts'),
  }, { root, platform })
  return ctx
}

afterEach(() => {
  for (const root of workspaces.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

describe('subpackage output root mapping', () => {
  it('maps an external physical directory to its configured output root', async () => {
    const { workspace: parent, root } = workspace()
    writeFile(parent, 'packages/login/src/pages/detail.vue')

    const ctx = await generate(root, [{
      dir: '../../packages/login/src/pages',
      root: 'packages/login/src/pages',
    }])

    expect(ctx.subPageMetaData).toMatchObject([{ root: 'packages/login/src/pages', pages: [{ path: 'detail' }] }])
    expect(fs.readFileSync(path.join(root, 'routes.d.ts'), 'utf8')).toContain('"/packages/login/src/pages/detail"')
    expect(ctx.subPages.get('../../packages/login/src/pages')?.keys().next().value)
      .toBe(path.join(parent, 'packages/login/src/pages/detail.vue').replaceAll('\\', '/'))
  })

  it.each(['detail', 'features/orders/detail'])('merges the %s user page with an aliased glob package', async (manualPath) => {
    const { root } = workspace()
    writeFile(root, 'src/packages/orders/pages/detail.vue', '<script setup>definePage({ style: { navigationBarTitleText: "Scanned" } })</script>')
    writeFile(root, 'pages.config.json', JSON.stringify({
      subPackages: [{
        root: 'features/orders',
        pages: [{ path: manualPath, style: { navigationBarTitleText: 'Configured' } }],
      }],
    }))

    const ctx = await generate(root, [{
      dir: 'src/packages/*/pages',
      root: dir => `features/${dir.split('/')[2]}`,
    }])

    expect(ctx.subPageMetaData).toMatchObject([{
      root: 'features/orders',
      pages: [{ path: 'detail', style: { navigationBarTitleText: 'Configured' } }],
    }])
    expect(ctx.subPageMetaData[0].pages).toHaveLength(1)
    expect(fs.readFileSync(path.join(root, 'routes.d.ts'), 'utf8')).toContain('"/features/orders/detail"')
  })

  it('preserves the path below an output root that already contains the physical directory', async () => {
    const { root } = workspace()
    writeFile(root, 'src/packages/account/pages/profile.vue')

    const ctx = await generate(root, [{
      dir: 'src/packages/*/pages',
      root: dir => path.posix.dirname(dir).slice(4),
    }])

    expect(ctx.subPageMetaData).toMatchObject([{ root: 'packages/account', pages: [{ path: 'pages/profile' }] }])
    expect(fs.readFileSync(path.join(root, 'routes.d.ts'), 'utf8')).toContain('"/packages/account/pages/profile"')
  })

  it('keeps remapped physical subpackage pages out of the main package', async () => {
    const { root } = workspace()
    writeFile(root, 'src/pages/account/detail.vue')

    const ctx = await generate(root, [{ dir: 'src/pages/account', root: 'features/account' }])

    expect(ctx.pageMetaData.map(page => page.path)).toEqual(['pages/index'])
    expect(ctx.subPageMetaData).toMatchObject([{ root: 'features/account', pages: [{ path: 'detail' }] }])
  })

  it.each(['h5', 'mp-weixin'])('preserves %s platform suffix filtering after remapping', async (platform) => {
    const { root } = workspace()
    for (const target of ['h5', 'mp-weixin']) {
      writeFile(root, `src/packages/account/pages/profile.${target}.vue`, `<script setup>
definePage(({ platform }) => ({ style: { navigationBarTitleText: platform } }))
</script>`)
    }

    const ctx = await generate(root, [{ dir: 'src/packages/*/pages', root: 'features/account' }], platform)

    expect(ctx.subPageMetaData).toMatchObject([{
      root: 'features/account',
      pages: [{ path: 'profile', style: { navigationBarTitleText: platform } }],
    }])
    expect(ctx.subPageMetaData[0].pages).toHaveLength(1)
    const declaration = fs.readFileSync(path.join(root, 'routes.d.ts'), 'utf8')
    expect(declaration).toContain('"/features/account/profile"')
    expect(declaration).not.toContain('/features/account/profile.h5')
    expect(declaration).not.toContain('/features/account/profile.mp-weixin')
  })
})
