import * as path from 'path'
import * as fs from 'fs'
import * as ts from 'typescript'
import {ImportPathsResolver, createTraverseVisitor} from '@zerollup/ts-helpers'

const importPathRegex = /^(['"\s]+)(.+)(['"\s]+)$/

export type FixNode = (fixNode: ts.Node, newImport: string) => ts.Node

function createFixNode(sf: ts.SourceFile): FixNode {
    const posMap = new Map<string, number>()
    return function fixNode(fixNode: ts.Node, newImport: string): ts.Node {
        /**
         * This hack needed for properly d.ts paths rewrite.
         * moduleSpecifier value obtained by moduleSpecifier.pos from original source file text.
         * See emitExternalModuleSpecifier -> writeTextOfNode -> getTextOfNodeFromSourceText.
         *
         * We need to add new import path to the end of source file text and adjust moduleSpecifier.pos
         *
         * ts remove quoted string from output
         */
        const newStr = `"${newImport}"`
        let cachedPos = posMap.get(newImport)
        if (cachedPos === undefined) {
            cachedPos = sf.text.length
            posMap.set(newImport, cachedPos)
            sf.text += newStr
            sf.end += newStr.length
        }
        fixNode.pos = cachedPos
        fixNode.end = cachedPos + newStr.length

        return fixNode
    }
}

interface Config {
    for: string
}

interface ImportPathVisitorContext {
    resolver: ImportPathsResolver
    fixNode: FixNode
    sf: ts.SourceFile,
    config: Config
}

function importPathVisitor(
    node: ts.Node,
    {fixNode, resolver, sf, config}: ImportPathVisitorContext
): ts.Node | void {
    let importValue: string
    let nodeToFix: ts.Node
    if (ts.isCallExpression(node)) {
        if (node.expression.getText() !== 'require' || node.arguments.length !== 1) return
        const arg = node.arguments[0]
        if (!ts.isStringLiteral(arg)) return
        importValue = arg.getText()
        nodeToFix = arg
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (!node.moduleSpecifier) return
        importValue = node.moduleSpecifier.getFullText()
        nodeToFix = node.moduleSpecifier
    } else if (ts.isImportTypeNode(node)) {
        importValue = `"${(node.argument as any).literal.text}"`
    } else {
        return
    }

    const matches = importValue.match(importPathRegex)
    if (!matches) return

    const [, prefix, oldImport, suffix] = matches
    const newImports = resolver.getImportSuggestions(
        oldImport,
        path.dirname(sf.fileName)
    )
    if (!newImports) return
    let newImport = newImports[0]
    if (config && config.for == "browser" && !newImport.endsWith(".js")) {
        var source = path.join(path.dirname(sf.fileName),newImport);
        if (fs.existsSync(source+".min.js")) newImport += ".min.js";
        else if (fs.existsSync(source+".js")) newImport += ".js";
    }

    if (nodeToFix) fixNode(nodeToFix, newImport)
    const newSpec = ts.createLiteral(newImport)

    let newNode: ts.Node | void

    if (ts.isImportTypeNode(node)) {
        newNode = ts.updateImportTypeNode(
            node, ts.createLiteralTypeNode(newSpec), node.qualifier, node.typeArguments, node.isTypeOf
        )
        newNode.flags = node.flags
    }

    if (ts.isImportDeclaration(node)) {
        newNode = ts.updateImportDeclaration(
            node, node.decorators, node.modifiers, node.importClause, newSpec
        )

        /**
         * Without this hack ts generates bad import of pure interface in output js,
         * this causes warning "module has no exports" in bundlers.
         *
         * index.ts
         * ```ts
         * import {Some} from './lib'
         * export const some: Some = { self: 'test' }
         * ```
         *
         * lib.ts
         * ```ts
         * export interface Some { self: string }
         * ```
         *
         * output: index.js
         * ```js
         * import { Some } from "./some/lib"
         * export const some = { self: 'test' }
         * ```
         */
        newNode.flags = node.flags
    }

    if (ts.isExportDeclaration(node)) {
        const exportNode = ts.updateExportDeclaration(
            node, node.decorators, node.modifiers, node.exportClause, newSpec
        )
        if (exportNode.flags !== node.flags) {
            /**
             * Additional hacks for exports. Without it ts throw exception, if flags changed in export node.
             */
            const ms = exportNode.moduleSpecifier
            const oms = node.moduleSpecifier
            ms.pos = oms.pos
            ms.end = oms.end
            ms.parent = oms.parent

            newNode = exportNode

            newNode.flags = node.flags
        }
    }

    if (ts.isCallExpression(node)) newNode = ts.updateCall(
        node, node.expression, node.typeArguments, [newSpec]
    )

    return newNode
}

export default function transformPaths(program?: ts.Program, config?:Config) {
    const plugin = {
        before(
            transformationContext: ts.TransformationContext
        ): ts.Transformer<ts.SourceFile> {
            const resolver = new ImportPathsResolver(
                transformationContext.getCompilerOptions()
            )

            return (sf: ts.SourceFile) => {
                const ctx: ImportPathVisitorContext = {
                    sf,
                    resolver,
                    fixNode: createFixNode(sf),
                    config
                }

                const visitor = createTraverseVisitor(
                    importPathVisitor,
                    ctx,
                    transformationContext
                )
                return ts.visitNode(sf, visitor)
            }
        },
        afterDeclarations(
            transformationContext: ts.TransformationContext
        ): ts.Transformer<ts.SourceFile> {
            return plugin.before(transformationContext)
        }
    }

    return plugin
}
