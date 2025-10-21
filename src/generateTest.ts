import fs from "fs";
import path from "path";
import { AnalyzedComponent, JSXElementInfo } from "./utils/analyzeComponent";

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const escapeForTs = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$").replace(/<\/(script)>/gi, "<\\/$1");

const chooseQuery = (el: JSXElementInfo) => {
  if (el.roleHint === "button") {
    const namePart = el.text ? `, { name: /${escapeForTs(el.text)}/i }` : "";
    return `screen.getByRole("button"${namePart})`;
  }
  if (el.roleHint === "textbox") return `screen.getByRole("textbox")`;
  if (el.roleHint === "link") {
    const namePart = el.text ? `, { name: /${escapeForTs(el.text)}/i }` : "";
    return `screen.getByRole("link"${namePart})`;
  }
  if (el.testId) return `screen.getByTestId("${escapeForTs(el.testId)}")`;
  if (el.text) return `screen.getByText(/${escapeForTs(el.text)}/i)`;
  return `screen.getByText(/.+/)`; // we'll filter these out below
};

// very light heuristic: items with these testids are often dynamic (lists)
const isLikelyDynamicItem = (el: JSXElementInfo) => {
  const id = (el.testId || "").toLowerCase();
  const dynIds = ["user", "todo", "item", "row", "card"];
  return !!id && dynIds.some((k) => id === k || id.endsWith(`-${k}`) || id.startsWith(`${k}-`));
};

// Produce simple mock rows from element prop “expr:name” hints
const buildSampleRow = (elements: JSXElementInfo[]) => {
  const fields = elements
    .flatMap((e) =>
      Object.values(e.props).filter(
        (p): p is string => typeof p === "string" && p.startsWith("expr:")
      )
    )
    .map((p) => p.replace("expr:", ""));

  const obj: Record<string, unknown> = {};
  if (!fields.length) {
    obj.id = 1;
    obj.username = "Eve";
  } else {
    for (const f of fields) obj[f] = `Sample ${capitalize(f)}`;
  }
  return obj;
};

