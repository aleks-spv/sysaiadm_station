import { expect, test } from "bun:test";
import { createQuestionGuard, MAX_QUESTIONS } from "./question-guard";

const form = (id: string, title = "Какая задача?") => ({
  id,
  sessionID: "ses_1",
  title,
  fields: [{ key: "mode", title: "Какая задача?", options: [{ value: "diag", label: "Только диагностика" }] }],
});

test("a repeated answered question is answered from the first reply", () => {
  const guard = createQuestionGuard();
  expect(guard.created(form("f1"))).toBeNull();
  guard.answered("ses_1", "f1", { mode: "diag" });
  // Same question with different punctuation and case still counts as a repeat.
  const message = guard.created(form("f2", "какая задача"));
  expect(message).toContain("«Какая задача?» = Только диагностика");
  expect(message).toContain("Не задавай его снова");
});

test("a dismissed question is not asked again", () => {
  const guard = createQuestionGuard();
  guard.created(form("f1"));
  guard.answered("ses_1", "f1", null);
  expect(guard.created(form("f2"))).toContain("пользователь не стал отвечать");
});

test("an unanswered question does not block a different one, and sessions are separate", () => {
  const guard = createQuestionGuard();
  expect(guard.created(form("f1"))).toBeNull();
  expect(guard.created({ ...form("f2"), sessionID: "ses_2" })).toBeNull();
});

test("questions are capped per session", () => {
  const guard = createQuestionGuard();
  for (let i = 0; i < MAX_QUESTIONS; i++) expect(guard.created(form(`f${i}`, `вопрос ${i}`))).toBeNull();
  expect(guard.created(form("fx", "ещё вопрос"))).toContain("Лимит вопросов");
});
