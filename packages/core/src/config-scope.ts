import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import MagicString from 'magic-string'
import ts from 'typescript'
import { normalizePath } from 'vite'

const jitiPath = createRequire(import.meta.url).resolve('jiti')

/** 保留未参与静态打包的 require 调用所在文件的解析上下文 */
export function preserveConfigScope(content: string, filename: string): string {
  if (!content.includes('require') && !content.includes('import.meta'))
    return content

  filename = normalizePath(filename)
  const options: ts.CompilerOptions = { allowJs: true, noResolve: true, noLib: true, types: [] }
  const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true)
  const host = ts.createCompilerHost(options)
  host.getSourceFile = file => normalizePath(file) === filename ? source : undefined
  const checker = ts.createProgram([filename], options, host).getTypeChecker()
  const code = new MagicString(content)
  let runtimeRequire = '__uni_pages_require__'
  while (content.includes(runtimeRequire))
    runtimeRequire += '_'

  function visit(node: ts.Node): void {
    const parent = node.parent
    if (!parent) {
      ts.forEachChild(node, visit)
      return
    }
    const symbol = ts.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(node)
    if (ts.isIdentifier(node) && node.text === 'require' && !symbol?.declarations?.length) {
      const argument = ts.isCallExpression(parent) ? parent.arguments[0] : undefined
      const literal = argument && ts.isStringLiteralLike(argument) ? argument.text : undefined
      const external = literal !== undefined && !isBuiltin(literal)
        && ((!literal.startsWith('.') && !path.isAbsolute(literal)) || /[/\\]node_modules[/\\]/.test(literal))
      const runtimeCall = ts.isCallExpression(parent) && parent.expression === node
        && (parent.arguments.length !== 1 || literal === undefined || external)
      const runtimeReference = ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node)
        || (ts.isVariableDeclaration(parent) && parent.initializer === node)
        || (ts.isReturnStatement(parent) && parent.expression === node)
        || (ts.isCallExpression(parent) && parent.arguments.includes(node))
        || ts.isShorthandPropertyAssignment(parent)
      if (runtimeCall || runtimeReference)
        code.update(node.getStart(source), node.end, ts.isShorthandPropertyAssignment(parent) ? `require: ${runtimeRequire}` : runtimeRequire)
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'resolve'
      && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
      code.update(node.getStart(source), node.end, `${runtimeRequire}.esmResolve`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!code.hasChanged())
    return content

  // 使用 Jiti 的文件级 require，继续支持运行时解析 TypeScript 文件
  const initialization = `import { createJiti as ${runtimeRequire}factory } from ${JSON.stringify(jitiPath)};\nconst ${runtimeRequire} = ${runtimeRequire}factory(${JSON.stringify(path.resolve(filename))}, { fsCache: false, moduleCache: false, interopDefault: true });\n`
  return code.prepend(initialization).toString()
}
