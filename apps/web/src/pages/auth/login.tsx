import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth, useIdentity } from '../../auth/context';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/field';
import { ApiError } from '../../lib/http';

export default function LoginPage() {
  const { identity, runtime } = useAuth();
  const auth = useIdentity();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() =>
    runtime.session.isRemembered(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError('');
    setPending(true);
    try {
      const state = await identity.login({
        username,
        password,
        rememberMe: remember,
      });
      setPassword('');
      if (state.status !== 'authenticated')
        setError('登录状态尚未确认，请重试验证。');
    } catch (failure) {
      setPassword('');
      setError(
        failure instanceof ApiError
          ? failure.kind === 'AUTH'
            ? '用户名或密码错误'
            : failure.message
          : '登录失败，请稍后再试',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <section className="relative flex flex-col justify-between overflow-hidden bg-ink px-6 py-8 text-white sm:px-12 lg:min-h-screen lg:p-14">
        <div className="flex items-center gap-3 text-sm font-semibold tracking-wide">
          <span className="grid size-9 place-content-center rounded-control bg-signal text-ink">
            A
          </span>
          AMAZON ASIN MONITOR
        </div>
        <div className="max-w-xl py-6 sm:py-12 lg:py-24">
          <p className="mb-5 font-mono text-xs tracking-[.2em] text-signal">
            STAY IN SYNC
          </p>
          <h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
            每一次变化，
            <br />
            <span className="text-signal">尽在掌握。</span>
          </h1>
          <p className="mt-6 hidden max-w-sm text-sm leading-7 text-white/60 sm:block">
            在同一个工作台，关注 ASIN 状态、监控任务与关键变化。
          </p>
        </div>
        <p className="hidden items-center gap-2 text-xs text-white/50 lg:flex">
          <ShieldCheck className="size-4" aria-hidden="true" />
          安全连接你的工作空间
        </p>
      </section>
      <section className="flex items-center justify-center px-6 py-8 sm:px-12 sm:py-12">
        <div className="w-full max-w-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            WELCOME BACK
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight">登录工作台</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            输入你的账号，继续今天的监控工作。
          </p>
          {auth.status === 'error' && (
            <div
              role="alert"
              className="mt-5 rounded-control bg-status-warning-soft p-4 text-sm"
            >
              暂时无法验证已有登录。
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => {
                  void identity.refresh();
                }}
              >
                重新验证
              </button>
            </div>
          )}
          <form
            className="mt-8 space-y-5"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <Field label="用户名" required>
              {(control) => (
                <Input
                  {...control}
                  name="username"
                  autoComplete="username"
                  value={username}
                  maxLength={50}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={pending}
                />
              )}
            </Field>
            <Field label="密码" required>
              {(control) => (
                <Input
                  {...control}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  maxLength={1024}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={pending}
                />
              )}
            </Field>
            <label className="flex min-h-10 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                disabled={pending}
                className="size-4 accent-ink"
              />
              记住登录状态
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" pending={pending} className="w-full">
              登录
              <ArrowRight aria-hidden="true" />
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}