export const generateTestFile = (
  filePath: string,
  analyzed?: AnalyzedComponent,
  opts?: { force?: boolean }
) => {
  const componentName = path.basename(filePath, path.extname(filePath));
  const testFileName = `${componentName}.test.tsx`;
  const testDir = path.join(path.dirname(filePath), "__tests__");
  const testPath = path.join(testDir, testFileName);

  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  if (fs.existsSync(testPath) && !opts?.force) {
    console.log(`⚠️  Test file already exists. Use --force to overwrite: ${testPath}`);
    return;
  }

  analyzed = analyzed || {
    elements: [],
    states: [],
    props: [],
    effects: false,
    name: componentName,
    usesFetch: false,
    usesAxios: false,
    apis: [],
    effectDeps: [],
    eventToSetterMap: {},
  };

  const lines: string[] = [];

  // Imports
  lines.push(`import { render, screen } from "@testing-library/react";`);
  lines.push(`import userEvent from "@testing-library/user-event";`);
  lines.push(`import "@testing-library/jest-dom";`);
  lines.push(`import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";`);
  lines.push(`import ${componentName} from "../${componentName}";`);
  lines.push("");

  // Global safe fetch mock so unrelated tests never hit the network
  if (analyzed.effects) {
    lines.push(`beforeEach(() => {`);
    lines.push(`  // Safe default: no network; components expecting arrays get []`);
    lines.push(`  vi.spyOn(globalThis as any, "fetch").mockResolvedValue({`);
    lines.push(`    json: async () => [],`);
    lines.push(`  } as any);`);
    lines.push(`});`);
    lines.push("");
  }

  lines.push(`afterEach(() => {`);
  lines.push(`  vi.restoreAllMocks();`);
  lines.push(`});`);
  lines.push("");

  lines.push(`describe("${componentName} component", () => {`);

  // Props (as JSX attributes). If we can't infer real names, omit props entirely.
  const hasProps = analyzed.props.length && analyzed.props[0] !== "props";
  const renderProps = hasProps
    ? ` ${analyzed.props
        .map((p) => `${p}=${JSON.stringify(`Sample ${capitalize(p)}`)}`)
        .join(" ")}`
    : "";

  // Render smoke test
  lines.push(`  test("renders without crashing", () => {`);
  lines.push(`    render(<${componentName}${renderProps} />);`);
  lines.push(`    expect(true).toBe(true);`);
  lines.push(`  });`);
  lines.push("");

  // Element presence tests (filter out generic fallback + likely dynamic items)
  const stableElements: JSXElementInfo[] = analyzed.elements.filter((el) => {
    if (isLikelyDynamicItem(el)) return false;
    const q = chooseQuery(el);
    if (q.includes('getByText(/.+/)')) return false;
    return true;
  });

  stableElements.slice(0, 6).forEach((el, idx) => {
    const q = chooseQuery(el);
    lines.push(`  test("renders expected element #${idx + 1}", () => {`);
    lines.push(`    render(<${componentName}${renderProps} />);`);
    lines.push(`    const el = ${q};`);
    if (el.text) lines.push(`    expect(el).toHaveTextContent(/${escapeForTs(el.text)}/i);`);
    else lines.push(`    expect(el).toBeInTheDocument();`);
    lines.push(`  });`);
    lines.push("");
  });

  // Interaction tests (textbox + button heuristic)
  const inputEl =
    analyzed.elements.find((e) => e.roleHint === "textbox" || e.testId === "user-input") ||
    analyzed.elements.find((e) => e.type.toLowerCase() === "input");
  const buttonEl =
    analyzed.elements.find((e) => e.roleHint === "button" || e.testId === "add-button") ||
    analyzed.elements.find((e) => e.type.toLowerCase() === "button");

  if (inputEl) {
    lines.push(`  test("updates input value on typing", async () => {`);
    lines.push(`    const user = userEvent.setup();`);
    lines.push(`    render(<${componentName}${renderProps} />);`);
    if (inputEl.roleHint === "textbox") {
      lines.push(`    const input = screen.getByRole("textbox");`);
    } else if (inputEl.testId) {
      lines.push(`    const input = screen.getByTestId("${escapeForTs(inputEl.testId)}");`);
    } else {
      lines.push(`    const input = screen.getByRole("textbox");`);
    }
    lines.push(`    const value = \`test-\${Date.now()}\`;`);
    lines.push(`    await user.type(input as HTMLElement, value);`);
    lines.push(`    // @ts-expect-error HTMLElement may be HTMLInputElement at runtime`);
    lines.push(`    expect((input as HTMLInputElement).value).toBe(value);`);
    lines.push(`  });`);
    lines.push("");
  }

  if (inputEl && buttonEl) {
    lines.push(`  test("adds a new item on button click", async () => {`);
    lines.push(`    const user = userEvent.setup();`);
    lines.push(`    render(<${componentName}${renderProps} />);`);
    if (inputEl.roleHint === "textbox") {
      lines.push(`    const input = screen.getByRole("textbox");`);
    } else if (inputEl.testId) {
      lines.push(`    const input = screen.getByTestId("${escapeForTs(inputEl.testId)}");`);
    } else {
      lines.push(`    const input = screen.getByRole("textbox");`);
    }
    if (buttonEl.roleHint === "button") {
      lines.push(`    const button = screen.getByRole("button");`);
    } else if (buttonEl.testId) {
      lines.push(`    const button = screen.getByTestId("${escapeForTs(buttonEl.testId)}");`);
    } else {
      lines.push(`    const button = screen.getByRole("button");`);
    }
    lines.push(`    const value = \`test-\${Date.now()}\`;`);
    lines.push(`    await user.type(input as HTMLElement, value);`);
    lines.push(`    await user.click(button);`);
    lines.push(`    const items = screen.queryAllByTestId("user");`);
    lines.push(`    if (items.length) {`);
    lines.push(`      expect(items[items.length - 1]).toHaveTextContent(new RegExp(value, "i"));`);
    lines.push(`    } else {`);
    lines.push(`      // Fallback if no testids for items are present`);
    lines.push(`      expect(screen.getByText(new RegExp(value, "i"))).toBeInTheDocument();`);
    lines.push(`    }`);
    lines.push(`  });`);
    lines.push("");
  }

  // useEffect + API tests (fetch/axios) — return shapes that match each API
  if (analyzed.effects && analyzed.apis && analyzed.apis.length) {
    const api = analyzed.apis[0];

    if (api.type === "fetch") {
      const row = buildSampleRow(analyzed.elements);
      const mockArray = [row];
      lines.push(`  test("loads data from fetch on mount", async () => {`);
      lines.push(`    // Override default fetch mock for this test with an ARRAY (component expects array)`);
      lines.push(`    (globalThis.fetch as any) = vi.fn(() => Promise.resolve({`);
      lines.push(`      json: async () => ${JSON.stringify(mockArray)},`);
      lines.push(`    }));`);
      lines.push(`    render(<${componentName}${renderProps} />);`);
      lines.push(`    expect(globalThis.fetch).toHaveBeenCalled();`);
      lines.push(`  });`);
      lines.push("");
    } else if (api.type === "axios") {
      const row = buildSampleRow(analyzed.elements);
      const mockObj = { data: [row] }; // axios returns { data }
      lines.push(`  test("loads data from axios on mount", async () => {`);
      lines.push(`    vi.mock("axios", () => ({`);
      lines.push(`      default: {`);
      lines.push(`        ${api.method || "get"}: vi.fn().mockResolvedValue(${JSON.stringify(mockObj)}),`);
      lines.push(`      },`);
      lines.push(`    }));`);
      lines.push(`    const axios = (await import("axios")).default as any;`);
      lines.push(`    render(<${componentName}${renderProps} />);`);
      lines.push(`    expect(axios.${api.method || "get"}).toHaveBeenCalled();`);
      lines.push(`  });`);
      lines.push("");
    }
  }

  lines.push(`});`);
  lines.push("");

  const content = lines.join("\n");
  fs.writeFileSync(testPath, content, "utf-8");
  console.log(`✅ Test file created: ${testPath}`);
};
