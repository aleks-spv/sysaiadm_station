import { useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { t } from "@/i18n/app";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Room always left for the rest of the window, so a pane can grow up to almost the whole screen.
const KEEP_PX = 320;
const maxWidth = () => Math.max(KEEP_PX, window.innerWidth - KEEP_PX);

// Pane width remembered per browser.
export function usePaneWidth(key: string, initial: number, min: number) {
  const [width, setWidth] = useState(() => clamp(Number(localStorage.getItem(key)) || initial, min, maxWidth()));
  useEffect(() => localStorage.setItem(key, String(width)), [key, width]);
  return { width, setWidth: (w: number) => setWidth(clamp(w, min, maxWidth())), reset: () => setWidth(initial) };
}

// Vertical drag bar. edge="right": the pane is to the left (sidebar); edge="left": the pane is to the right (right panel).
export function ResizeHandle({ edge, pane }: { edge: "left" | "right"; pane: ReturnType<typeof usePaneWidth> }) {
  const [dragging, setDragging] = useState(false);
  const sign = edge === "right" ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = pane.width;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: globalThis.PointerEvent) => pane.setWidth(startW + sign * (ev.clientX - startX));
    const up = () => {
      setDragging(false);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") pane.setWidth(pane.width - sign * 16);
    else if (e.key === "ArrowRight") pane.setWidth(pane.width + sign * 16);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={pane.width}
      tabIndex={0}
      title={t("resize.hint")}
      onPointerDown={onPointerDown}
      onDoubleClick={pane.reset}
      onKeyDown={onKeyDown}
      className={cn(
        "relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none select-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-primary/60 focus-visible:after:bg-primary",
        dragging && "after:bg-primary",
      )}
    />
  );
}
