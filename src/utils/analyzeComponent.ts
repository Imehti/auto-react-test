import fs from "fs";
import * as parser from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

export interface JSXElementInfo {
  type: string;
  props: Record<string, string | boolean>;
  text?: string;
  testId?: string;
  events?: Record<string, string>; // onClick -> handler identifier
  roleHint?: string;               // e.g. "button", "textbox" (best-effort)
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
  props: string[]; // list of prop names; best-effort
  usesFetch?: boolean;
  usesAxios?: boolean;
  apis?: { type: "axios" | "fetch"; method?: string; url: string }[];
  effectDeps?: string[];
  eventToSetterMap?: Record<string, string[]>; // handler name -> [setter...]
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

const guessRole = (name: string, props: Record<string, string | boolean>): string | undefined => {
  const lower = name.toLowerCase();
  if (lower === "button" || props["role"] === "button") return "button";
  if (lower === "input" || props["role"] === "textbox") {
    const type = String(props["type"] ?? "").toLowerCase();
    if (!type || type === "text") return "textbox";
  }
  if (lower === "a" || props["role"] === "link") return "link";
  if (lower === "img" || props["role"] === "img") return "img";
  return undefined;
};

const literalToString = (node: t.Expression | t.PrivateName): string | boolean => {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isBooleanLiteral(node)) return node.value;
  if ((node as any).value != null) return String((node as any).value);
  return "dynamic";
};

const getJsxProps = (attrs: (t.JSXAttribute | t.JSXSpreadAttribute)[]) => {
  const propsObj: Record<string, string | boolean> = {};
  const events: Record<string, string> = {};
  let testId: string | undefined;

  for (const attr of attrs) {
    if (t.isJSXSpreadAttribute(attr)) continue; // dynamic/unknown

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
        } else if (t.isLiteral(expr as any)) {
          propsObj[key] = literalToString(expr as any);
        } else if (t.isTSAsExpression(expr) || t.isTypeCastExpression(expr)) {
          const inner = (expr as t.TSAsExpression | t.TypeCastExpression).expression as t.Expression;
          if (t.isIdentifier(inner)) {
            propsObj[key] = `expr:${inner.name}`;
            if (key.startsWith("on")) events[key] = inner.name;
          } else {
            propsObj[key] = literalToString(inner);
          }
        } else {
          propsObj[key] = "dynamic";
        }
      } else {
        propsObj[key] = "unknown";
      }

      if (key === "data-testid" && t.isStringLiteral(val)) testId = val.value;
    }
  }
  return { props: propsObj, testId, events };
};

const unwrapDefaultExport = (
  path: NodePath<t.ExportDefaultDeclaration>
): { name?: string } => {
  const decl = path.node.declaration;

  if (t.isFunctionDeclaration(decl) && decl.id?.name) {
    return { name: decl.id.name };
  }

  if (t.isIdentifier(decl)) {
    return { name: decl.name }; // export default Users
  }

  if (t.isCallExpression(decl)) {
    // export default memo(Users) / forwardRef(Users)
    const firstArg = decl.arguments[0];
    if (t.isIdentifier(firstArg)) {
      return { name: firstArg.name };
    }
  }

  return {};
};

// Is node within the exported component’s fn/arrow?
const isInsideComponent = (path: NodePath, componentName: string): boolean => {
  // Function declaration with same name
  const func = path.getFunctionParent();
  if (func?.isFunctionDeclaration() && func.node.id?.name === componentName) return true;

  // Arrow/function assigned: const Users = () => {}
  const varDecl = path.findParent((p) => p.isVariableDeclarator());
  if (varDecl?.isVariableDeclarator()) {
    const id = varDecl.node.id;
    if (t.isIdentifier(id) && id.name === componentName) return true;
  }

  return false;
};

