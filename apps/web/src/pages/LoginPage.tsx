import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, ApiError } from "../api";

const inputClass = "w-full rounded border border-neutral-300 px-3 py-2 text-sm";
const buttonClass = "rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50";

export default function LoginPage() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState<boolean | null>(null);
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authStatus().then((s) => {
      if (s.authed) navigate("/", { replace: true });
      else setSetup(!s.setup ? true : false);
    }).catch(() => setError("Сервер недоступен"));
  }, [navigate]);

  const fail = (err: unknown) => {
    // The server does not tell a wrong password from a wrong code, so the message does not either.
    if (err instanceof ApiError && err.status === 429) setError("Слишком много попыток, подождите 15 минут");
    else if (err instanceof ApiError && err.status === 401) setError("Неверные данные");
    else setError(err instanceof ApiError ? err.code : "Ошибка");
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

  if (setup === null) return <div className="p-6 text-sm">Загрузка…</div>;

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 p-6">
      <h1 className="text-xl font-semibold">sysadm</h1>

      {setup ? (
        <form onSubmit={onSetup} className="space-y-3">
          <p className="text-sm text-neutral-600">Первый запуск: задайте пароль администратора (от 12 символов).</p>
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className={buttonClass} disabled={busy || password.length < 12}>
            Создать
          </button>
        </form>
      ) : (
        <form onSubmit={onLogin} className="space-y-3">
          {otpauth && (
            <div className="space-y-1 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
              <p>Добавьте ключ в приложение-аутентификатор (TOTP). Показывается один раз:</p>
              <code className="block break-all font-mono text-xs">{otpauth}</code>
            </div>
          )}
          <input
            className={inputClass}
            type="password"
            autoComplete="current-password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input
            className={inputClass}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="Код TOTP"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className={buttonClass} disabled={busy || password.length === 0 || code.length !== 6}>
            Войти
          </button>
        </form>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
