import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { LANGS, lang, setLang, type Lang } from "@/i18n";
import { t } from "@/i18n/settings";
import { ACCENTS, LIMITS, MONO_FONTS, UI_FONTS, fontStack, resetPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { cn, fieldClass } from "@/lib/utils";
import { THEMES, applyTheme, currentTheme } from "@/theme";

// Per-browser preferences: every control applies at once, nothing waits for a Save button.
export default function GeneralSection() {
  const prefs = usePrefs();
  const [theme, setTheme] = useState(currentTheme);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const notifySupported = typeof window !== "undefined" && "Notification" in window;

  const changeTheme = (id: string) => {
    applyTheme(id);
    setTheme(id);
  };

  const toggleNotify = async (on: boolean) => {
    setNotifyError(null);
    if (!on) {
      setPrefs({ notify: false });
      return;
    }
    if (Notification.permission !== "granted") {
      const result = await Notification.requestPermission();
      if (result !== "granted") {
        setNotifyError(t("general.notifyDenied"));
        return;
      }
    }
    setPrefs({ notify: true });
  };

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">{t("general.intro")}</p>

      <section>
        <Row label={t("general.language")}>
          <select className={cn(fieldClass, "w-auto")} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("general.themeAndColor")}</h4>
        <Row label={t("general.theme")}>
          <Segmented value={theme} options={THEMES.map((t) => ({ value: t.id, label: t.label }))} onChange={changeTheme} />
        </Row>
        <Row label={t("general.accent")} hint={ACCENTS.find((a) => a.id === prefs.accent)?.label}>
          <div className="flex items-center gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                title={a.label}
                aria-label={a.label}
                aria-pressed={a.id === prefs.accent}
                onClick={() => setPrefs({ accent: a.id })}
                style={{ background: `oklch(0.7 ${a.chroma} ${a.hue})` }}
                className={cn(
                  "size-7 rounded-full transition-shadow",
                  a.id === prefs.accent && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                )}
              />
            ))}
          </div>
        </Row>
        <Row label={t("general.radius")} hint={`${prefs.radius} rem`}>
          <input
            type="range"
            min={LIMITS.radius[0]}
            max={LIMITS.radius[1]}
            step={0.125}
            value={prefs.radius}
            onChange={(e) => setPrefs({ radius: Number(e.target.value) })}
            className="w-40 accent-primary"
          />
        </Row>
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("general.fonts")}</h4>
        <Row label={t("general.uiFont")}>
          <select className={cn(fieldClass, "w-auto")} value={prefs.uiFont} onChange={(e) => setPrefs({ uiFont: e.target.value })}>
            {UI_FONTS.map((f) => (
              <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                {f.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t("general.uiSize")} hint={`${prefs.uiSize} px`}>
          <input
            type="range"
            min={LIMITS.uiSize[0]}
            max={LIMITS.uiSize[1]}
            step={1}
            value={prefs.uiSize}
            onChange={(e) => setPrefs({ uiSize: Number(e.target.value) })}
            className="w-40 accent-primary"
          />
        </Row>
        <Row label={t("general.monoFont")} hint={t("general.monoFontHint")}>
          <select className={cn(fieldClass, "w-auto")} value={prefs.monoFont} onChange={(e) => setPrefs({ monoFont: e.target.value })}>
            {MONO_FONTS.map((f) => (
              <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                {f.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t("general.codeSize")} hint={`${prefs.codeSize} px`}>
          <input
            type="range"
            min={LIMITS.codeSize[0]}
            max={LIMITS.codeSize[1]}
            step={1}
            value={prefs.codeSize}
            onChange={(e) => setPrefs({ codeSize: Number(e.target.value) })}
            className="w-40 accent-primary"
          />
        </Row>
        <Row label={t("general.terminalFont")}>
          <select className={cn(fieldClass, "w-auto")} value={prefs.terminalFont} onChange={(e) => setPrefs({ terminalFont: e.target.value })}>
            {MONO_FONTS.map((f) => (
              <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                {f.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t("general.terminalSize")} hint={`${prefs.terminalSize} px`}>
          <input
            type="range"
            min={LIMITS.terminalSize[0]}
            max={LIMITS.terminalSize[1]}
            step={1}
            value={prefs.terminalSize}
            onChange={(e) => setPrefs({ terminalSize: Number(e.target.value) })}
            className="w-40 accent-primary"
          />
        </Row>
        <div className="mt-3 space-y-2 rounded-lg border bg-card p-3">
          <p style={{ fontFamily: "var(--app-font-sans)" }}>{t("general.previewText")}</p>
          <pre style={{ fontFamily: fontStack(prefs.monoFont), fontSize: prefs.codeSize }} className="text-muted-foreground">
            {"$ df -h /var  →  /dev/sda1  50G  41G  9G  82% /var"}
          </pre>
        </div>
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("general.chat")}</h4>
        <Row label={t("general.chatWidth")}>
          <Segmented
            value={prefs.chatWidth}
            options={[
              { value: "narrow", label: t("general.widthNarrow") },
              { value: "wide", label: t("general.widthWide") },
              { value: "full", label: t("general.widthFull") },
            ]}
            onChange={(chatWidth) => setPrefs({ chatWidth })}
          />
        </Row>
        <Row label={t("general.send")} hint={t("general.sendHint")}>
          <Segmented
            value={prefs.sendKey}
            options={[
              { value: "enter", label: "Enter" },
              { value: "mod-enter", label: "Ctrl+Enter" },
            ]}
            onChange={(sendKey) => setPrefs({ sendKey })}
          />
        </Row>
        <Row label={t("general.expandReasoning")} hint={t("general.expandReasoningHint")}>
          <input type="checkbox" className="size-4 accent-primary" checked={prefs.expandReasoning} onChange={(e) => setPrefs({ expandReasoning: e.target.checked })} />
        </Row>
        <Row label={t("general.expandOutput")} hint={t("general.expandOutputHint")}>
          <input type="checkbox" className="size-4 accent-primary" checked={prefs.expandOutput} onChange={(e) => setPrefs({ expandOutput: e.target.checked })} />
        </Row>
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("general.notifyAndA11y")}</h4>
        <Row
          label={t("general.browserNotifications")}
          hint={notifySupported ? t("general.notifyHint") : t("general.notifyUnsupported")}
        >
          <div className="flex flex-col items-end gap-1">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={prefs.notify}
              disabled={!notifySupported}
              onChange={(e) => void toggleNotify(e.target.checked)}
            />
            {notifyError && <span className="text-xs text-destructive">{notifyError}</span>}
          </div>
        </Row>
        <Row label={t("general.reduceMotion")}>
          <input type="checkbox" className="size-4 accent-primary" checked={prefs.reduceMotion} onChange={(e) => setPrefs({ reduceMotion: e.target.checked })} />
        </Row>
      </section>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => resetPrefs()}>
          {t("general.resetDefaults")}
        </Button>
      </div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded-md px-2.5 text-xs transition-colors",
            o.value === value ? "border border-primary bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2 last:border-0">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
