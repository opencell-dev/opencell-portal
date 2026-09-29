'use client';

import { useFormStatus } from 'react-dom';

/** The email-link confirm button: disabled once pressed, so a double click sends one request. */
export function ConfirmButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark disabled:opacity-50"
    >
      {label}
    </button>
  );
}
