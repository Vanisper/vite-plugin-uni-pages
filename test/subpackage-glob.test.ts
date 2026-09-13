import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PageContext } from '../packages/core/src/context'
import { resolveOptions } from '../packages/core/src/options'

const roots: string[] = []

function project(files: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-pages-glob-'))
  roots.push(root)
  for (const file of ['src/pages/index.vue', ...files]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), '<template><view /></template>')
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

describe('subpackage directory patterns', () => {
  it('combines fixed and glob directories with relative POSIX root callbacks', async () => {
    const root = project(['src/manual/entry.vue', 'src/packages/demo/pages/detail.vue', 'src/other/help/pages/index.vue'])
    const matched: string[] = []
    const rootForDir = (dir: string): string => {
      matched.push(dir)
      return path.posix.dirname(dir).slice(4)
    }
    const subPackages = [
      'src/manual',
      { dir: 'src/packages/*/pages', root: rootForDir },
      { dir: path.join(root, 'src/packages/demo/pages'), root: 'packages/demo' },
      { dir: 'src/other/*/pages', root: rootForDir },
    ]
    const original = subPackages.map(source => typeof source === 'string' ? source : { ...source })
    const ctx = new PageContext({ subPackages, dts: false }, root, 'h5')
    await ctx.scanAndMerge()

    expect(subPackages).toEqual(original)
    expect(new Set(matched)).toEqual(new Set(['src/packages/demo/pages', 'src/other/help/pages']))
    expect(ctx.subPageMetaData).toMatchObject([
      { root: 'manual', pages: [{ path: 'entry' }] },
      { root: 'packages/demo', pages: [{ path: 'pages/detail' }] },
      { root: 'other/help', pages: [{ path: 'pages/index' }] },
    ])
  })

  it('derives separate output roots when a string glob matches multiple packages', () => {
    const root = project(['src/packages/one/pages/index.vue', 'src/packages/two/pages/index.vue'])
    const options = resolveOptions({ subPackages: ['src/packages/*/pages'] }, root)
    expect([...options.subPackageRootMap.values()]).toEqual(['packages/one/pages', 'packages/two/pages'])
  })

  it('expands glob packages outside the project root', () => {
    const workspace = project(['app/src/pages/index.vue', 'shared/one/pages/index.vue'])
    const root = path.join(workspace, 'app')
    const subPackages = [{ dir: '../shared/*/pages', root: (dir: string) => dir.replace('../shared/', 'packages/') }]
    const options = resolveOptions({ subPackages, dts: false }, root)
    expect(options.subPackages).toEqual(['../shared/one/pages'])
    expect([...options.subPackageRootMap]).toEqual([['../shared/one/pages', 'packages/one/pages']])
  })

  it('keeps packages without pages and excluded files out of generated packages', async () => {
    const root = project([
      'src/packages/demo/pages/index.vue',
      'src/packages/demo/pages/components/Card.vue',
      'src/packages/demo/pages/_draft.vue',
      'src/packages/empty/pages/components/Card.vue',
      'src/packages/.hidden/pages/index.vue',
    ])
    const ctx = new PageContext({
      subPackages: ['src/packages/*/pages'],
      exclude: ['**/components/**', '**/_*.vue', '**/.*/**'],
      dts: false,
    }, root, 'h5')
    await ctx.scanAndMerge()
    expect(ctx.subPageMetaData).toMatchObject([{ root: 'packages/demo/pages', pages: [{ path: 'index' }] }])
  })

  it('refreshes a pattern that initially matches no directory', async () => {
    const root = project()
    const ctx = new PageContext({ subPackages: ['src/packages/*/pages'], dts: false }, root, 'h5')
    expect(ctx.options.subPackages).toEqual([])
    fs.mkdirSync(path.join(root, 'src/packages/demo/pages'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src/packages/demo/pages/index.vue'), '<template><view /></template>')
    await ctx.scanAndMerge()
    expect(ctx.subPageMetaData).toMatchObject([{ root: 'packages/demo/pages', pages: [{ path: 'index' }] }])
  })

  it('rejects one directory mapped to different output roots', () => {
    const root = project(['src/packages/demo/pages/index.vue'])
    expect(() => resolveOptions({ subPackages: [
      { dir: 'src/packages/*/pages', root: 'packages/demo' },
      { dir: 'src/packages/demo/pages', root: 'other' },
    ] }, root)).toThrow('maps to conflicting roots')
  })

  it('rejects different directories mapped to one output root', () => {
    const root = project(['src/packages/one/pages/index.vue', 'src/packages/two/pages/index.vue'])
    expect(() => resolveOptions({ subPackages: [{ dir: 'src/packages/*/pages', root: 'packages' }] }, root))
      .toThrow('maps to conflicting directories')
  })

  it.each(['', '   ', Promise.resolve('packages/demo')])('rejects an invalid root callback result %s', (result) => {
    const root = project(['src/packages/demo/pages/index.vue'])
    expect(() => resolveOptions({ subPackages: [{ dir: 'src/packages/*/pages', root: () => result as string }] }, root))
      .toThrow('expected a non-empty string')
  })
})
