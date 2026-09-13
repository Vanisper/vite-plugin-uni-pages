import type { PagesConfig } from '@uni-helper/uni-pages-types'
import type { PageContext } from '../packages/core/src/context'
import type { UserOptions } from '../packages/core/src/types'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'comment-json'
import { afterEach, describe, expect, it } from 'vitest'
import { generateAll } from '../packages/core/src/pipeline'

const workspaces: string[] = []

function writeFile(root: string, file: string, content = '<template><view /></template>'): string {
  const absolute = path.join(root, file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

function workspace(): { workspace: string, root: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-sub-paths-'))
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

function expectPageSource(ctx: PageContext, source: string, extension = '.vue'): void {
  const output = parse(fs.readFileSync(ctx.resolvedPagesJSONPath, 'utf8')) as PagesConfig
  expect(output.subPackages).toHaveLength(1)
  const subPackage = output.subPackages![0]
  expect(subPackage.pages).toHaveLength(1)
  const resolved = path.resolve(ctx.root, ctx.options.outDir, subPackage.root, subPackage.pages[0].path + extension)
  expect(resolved).toBe(source)
  expect(fs.existsSync(resolved)).toBe(true)
}

afterEach(() => {
  for (const root of workspaces.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

describe('subpackage page paths', () => {
  it('preserves the source location when a custom root differs from the physical directory', async () => {
    const { workspace: parent, root } = workspace()
    const source = writeFile(parent, 'packages/login/src/pages/detail.vue')

    const ctx = await generate(root, [{
      dir: '../../packages/login/src/pages',
      root: 'packages/login/src/pages',
    }])

    expectPageSource(ctx, source)
    expect(ctx.subPages.get('../../packages/login/src/pages')?.keys().next().value)
      .toBe(source.replaceAll('\\', '/'))
  })

  it.each(['pages/detail', 'packages/orders/pages/detail'])('merges the %s user page with a scanned glob package', async (manualPath) => {
    const { root } = workspace()
    const source = writeFile(root, 'src/packages/orders/pages/detail.vue', '<script setup>definePage({ style: { navigationBarTitleText: "Scanned" } })</script>')
    writeFile(root, 'pages.config.json', JSON.stringify({
      subPackages: [{
        root: 'packages/orders',
        pages: [{ path: manualPath, style: { navigationBarTitleText: 'Configured' } }],
      }],
    }))

    const ctx = await generate(root, [{
      dir: 'src/packages/*/pages',
      root: dir => path.posix.relative('src', path.posix.dirname(dir)),
    }])

    expectPageSource(ctx, source)
    expect(ctx.subPageMetaData).toMatchObject([{
      root: 'packages/orders',
      pages: [{ path: 'pages/detail', style: { navigationBarTitleText: 'Configured' } }],
    }])
    expect(fs.readFileSync(path.join(root, 'routes.d.ts'), 'utf8')).toContain('"/packages/orders/pages/detail"')
  })

  it('preserves the directory hierarchy below a containing root', async () => {
    const { root } = workspace()
    const source = writeFile(root, 'src/packages/account/pages/profile.vue')

    const ctx = await generate(root, [{
      dir: 'src/packages/*/pages',
      root: dir => path.posix.relative('src', path.posix.dirname(dir)),
    }])

    expectPageSource(ctx, source)
    expect(ctx.subPageMetaData).toMatchObject([{ root: 'packages/account', pages: [{ path: 'pages/profile' }] }])
    expect(fs.readFileSync(path.join(root, 'routes.d.ts'), 'utf8')).toContain('"/packages/account/pages/profile"')
  })

  it('keeps physical subpackage pages out of the main package when root differs from their directory', async () => {
    const { root } = workspace()
    const source = writeFile(root, 'src/pages/account/detail.vue')

    const ctx = await generate(root, [{ dir: 'src/pages/account', root: 'features/account' }])

    expectPageSource(ctx, source)
    expect(ctx.pageMetaData.map(page => page.path)).toEqual(['pages/index'])
  })

  it.each(['h5', 'mp-weixin'])('resolves a filtered %s page to its platform source', async (platform) => {
    const { root } = workspace()
    for (const target of ['h5', 'mp-weixin']) {
      writeFile(root, `src/packages/account/pages/profile.${target}.vue`, `<script setup>
definePage(({ platform }) => ({ style: { navigationBarTitleText: platform } }))
</script>`)
    }

    const ctx = await generate(root, [{ dir: 'src/packages/*/pages', root: 'features/account' }], platform)

    expectPageSource(ctx, path.join(root, `src/packages/account/pages/profile.${platform}.vue`), `.${platform}.vue`)
    expect(ctx.subPageMetaData[0].pages[0].style?.navigationBarTitleText).toBe(platform)
    const declaration = fs.readFileSync(path.join(root, 'routes.d.ts'), 'utf8')
    expect(declaration).toContain('"/packages/account/pages/profile"')
    expect(declaration).not.toContain('/packages/account/pages/profile.h5')
    expect(declaration).not.toContain('/packages/account/pages/profile.mp-weixin')
  })

  it('uses the shared input root as the path base for monorepo pages', async () => {
    const { workspace: root } = workspace()
    const source = writeFile(root, 'packages/login/src/pages/detail.vue')

    const { ctx } = await generateAll({
      outDir: '.',
      dir: 'apps/client/src/pages',
      homePage: 'apps/client/src/pages/index',
      subPackages: [{ dir: 'packages/*/src/pages', root: dir => path.posix.dirname(path.posix.dirname(dir)) }],
      dts: 'routes.d.ts',
    }, { root, platform: 'mp-weixin' })

    expectPageSource(ctx, source)
    expect(ctx.pageMetaData.map(page => page.path)).toEqual(['apps/client/src/pages/index'])
    expect(ctx.subPageMetaData).toMatchObject([{ root: 'packages/login', pages: [{ path: 'src/pages/detail' }] }])
    expect(fs.readFileSync(path.join(root, 'routes.d.ts'), 'utf8')).toContain('"/packages/login/src/pages/detail"')
  })
})
