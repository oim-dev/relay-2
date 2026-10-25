import {
  ChainNodeParser,
  createFormatter,
  createParser,
  createProgram,
  DEFAULT_CONFIG,
  derefType,
  SchemaGenerator,
  ts,
  TupleType,
  type BaseType,
  type Config,
  type Context,
} from "ts-json-schema-generator";
import { generatorMessages } from "./generator.messages";

/**
 * Дополняет upstream parser поддержкой spread в const-кортежах текущих Contracts.
 * Разворачивает только проверенный TupleType, сохраняя точные литералы вместо unknown/string.
 */
export function contractSchemaGenerator(input: Config): SchemaGenerator {
  const config = { ...DEFAULT_CONFIG, ...input };
  const program = createProgram(config);
  const parser = createParser(program, config, (chain) => {
    if (!(chain instanceof ChainNodeParser)) {
      throw new Error(generatorMessages.parserContract);
    }
    const child = chain;
    chain.addNodeParser({
      /**
       * Подменяет только array literals, где upstream не понимает SpreadElement.
       */
      supportsNode: (node: ts.Node): boolean => ts.isArrayLiteralExpression(node),
      /**
       * Собирает tuple из исходных элементов и развёрнутых const tuple без изменения Contracts.
       */
      createType: (node: ts.Node, context: Context): BaseType => {
        if (!ts.isArrayLiteralExpression(node)) {
          throw new Error(generatorMessages.arrayLiteral);
        }
        const elements = node.elements.flatMap((element) => {
          if (!ts.isSpreadElement(element)) {
            return [child.createType(element, context)];
          }
          let expression: ts.Node = element.expression;
          if (ts.isIdentifier(expression)) {
            const checker = program.getTypeChecker();
            const found = checker.getSymbolAtLocation(expression);
            const symbol =
              found !== undefined && (found.flags & ts.SymbolFlags.Alias) !== 0
                ? checker.getAliasedSymbol(found)
                : found;
            const declaration = symbol?.valueDeclaration;
            if (
              declaration === undefined ||
              !ts.isVariableDeclaration(declaration) ||
              declaration.initializer === undefined
            ) {
              throw new Error(generatorMessages.initializer);
            }
            expression = declaration.initializer;
          }
          const spread = derefType(child.createType(expression, context));
          if (!(spread instanceof TupleType)) {
            throw new Error(generatorMessages.tuple);
          }
          return [...spread.getTypes()];
        });
        return new TupleType(elements);
      },
    });
  });
  return new SchemaGenerator(program, parser, createFormatter(config), config);
}
