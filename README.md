# Auto React Test

A CLI tool to **analyze React components** for JSX elements, state, props, effects, and API calls, and **auto-generate Jest tests**.

---

## Features

- Detects JSX elements (buttons, inputs, text, etc.)
- Detects component `state` and `props`
- Detects `useEffect` hooks and API calls (`fetch` / `axios`)
- Generates test files automatically using `@testing-library/react`
- Supports `data-testid` for more reliable DOM queries
- TypeScript compatible (generates `.test.tsx`)
- Works with both **Jest** and **Vitest**

---

## Installation

```bash
npm install -g auto-react-test
# or
yarn global add auto-react-test
```

## Usage Example

```bash
auto-react-test src/components/Todos.tsx
```

### Example Component (`Todos.tsx`)

```tsx

import React, { useState, useEffect } from "react";

interface Todo {
  id: number;
  title: string;
}

const Todos: React.FC = () => {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    // Simulate API fetch
    fetch("https://jsonplaceholder.typicode.com/todos?_limit=3")
      .then((res) => res.json())
      .then((data) => {
        const simplified = data.map((item: any) => ({
          id: item.id,
          title: item.title,
        }));
        setTodos(simplified);
      });
  }, []);

  const addTodo = () => {
    if (input.trim()) {
      setTodos([...todos, { id: Date.now(), title: input }]);
      setInput("");
    }
  };

  return (
    <div>
      <h1 data-testid="heading">Todo List</h1>
      <input
        data-testid="todo-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Add a todo"
      />
      <button data-testid="add-button" onClick={addTodo}>
        Add
      </button>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id} data-testid="todo">
            {todo.title}
          </li>
        ))}
      </ul>
    </div>
  );
};


export default Todos;

```

### Generated File (`Todos.test.tsx`)

```tsx

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Todos from "../Todos";

beforeEach(() => {
  // Safe default: no network; components expecting arrays get []
  vi.spyOn(globalThis as any, "fetch").mockResolvedValue({
    json: async () => [],
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Todos component", () => {
  test("renders without crashing", () => {
    render(<Todos />);
    expect(true).toBe(true);
  });

  test("renders expected element #1", () => {
    render(<Todos />);
    const el = screen.getByTestId("heading");
    expect(el).toHaveTextContent(/Todo List/i);
  });

  test("renders expected element #2", () => {
    render(<Todos />);
    const el = screen.getByRole("button", { name: /Add/i });
    expect(el).toHaveTextContent(/Add/i);
  });

  test("updates input value on typing", async () => {
    const user = userEvent.setup();
    render(<Todos />);
    const input = screen.getByRole("textbox");
    const value = `test-${Date.now()}`;
    await user.type(input as HTMLElement, value);
    // @ts-expect-error HTMLElement may be HTMLInputElement at runtime
    expect((input as HTMLInputElement).value).toBe(value);
  });

  test("adds a new item on button click", async () => {
    const user = userEvent.setup();
    render(<Todos />);
    const input = screen.getByRole("textbox");
    const button = screen.getByRole("button");
    const value = `test-${Date.now()}`;
    await user.type(input as HTMLElement, value);
    await user.click(button);
    const items = screen.queryAllByTestId("user");
    if (items.length) {
      expect(items[items.length - 1]).toHaveTextContent(new RegExp(value, "i"));
    } else {
      // Fallback if no testids for items are present
      expect(screen.getByText(new RegExp(value, "i"))).toBeInTheDocument();
    }
  });

  test("loads data from fetch on mount", async () => {
    // Override default fetch mock for this test with an ARRAY (component expects array)
    (globalThis.fetch as any) = vi.fn(() => Promise.resolve({
      json: async () => [{"input":"Sample Input","addTodo":"Sample AddTodo"}],
    }));
    render(<Todos />);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

});


```