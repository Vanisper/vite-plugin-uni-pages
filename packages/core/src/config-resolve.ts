import type { Plugin } from 'esbuild'
import type { Jiti } from 'jiti'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'

/** 外部包按实际导入文件解析，保留 import 与 require 的条件选择 */
export function externalConfigImportsPlugin(): Plugin {
  const resolvers = new Map<string, Jiti>()
  return {
    name: 'uni-pages:external-config-imports',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const specifier = args.path
        if (args.kind === 'entry-point')
          return
        if (isBuiltin(specifier) || specifier.startsWith('data:'))
          return { path: specifier, external: true }
        if ((specifier.startsWith('.') || path.isAbsolute(specifier)) && !/[\\/]node_modules[\\/]/.test(specifier))
          return

        const importer = args.importer || path.join(args.resolveDir, '_config.js')
        let resolver = resolvers.get(importer)
        if (!resolver) {
          resolver = createJiti(importer, { moduleCache: false, fsCache: false })
          resolvers.set(importer, resolver)
        }

        const resolved = args.kind === 'require-call' || args.kind === 'require-resolve'
          ? pathToFileURL(resolver.resolve(specifier)).href
          : resolver.esmResolve(specifier)
        return { path: resolved, external: true }
      })
    },
  }
}