export const analyzeComponent = (filePath: string): AnalyzedComponent => {
  let code: string;
  try {
    code = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read file "${filePath}": ${(e as Error).message}`);
  }

  let ast: t.File;
  try {
    ast = parser.parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      sourceFilename: filePath,
    });
  } catch (e) {
    throw new Error(`Failed to parse "${filePath}": ${(e as Error).message}`);
  }

  // -----------------
  // PASS 1: find component name
  // -----------------
  let componentName = "Anonymous";
  traverse(ast, {
    ExportDefaultDeclaration(path) {
      const u = unwrapDefaultExport(path);
      if (u.name) componentName = u.name;
    },
  });

  const elements: JSXElementInfo[] = [];
  const states: StateInfo[] = [];
  const props: string[] = [];
  const effectDeps: string[] = [];
  const eventToSetterMap: Record<string, string[]> = {};
  let effects = false;
  let usesFetch = false;
  let usesAxios = false;
  const analyzedAPIs: { type: "axios" | "fetch"; method?: string; url: string }[] = [];

  const collectPropsFromParams = (p: t.Function | t.ArrowFunctionExpression | t.FunctionExpression) => {
    if ("params" in p && p.params[0]) {
      const param = p.params[0];
      if (t.isObjectPattern(param)) {
        for (const prop of param.properties) {
          if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) props.push(prop.key.name);
          if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) props.push(prop.argument.name);
        }
      } else if (t.isIdentifier(param)) {
        props.push(param.name);
      }
    }
  };

  // -----------------
  // PASS 2: collect details using the known componentName
  // -----------------
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === componentName) {
        collectPropsFromParams(path.node);
      }
    },

    VariableDeclarator(path) {
      // If this declarator defines the component, collect props
      if (t.isIdentifier(path.node.id) && path.node.id.name === componentName) {
        const init = path.node.init;
        if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
          collectPropsFromParams(init);
        }
      }

      if (!isInsideComponent(path, componentName)) return;

      // Detect useState
      const init = path.node.init;
      if (
        t.isArrayPattern(path.node.id) &&
        t.isCallExpression(init) &&
        ((t.isIdentifier(init.callee, { name: "useState" }) ||
          (t.isMemberExpression(init.callee) &&
            t.isIdentifier((init.callee as t.MemberExpression).object, { name: "React" }) &&
            t.isIdentifier((init.callee as t.MemberExpression).property, { name: "useState" }))))
      ) {
        const [stateVar, stateSetter] = path.node.id.elements;
        if (t.isIdentifier(stateVar) && t.isIdentifier(stateSetter))
          states.push({ stateVar: stateVar.name, setter: stateSetter.name });
      }
    },

    JSXElement(path) {
      if (!isInsideComponent(path, componentName)) return;
      const opening = path.node.openingElement;
      const { props: jsxProps, testId, events } = getJsxProps(opening.attributes);
      const type = getJsxName(opening.name);
      const textNode = path.node.children.find((c) => t.isJSXText(c));
      const text = textNode && t.isJSXText(textNode) ? textNode.value.trim() : undefined;
      const roleHint = guessRole(type, jsxProps);
      elements.push({ type, props: jsxProps, text, testId, events, roleHint });
    },

    CallExpression(path) {
      if (!isInsideComponent(path, componentName)) return;
      const callee = path.node.callee;

      // useEffect
      if (
        t.isIdentifier(callee, { name: "useEffect" }) ||
        (t.isMemberExpression(callee) &&
          t.isIdentifier((callee as t.MemberExpression).object, { name: "React" }) &&
          t.isIdentifier((callee as t.MemberExpression).property, { name: "useEffect" }))
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
              // axios.<method>(url)
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
              // fetch(url)
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

      // Setter call inside handlers: handlerName -> setters[]
      if (t.isIdentifier(path.node.callee)) {
        const setterName = path.node.callee.name;
        const matched = states.find((s) => s.setter === setterName);
        if (matched) {
          const handlerFunc = path.getFunctionParent();
          if (handlerFunc) {
            let name = "";
            const parent = handlerFunc.parentPath;
            if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
              name = parent.node.id.name;
            } else if (handlerFunc.isFunctionDeclaration() && handlerFunc.node.id?.name) {
              name = handlerFunc.node.id.name;
            }
            if (name) {
              if (!eventToSetterMap[name]) eventToSetterMap[name] = [];
              eventToSetterMap[name].push(setterName);
            }
          }
        }
      }
    },
  });

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
