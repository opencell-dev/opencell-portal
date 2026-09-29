import { z } from 'zod';

export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Please enter your name.')
  .max(80, 'Please use at most 80 characters for your name.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'That email address is too long.')
  .pipe(z.email('Please enter a valid email address.'));

/** The first message of a failed parse, for showing next to the form. */
export function firstError(e: z.ZodError): string {
  return e.issues[0]?.message ?? 'Please check the form.';
}
