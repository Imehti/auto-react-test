import fs from "fs";
import path from "path";
import { AnalyzedComponent, JSXElementInfo } from "./utils/analyzeComponent";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const generateMockDataForApi = (
  api: { type: "axios" | "fetch"; method?: string; url: string },
  elements: JSXElementInfo[]
) => {
  const fields = elements
    .flatMap((e) =>
      Object.values(e.props).filter(
        (p): p is string => typeof p === "string" && p.startsWith("expr:")
      )
    )
    .map((p) => p.replace("expr:", ""));

  const mockItem = Object.fromEntries(fields.map((f) => [f, `Sample ${capitalize(f)}`]));
  return { data: [mockItem] };
};

export const generateTestFile = (
  filePath: string,
  analyzed?: AnalyzedComponent
) => {
  const componentName = path.basename(filePath, path.extname(filePath));
  const testFileName = `${componentName}.test.tsx`;
  const testDir = path.join(path.dirname(filePath), "__tests__");

  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir);

  analyzed = analyzed || {
    elements: [],
    states: [],
    props: [],
    effects: false,
    name: "",
    usesFetch: false,
    usesAxios: false,
    apis: [],
    effectDeps: [],
    eventToSetterMap: {},
  };

  const lines: string[] = [];

  // Imports
  lines.push(`import React from "react";`);
  lines.push(`import { render, screen, fireEvent } from "@testing-library/react";`);
  lines.push(`import "@testing-library/jest-dom";`);
  lines.push(`import { vi } from "vitest";`);
  lines.push(`import ${componentName} from "../${componentName}";`);
  lines.push("");

  lines.push(`describe("${componentName} component", () => {`);

  // Render test
  lines.push(`  test("renders without crashing", () => {`);
  lines.push(`    render(<${componentName} />);`);
  lines.push(`  });`);
  lines.push("");

  // JSX element assertions
  analyzed.elements.forEach((el) => {
    if (el.testId && el.text) {
      lines.push(`  test("renders ${el.type} with correct text", () => {`);
      lines.push(`    render(<${componentName} />);`);
      lines.push(`    expect(screen.getByTestId("${el.testId}")).toHaveTextContent("${el.text}");`);
      lines.push(`  });`);
      lines.push("");
    }
  });

  // useState: input + todos
  const inputEl = analyzed.elements.find((e) => e.testId === "todo-input");
  const buttonEl = analyzed.elements.find((e) => e.testId === "add-button");

  if (inputEl) {
    lines.push(`  test("updates input state on change", () => {`);
    lines.push(`    render(<${componentName} />);`);
    lines.push(`    const input = screen.getByTestId("todo-input");`);
    lines.push(`    fireEvent.change(input, { target: { value: "Buy milk" } });`);
    lines.push(`    expect(input).toHaveValue("Buy milk");`);
    lines.push(`  });`);
    lines.push("");
  }

  if (inputEl && buttonEl) {
    lines.push(`  test("adds a new todo on button click", () => {`);
    lines.push(`    render(<${componentName} />);`);
    lines.push(`    const input = screen.getByTestId("todo-input");`);
    lines.push(`    const button = screen.getByTestId("add-button");`);
    lines.push(`    fireEvent.change(input, { target: { value: "Buy milk" } });`);
    lines.push(`    fireEvent.click(button);`);
    lines.push(`    const items = screen.getAllByTestId("todo");`);
    lines.push(`    expect(items).toHaveLength(1);`);
    lines.push(`    expect(items[0]).toHaveTextContent("Buy milk");`);
    lines.push(`  });`);
    lines.push("");
  }

  // useEffect test
  if (analyzed.effects) {
    lines.push(`  test("loads todos from API on mount", async () => {`);
    const mockTodos = [
      { id: 1, title: "Mock Todo 1" },
      { id: 2, title: "Mock Todo 2" },
    ];
    lines.push(`    global.fetch = vi.fn(() => Promise.resolve({`);
    lines.push(`      json: () => Promise.resolve(${JSON.stringify(mockTodos)}),`);
    lines.push(`    }));`);
    lines.push(`    render(<${componentName} />);`);
    lines.push(`    const items = await screen.findAllByTestId("todo");`);
    lines.push(`    expect(items).toHaveLength(${mockTodos.length});`);
    lines.push(`    expect(items[0]).toHaveTextContent("${mockTodos[0].title}");`);
    lines.push(`  });`);
    lines.push("");
  }

  lines.push(`});`);
  lines.push("");

  const content = lines.join("\n");
  const testPath = path.join(testDir, testFileName);
  fs.writeFileSync(testPath, content, "utf-8");
  console.log(`✅ Test file created: ${testPath}`);
};
