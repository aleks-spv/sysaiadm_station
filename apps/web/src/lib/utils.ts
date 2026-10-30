import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { t } from "@/i18n/app";

// Native <select>/<textarea> styled like the shadcn Input, for forms that need no extra component.
export const fieldClass =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 [&>option]:bg-popover [&:is(select)]:h-8 [&:is(select)]:py-0";

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : t("common.error");
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
