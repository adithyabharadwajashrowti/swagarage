import { useEffect, useState, type FormEvent } from 'react';
import { Captcha, CAPTCHA_SITE_KEY } from '../components/Captcha';
import { TextField } from '../components/ui';
import { useAuth } from '../lib/auth';
import { absoluteUrl, Link, navigate, safeNext, useLocation } from '../lib/router';
import { friendlyError, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { email as emailSchema, fieldErrors, newPasswordSchema, signInSchema, signUpSchema } from '../lib/validation';

function useNext() {
  const { search } = useLocation();
  return safeNext(search.get('next'));
}

export function LoginPage() {
  const next = useNext();
  const { session } = useAuth();
  const { search } = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  useEffect(() => {
    if (session) navigate(next, { replace: true });
  }, [session, next]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = signInSchema.safeParse(form);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    if (CAPTCHA_SITE_KEY && !captcha) return setError('Please complete the check below.');
    const { error: err } = await supabase.auth.signInWithPassword({ ...parsed.data, options: { captchaToken: captcha ?? undefined } });
    setBusy(false);
    setCaptchaReset((n) => n + 1);
    // Same message whether the email exists or not (no account enumeration).
    if (err) setError(friendlyError(err));
  }

  return (
    <div className="auth">
      <div className="panel">
        <h1>Sign in</h1>
        <p className="sub">Track your quotes and request new ones.</p>
        {search.get('confirmed') && <p className="alert ok" style={{ marginBottom: 14 }}>Email confirmed. You can sign in now.</p>}
        <form className="form" onSubmit={submit} noValidate>
          <TextField label="Email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={errors.email} />
          <TextField label="Password" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} error={errors.password} />
          <Captcha onToken={setCaptcha} resetKey={captchaReset} />
          {error && <p className="alert err" role="alert">{error}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="alt"><Link to="/forgot-password">Forgot password?</Link></p>
        <p className="alt">New here? <Link to={`/signup?next=${encodeURIComponent(next)}`}>Create an account</Link></p>
      </div>
    </div>
  );
}

export function SignupPage() {
  const next = useNext();
  const [form, setForm] = useState({ full_name: '', company: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = signUpSchema.safeParse(form);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    if (CAPTCHA_SITE_KEY && !captcha) return setError('Please complete the check below.');
    setBusy(true);
    const { error: err } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        // Only name and company go in metadata; roles are never taken from sign-up.
        data: { full_name: parsed.data.full_name, company: parsed.data.company },
        emailRedirectTo: absoluteUrl(`/login?confirmed=1&next=${encodeURIComponent(next)}`),
        captchaToken: captcha ?? undefined,
      },
    });
    setBusy(false);
    setCaptchaReset((n) => n + 1);
    if (err) return setError(friendlyError(err));
    setDone(true);
  }

  if (done)
    return (
      <div className="auth">
        <div className="panel">
          <h1>Check your email</h1>
          <p className="sub">We sent a confirmation link to <b>{form.email}</b>. Open it to activate your account, then sign in.</p>
          <Link to="/login" className="btn sec block">Go to sign in</Link>
        </div>
      </div>
    );

  return (
    <div className="auth">
      <div className="panel">
        <h1>Create an account</h1>
        <p className="sub">For companies ordering gifts and merchandise.</p>
        <form className="form" onSubmit={submit} noValidate>
          <TextField label="Your name" autoComplete="name" value={form.full_name} onChange={set('full_name')} error={errors.full_name} />
          <TextField label="Company" autoComplete="organization" value={form.company} onChange={set('company')} error={errors.company} />
          <TextField label="Work email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={errors.email} />
          <TextField label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} hint="At least 10 characters with upper and lowercase letters and a number." />
          <TextField label="Confirm password" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} error={errors.confirm} />
          <Captcha onToken={setCaptcha} resetKey={captchaReset} />
          {error && <p className="alert err" role="alert">{error}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
        </form>
        <p className="alt">Already have an account? <Link to={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link></p>
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (CAPTCHA_SITE_KEY && !captcha) return setErr('Please complete the check below.');
    if (!parsed.success) return setErr('Enter a valid email address');
    setErr(undefined);
    setBusy(true);
    await supabase.auth.resetPasswordForEmail(parsed.data, { redirectTo: absoluteUrl('/reset-password'), captchaToken: captcha ?? undefined });
    setBusy(false);
    // Always show the same message, whether or not the account exists.
    setSent(true);
  }

  return (
    <div className="auth">
      <div className="panel">
        <h1>Reset your password</h1>
        {sent ? (
          <p className="sub">If an account exists for <b>{email}</b>, a reset link is on its way. The link expires in one hour.</p>
        ) : (
          <>
            <p className="sub">We'll email you a link to set a new password.</p>
            <form className="form" onSubmit={submit} noValidate>
              <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={err} />
              <Captcha onToken={setCaptcha} />
              <button className="btn pri block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
            </form>
          </>
        )}
        <p className="alt"><Link to="/login">Back to sign in</Link></p>
      </div>
    </div>
  );
}

export function ResetPasswordPage() {
  const { session, loading } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = newPasswordSchema.safeParse(form);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password: parsed.data.password });
    setBusy(false);
    if (err) return setError(friendlyError(err));
    toast('Password updated', 'success');
    navigate('/account', { replace: true });
  }

  return (
    <div className="auth">
      <div className="panel">
        <h1>Set a new password</h1>
        {!loading && !session ? (
          <>
            <p className="sub">This reset link is invalid or has expired.</p>
            <Link to="/forgot-password" className="btn sec block">Request a new link</Link>
          </>
        ) : (
          <form className="form" onSubmit={submit} noValidate>
            <TextField label="New password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} error={errors.password} hint="At least 10 characters with upper and lowercase letters and a number." />
            <TextField label="Confirm password" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} error={errors.confirm} />
            {error && <p className="alert err" role="alert">{error}</p>}
            <button className="btn pri block" disabled={busy || loading}>{busy ? 'Saving…' : 'Save password'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
