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

import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import Todos from "../Todos";

describe("Todos component", () => {
  test("renders without crashing", () => {
    render(<Todos />);
  });

  test("renders h1 with correct text", () => {
    render(<Todos />);
    expect(screen.getByTestId("heading")).toHaveTextContent("Todo List");
  });

  test("renders button with correct text", () => {
    render(<Todos />);
    expect(screen.getByTestId("add-button")).toHaveTextContent("Add");
  });

  test("updates input state on change", () => {
    render(<Todos />);
    const input = screen.getByTestId("todo-input");
    fireEvent.change(input, { target: { value: "Buy milk" } });
    expect(input).toHaveValue("Buy milk");
  });

  test("adds a new todo on button click", () => {
    render(<Todos />);
    const input = screen.getByTestId("todo-input");
    const button = screen.getByTestId("add-button");
    fireEvent.change(input, { target: { value: "Buy milk" } });
    fireEvent.click(button);
    const items = screen.getAllByTestId("todo");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Buy milk");
  });

  test("loads todos from API on mount", async () => {
    (global as any).fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve([{"id":1,"title":"Mock Todo 1"},{"id":2,"title":"Mock Todo 2"}]),
    }));
    render(<Todos />);
    const items = await screen.findAllByTestId("todo");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Mock Todo 1");
  });

});

```