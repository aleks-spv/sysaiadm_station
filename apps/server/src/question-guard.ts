// Weak (local) models loop on the question tool: they ask the same thing again right after the answer.
// The guard answers repeats itself, from what the admin already said, and caps questions per session.
// shortcut: in memory, forgotten on restart; a loop lives inside one run, persist if loops survive restarts.

export const MAX_QUESTIONS = 3;

interface FormLike {
  id: string;
  sessionID: string;
  title?: string;
  fields?: Array<{ key: string; title?: string; options?: Array<{ value: string; label: string }> }>;
}

type Answer = Record<string, unknown> | null;

interface Session {
  asked: number;
  forms: Map<string, FormLike>;
  // signature → answer text the admin gave ("без ответа" when cancelled)
  answers: Map<string, string>;
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function signature(form: FormLike): string {
  return [form.title, ...(form.fields ?? []).map((f) => f.title ?? f.key)].map(norm).join("|");
}

function answerText(form: FormLike, answer: Answer): string {
  if (!answer) return "пользователь не стал отвечать";
  return (form.fields ?? [])
    .filter((f) => answer[f.key] !== undefined)
    .map((f) => {
      const values = ([] as unknown[]).concat(answer[f.key]).map((v) => f.options?.find((o) => o.value === v)?.label ?? String(v));
      return `«${f.title ?? form.title ?? f.key}» = ${values.join(", ")}`;
    })
    .join("; ") || "пустой ответ";
}

export function createQuestionGuard() {
  const sessions = new Map<string, Session>();
  const session = (id: string) => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { asked: 0, forms: new Map(), answers: new Map() }));
    return s;
  };
  return {
    // A new question: null lets it through to the admin, a string is the cancel message for the model.
    created(form: FormLike): string | null {
      const s = session(form.sessionID);
      const previous = s.answers.get(signature(form));
      if (previous !== undefined) {
        return `Ты уже задавал этот вопрос, ответ пользователя: ${previous}. Не задавай его снова. Продолжай задачу с этим ответом: следующим шагом вызови remote_exec или дай итоговый отчёт.`;
      }
      if (s.asked >= MAX_QUESTIONS) {
        const known = [...s.answers.values()].join("; ") || "нет";
        return `Лимит вопросов в этой задаче исчерпан (${MAX_QUESTIONS}). Уже известные ответы: ${known}. Больше не спрашивай: действуй по задаче или дай итоговый отчёт и объясни, чего не хватает.`;
      }
      s.asked += 1;
      s.forms.set(form.id, form);
      return null;
    },
    // The admin answered (answer) or dismissed (null) a question that went through.
    answered(sessionID: string, formID: string, answer: Answer): void {
      const s = sessions.get(sessionID);
      const form = s?.forms.get(formID);
      if (!s || !form) return;
      s.forms.delete(formID);
      s.answers.set(signature(form), answerText(form, answer));
    },
  };
}

export const questionGuard = createQuestionGuard();
