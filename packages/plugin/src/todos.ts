// Todo list for the model (todowrite tool). Adapted from opencode-todos
// (MIT, Copyright (c) 2026 Fitiavana Anhy Krishna, https://github.com/krishna2206/opencode-todos).
// The web reads the list back from the last todowrite call in the message history.

export const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof STATUSES)[number];

export interface TodoInput {
  id?: string;
  content: string;
  status: TodoStatus;
}

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

export const DESCRIPTION = [
  "Keep a todo list for the current task so the admin sees the plan and the progress.",
  "Use it when the work has three or more distinct steps, or the admin gives several tasks; skip it for a single simple check or a pure question.",
  "Send the complete list every time: items left out are dropped. Echo each item's id to keep its identity.",
  "Keep exactly one item in_progress while working, and mark items completed as soon as they are verified.",
].join(" ");

export const SCHEMA = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "The complete todo list",
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id of an existing item, as returned by a previous call" },
          content: { type: "string", minLength: 1, maxLength: 500, description: "What the task is" },
          status: { type: "string", enum: [...STATUSES] },
        },
        required: ["content", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
};

// Throws with a message meant for the model when the input is not a usable list.
export function validate(input: unknown): TodoInput[] {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) throw new Error("todos must be an array");
  return todos.map((raw, index) => {
    const todo = raw as Partial<TodoInput> | null;
    if (typeof todo?.content !== "string" || !todo.content.trim()) throw new Error(`todo ${index + 1} has empty content`);
    if (!STATUSES.includes(todo.status as TodoStatus)) throw new Error(`todo ${index + 1} has a bad status`);
    return { id: typeof todo.id === "string" ? todo.id : undefined, content: todo.content, status: todo.status as TodoStatus };
  });
}

// Items keep their identity across calls: by the echoed id, else by identical content.
export function applyWrite(previous: Todo[], input: TodoInput[], now: number): Todo[] {
  const byId = new Map(previous.map((todo) => [todo.id, todo]));
  const byContent = new Map(previous.map((todo) => [todo.content.trim(), todo]));
  const claimed = new Set<string>();
  let counter = 0;
  return input.map((item) => {
    const content = item.content.trim();
    const candidate = (item.id && !claimed.has(item.id) ? byId.get(item.id) : undefined) ?? byContent.get(content);
    const match = candidate && !claimed.has(candidate.id) ? candidate : undefined;
    let id = match?.id ?? item.id ?? `t${now.toString(36)}${(counter++).toString(36)}`;
    while (claimed.has(id)) id = `t${now.toString(36)}${(counter++).toString(36)}`;
    claimed.add(id);
    return { id, content, status: item.status };
  });
}

const MARKER: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]", cancelled: "[-]" };

export function renderForModel(todos: Todo[]): string {
  if (todos.length === 0) return "(no todos)";
  const done = todos.filter((todo) => todo.status === "completed").length;
  return [...todos.map((todo) => `${MARKER[todo.status]} ${todo.content} (id: ${todo.id})`), "", `${done}/${todos.length} completed`].join("\n");
}

export const isOpen = (todos: Todo[]) => todos.some((todo) => todo.status === "pending" || todo.status === "in_progress");
