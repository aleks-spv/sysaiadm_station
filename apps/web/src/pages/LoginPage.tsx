import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, ApiError } from "../api";
import { cn, fieldClass } from "@/lib/utils";
import { lang, LANGS, setLang } from "@/i18n";
import { t } from "@/i18n/app";

const inputClass = cn(fieldClass, "h-10 px-3");
const buttonClass = "h-10 w-full rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50";

export default function LoginPage() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState<boolean | null>(null);
  // Defaults to false: until the server says otherwise, the form looks like prod.
  const [dev, setDev] = useState(false);
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authStatus().then((s) => {
      if (s.authed) navigate("/", { replace: true });
      else {
        setDev(s.dev);
        setSetup(!s.setup ? true : false);
      }
    }).catch(() => setError(t("login.unreachable")));
  }, [navigate]);

  const fail = (err: unknown) => {
    // The server does not tell a wrong password from a wrong code, so the message does not either.
    if (err instanceof ApiError && err.status === 429) setError(t("login.tooMany"));
    else if (err instanceof ApiError && err.status === 401) setError(t("login.invalid"));
    else setError(err instanceof ApiError ? err.code : t("common.error"));
  };

  const onSetup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.setup(password);
      setOtpauth(res.otpauth);
      setSetup(false);
      setPassword("");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password, code);
      navigate("/", { replace: true });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (setup === null) return <div className="p-6 text-sm">{t("common.loading")}</div>;

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-sm space-y-5 rounded-2xl border bg-card p-8 shadow-sm">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/logo.svg" alt="" className="size-16" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">SysAiAdm Station</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("brand.tagline")}</p>
          </div>
        </div>

        {setup ? (
          <form onSubmit={onSetup} className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("login.setupHint")}</p>
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              placeholder={t("login.password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className={buttonClass} disabled={busy || password.length < 12}>
              {t("login.create")}
            </button>
          </form>
        ) : (
          <form onSubmit={onLogin} className="space-y-3">
            {dev && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                {t("login.devMode")}
              </div>
            )}
            {otpauth && (
              <div className="space-y-1 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                <p>{t("login.totpSecret")}</p>
                <code className="block break-all font-mono text-xs">{otpauth}</code>
              </div>
            )}
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
              placeholder={t("login.password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {!dev && (
              <input
                className={inputClass}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder={t("login.totp")}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
            <button className={buttonClass} disabled={busy || password.length === 0 || (!dev && code.length !== 6)}>
              {t("login.submit")}
            </button>
          </form>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-center gap-3 text-xs">
          {LANGS.map((l) => (
            <button key={l.id} type="button" onClick={() => setLang(l.id)} className={cn(l.id === lang ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
