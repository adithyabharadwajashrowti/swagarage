import { z } from 'zod';

// Mirrors database constraints so users get errors before a round trip.
// The database checks everything again; these are for usability.

export const email = z.string().trim().toLowerCase().max(254).email('Enter a valid email address');

export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(72, 'Use at most 72 characters')
  .regex(/[a-z]/, 'Add a lowercase letter')
  .regex(/[A-Z]/, 'Add an uppercase letter')
  .regex(/[0-9]/, 'Add a number');

const phone = z
  .string()
  .trim()
  .regex(/^[0-9+() -]{6,20}$/, 'Enter a valid phone number')
  .optional()
  .or(z.literal(''));

export const signUpSchema = z
  .object({
    full_name: z.string().trim().min(2, 'Enter your name').max(120),
    company: z.string().trim().min(2, 'Enter your company').max(160),
    email,
    password,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

export const signInSchema = z.object({ email, password: z.string().min(1, 'Enter your password') });

export const newPasswordSchema = z
  .object({ password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

export const profileSchema = z.object({
  full_name: z.string().trim().min(2, 'Enter your name').max(120),
  company: z.string().trim().max(160).optional().or(z.literal('')),
  phone,
});

export const quoteFormSchema = z.object({
  contact_name: z.string().trim().min(2, 'Enter a contact name').max(120),
  company: z.string().trim().min(2, 'Enter your company').max(160),
  email,
  phone,
  occasion: z.string().trim().max(120).optional().or(z.literal('')),
  delivery_city: z.string().trim().max(80).optional().or(z.literal('')),
  needed_by: z
    .string()
    .optional()
    .or(z.literal(''))
    .refine((v) => !v || v >= new Date().toISOString().slice(0, 10), 'Date cannot be in the past'),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export type QuoteForm = z.infer<typeof quoteFormSchema>;

/** Flattens zod issues to { field: message }. */
export function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? '_');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
