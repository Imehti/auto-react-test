import fs from "fs";
import * as parser from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

export interface JSXElementInfo {
  type: string;
  props: Record<string, string | boolean>;
  text?: string;
  testId?: string;
  events?: Record<string, string>;
}

export interface StateInfo {
  stateVar: string;
  setter: string;
}

export interface AnalyzedComponent {
  name: string;
  elements: JSXElementInfo[];
  states: StateInfo[];
  effects: boolean;
  props: string[];
  usesFetch?: boolean;
  usesAxios?: boolean;
  apis?: { type: "axios" | "fetch"; method?: string; url: string }[];
  effectDeps?: string[];
  eventToSetterMap?: Record<string, string[]>;
}

const getJsxName = (
  node: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName
): string => {
  if (t.isJSXIdentifier(node)) return node.name;
  if (t.isJSXMemberExpression(node))
    return `${getJsxName(node.object)}.${getJsxName(node.property)}`;
  if (t.isJSXNamespacedName(node))
    return `${node.namespace.name}:${getJsxName(node.name)}`;
  return "Unknown";
};

const getJsxProps = (attrs: (t.JSXAttribute | t.JSXSpreadAttribute)[]) => {
  const propsObj: Record<string, string | boolean> = {};
  const events: Record<string, string> = {};
  let testId: string | undefined;

  for (const attr of attrs) {
    if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name)) {
      const key = attr.name.name;
      const val = attr.value;

      if (!val) propsObj[key] = true;
      else if (t.isStringLiteral(val)) propsObj[key] = val.value;
      else if (t.isJSXExpressionContainer(val)) {
        const expr = val.expression;
        if (t.isIdentifier(expr)) {
          propsObj[key] = `expr:${expr.name}`;
          if (key.startsWith("on")) events[key] = expr.name;
        } else if ("value" in expr && expr.value != null)
          propsObj[key] = String(expr.value);
        else propsObj[key] = "dynamic";
      } else propsObj[key] = "unknown";

      if (key === "data-testid" && t.isStringLiteral(val)) testId = val.value;
    }
  }
  return { props: propsObj, testId, events };
};

export const analyzeComponent = (filePath: string): AnalyzedComponent => {
  const code = fs.readFileSync(filePath, "utf-8");
  const ast = parser.parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  const elements: JSXElementInfo[] = [];
  const states: StateInfo[] = [];
  const props: string[] = [];
  const effectDeps: string[] = [];
  const eventToSetterMap: Record<string, string[]> = {};
  let effects = false;
  let usesFetch = false;
  let usesAxios = false;
  let componentName = "Anonymous";
  const analyzedAPIs: { type: "axios" | "fetch"; method?: string; url: string }[] = [];

  let mainFunctionPath: NodePath<t.FunctionDeclaration> | undefined;
  traverse(ast, {
    ExportDefaultDeclaration(path) {
      if (t.isFunctionDeclaration(path.node.declaration)) {
        mainFunctionPath = path.get("declaration") as NodePath<t.FunctionDeclaration>;
        componentName = path.node.declaration.id?.name || "DefaultComponent";
      }
    },
  });

  const visitor = {
    JSXElement(path: NodePath<t.JSXElement>) {
      const opening = path.node.openingElement;
      const { props: jsxProps, testId, events } = getJsxProps(opening.attributes);
      const type = getJsxName(opening.name);
      const textNode = path.node.children.find((c) => t.isJSXText(c));
      const text = textNode && t.isJSXText(textNode) ? textNode.value.trim() : undefined;

      elements.push({ type, props: jsxProps, text, testId, events });
    },

    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      const init = path.node.init;
      if (
        t.isArrayPattern(path.node.id) &&
        t.isCallExpression(init) &&
        ((t.isIdentifier(init.callee, { name: "useState" }) ||
          (t.isMemberExpression(init.callee) &&
            t.isIdentifier(init.callee.object, { name: "React" }) &&
            t.isIdentifier(init.callee.property, { name: "useState" }))))
      ) {
        const [stateVar, stateSetter] = path.node.id.elements;
        if (t.isIdentifier(stateVar) && t.isIdentifier(stateSetter))
          states.push({ stateVar: stateVar.name, setter: stateSetter.name });
      }
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee;

      if (
        t.isIdentifier(callee, { name: "useEffect" }) ||
        (t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object, { name: "React" }) &&
          t.isIdentifier(callee.property, { name: "useEffect" }))
      ) {
        effects = true;
        const deps = path.node.arguments[1];
        if (t.isArrayExpression(deps)) {
          deps.elements.forEach((el) => {
            if (t.isIdentifier(el)) effectDeps.push(el.name);
          });
        }

        const effectFunc = path.node.arguments[0];
        if (t.isArrowFunctionExpression(effectFunc) || t.isFunctionExpression(effectFunc)) {
          const statements: t.Statement[] = t.isBlockStatement(effectFunc.body)
            ? effectFunc.body.body
            : [t.expressionStatement(effectFunc.body)];

          traverse(t.file(t.program(statements)), {
            CallExpression(apiPath) {
              if (
                t.isMemberExpression(apiPath.node.callee) &&
                t.isIdentifier(apiPath.node.callee.object, { name: "axios" }) &&
                t.isIdentifier(apiPath.node.callee.property)
              ) {
                usesAxios = true;
                analyzedAPIs.push({
                  type: "axios",
                  method: apiPath.node.callee.property.name,
                  url:
                    apiPath.node.arguments[0] && t.isStringLiteral(apiPath.node.arguments[0])
                      ? apiPath.node.arguments[0].value
                      : "unknown",
                });
              }

              if (t.isIdentifier(apiPath.node.callee, { name: "fetch" })) {
                usesFetch = true;
                analyzedAPIs.push({
                  type: "fetch",
                  url:
                    apiPath.node.arguments[0] && t.isStringLiteral(apiPath.node.arguments[0])
                      ? apiPath.node.arguments[0].value
                      : "unknown",
                });
              }
            },
          });
        }
      }

      if (
        t.isCallExpression(path.node) &&
        t.isIdentifier(path.node.callee)
      ) {
        const setterName = path.node.callee.name;
        const matched = states.find((s) => s.setter === setterName);
        if (matched) {
          const parentFunc = path.findParent((p) =>
            p.isFunctionDeclaration() || p.isVariableDeclarator()
          );
          if (parentFunc && "node" in parentFunc.node) {
            const name = (parentFunc.node as any).id?.name;
            if (name) {
              if (!eventToSetterMap[name]) eventToSetterMap[name] = [];
              eventToSetterMap[name].push(setterName);
            }
          }
        }
      }
    },
  };

  if (mainFunctionPath) mainFunctionPath.traverse(visitor);
  else traverse(ast, visitor);

  return {
    name: componentName,
    elements,
    states,
    effects,
    props,
    usesFetch,
    usesAxios,
    apis: analyzedAPIs,
    effectDeps,
    eventToSetterMap,
  };
};
