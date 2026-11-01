import type { FormState } from '@/app/actions/auth';

/** An action's answer next to its form: a status, or an alert. */
export function FormMessage({ state }: { state: FormState }) {
  if (!state) return null;
  return (
    <p role={state.ok ? 'status' : 'alert'} className={`text-sm ${state.ok ? '' : 'text-red-600'}`}>
      {state.message}
    </p>
  );
}
