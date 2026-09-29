import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Coverage' };

export default function Coverage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Coverage</h1>
      <p>
        The coverage map shows approved base stations, each rounded to about a kilometre, and whether they are online.
        It never shows where subscribers are.
      </p>
      <p className="rounded border border-dashed border-slate-300 p-6 text-center text-slate-500 dark:border-slate-700">
        No base stations are listed yet. The map appears here as the first ones are approved.
      </p>
    </div>
  );
}
