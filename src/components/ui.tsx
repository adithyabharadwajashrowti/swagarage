import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { imageUrl } from '../lib/supabase';

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

export function Field({ label, error, hint, children }: FieldProps) {
  const id = useId();
  const descId = error || hint ? `${id}-desc` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, descId)}
      {error ? (
        <span className="err" id={descId}>{error}</span>
      ) : hint ? (
        <span className="hint" id={descId}>{hint}</span>
      ) : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string };
export function TextField({ label, error, hint, ...rest }: InputProps) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(id, d) => <input id={id} className="input" aria-invalid={!!error} aria-describedby={d} {...rest} />}
    </Field>
  );
}

type AreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string };
export function TextArea({ label, error, hint, ...rest }: AreaProps) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(id, d) => <textarea id={id} className="input" aria-invalid={!!error} aria-describedby={d} {...rest} />}
    </Field>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; options: { value: string; label: string }[] };
export function SelectField({ label, error, options, ...rest }: SelectProps) {
  return (
    <Field label={label} error={error}>
      {(id, d) => (
        <select id={id} className="input" aria-invalid={!!error} aria-describedby={d} {...rest}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function ProductImage({ path, alt, className }: { path: string | null; alt: string; className?: string }) {
  const url = imageUrl(path);
  if (!url) return <div className={`noimg ${className ?? ''}`}>No image</div>;
  return <img src={url} alt={alt} loading="lazy" className={className} />;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="spinner" role="status">{label}</div>;
}

export function StatusBadge({ value, label }: { value: string; label?: string }) {
  return <span className={`status st-${value}`}>{label ?? value.replace('_', ' ')}</span>;
}
