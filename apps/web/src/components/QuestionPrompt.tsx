import { useState, type FormEvent } from "react";
import { ExternalLink, MessageCircleQuestion } from "lucide-react";
import type { AgentForm, FormAnswer, FormField } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, fieldClass } from "@/lib/utils";
import { t } from "@/i18n/app";

type Value = string | number | boolean | string[];

function initial(field: FormField): Value | undefined {
  switch (field.type) {
    case "external":
      return undefined;
    // Number defaults may arrive as "Infinity"/"NaN" strings; only real numbers prefill.
    case "number":
    case "integer":
      return typeof field.default === "number" ? field.default : undefined;
    case "boolean":
      return field.default ?? false;
    case "multiselect":
      return field.default ?? [];
    default:
      return field.default;
  }
}

// Fields with `when` show only while their conditions hold.
function visible(field: FormField, answer: FormAnswer): boolean {
  if (field.type !== "external" && field.hidden) return false;
  const when = field.type === "external" ? undefined : field.when;
  return (when ?? []).every((w) => (w.op === "eq" ? answer[w.key] === w.value : answer[w.key] !== w.value));
}

const empty = (v: Value | undefined) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

// A question from the agent (opencode question tool): one card with every field, answered at once.
export default function QuestionPrompt({ form, onReply, onCancel }: { form: AgentForm; onReply: (answer: FormAnswer) => Promise<void>; onCancel: () => void }) {
  const [answer, setAnswer] = useState<FormAnswer>(() => {
    const out: FormAnswer = {};
    for (const f of form.fields) {
      const v = initial(f);
      if (v !== undefined) out[f.key] = v;
    }
    return out;
  });
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (key: string, value: Value | undefined) =>
    setAnswer((a) => {
      const next = { ...a };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  const shown = form.fields.filter((f) => visible(f, answer));
  const missing = shown.some((f) => f.type !== "external" && f.required && empty(answer[f.key]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (missing) return;
    const out: FormAnswer = {};
    for (const f of shown) if (f.type !== "external" && !empty(answer[f.key])) out[f.key] = answer[f.key]!;
    setBusy(true);
    try {
      await onReply(out);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-3 text-sm shadow-sm">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t("question.from")}</p>
          <p className="font-medium whitespace-pre-wrap">{form.title}</p>
        </div>
      </div>
      {shown.map((f) => (
        <div key={f.key} className="space-y-1.5">
          {f.title && f.type !== "boolean" && (
            <p className="text-xs font-medium">
              {f.title}
              {f.type !== "external" && f.required && <span className="text-destructive"> *</span>}
            </p>
          )}
          {f.description && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{f.description}</p>}
          {f.type === "external" && (
            <a href={f.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
              <ExternalLink className="size-3.5" /> {f.title ?? f.url}
            </a>
          )}
          {f.type === "string" && f.options?.length ? (
            <div className="flex flex-col gap-1">
              {f.options.map((o) => (
                <label key={o.value} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5", answer[f.key] === o.value ? "border-primary bg-primary/10" : "hover:bg-accent/50")}>
                  <input type="radio" className="mt-0.5" name={f.key} checked={answer[f.key] === o.value} onChange={() => set(f.key, o.value)} />
                  <span>
                    {o.label}
                    {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                  </span>
                </label>
              ))}
              {f.custom && (
                <Input
                  placeholder={t("question.custom")}
                  value={custom[f.key] ?? ""}
                  onChange={(e) => {
                    setCustom((c) => ({ ...c, [f.key]: e.target.value }));
                    set(f.key, e.target.value || undefined);
                  }}
                />
              )}
            </div>
          ) : null}
          {f.type === "string" && !f.options?.length && (
            <textarea
              className={cn(fieldClass, "min-h-16")}
              placeholder={f.placeholder}
              maxLength={f.maxLength}
              value={(answer[f.key] as string | undefined) ?? ""}
              onChange={(e) => set(f.key, e.target.value)}
            />
          )}
          {(f.type === "number" || f.type === "integer") && (
            <Input
              type="number"
              className="w-40"
              step={f.type === "integer" ? 1 : "any"}
              value={(answer[f.key] as number | undefined) ?? ""}
              onChange={(e) => set(f.key, e.target.value === "" ? undefined : Number(e.target.value))}
            />
          )}
          {f.type === "boolean" && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={answer[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} />
              {f.title}
            </label>
          )}
          {f.type === "multiselect" && (
            <div className="flex flex-col gap-1">
              {f.options.map((o) => {
                const list = (answer[f.key] as string[] | undefined) ?? [];
                return (
                  <label key={o.value} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={list.includes(o.value)}
                      onChange={(e) => set(f.key, e.target.checked ? [...list, o.value] : list.filter((v) => v !== o.value))}
                    />
                    <span>
                      {o.label}
                      {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || missing}>
          {t("question.answer")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("question.skip")}
        </Button>
      </div>
    </form>
  );
}
