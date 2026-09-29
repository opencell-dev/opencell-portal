'use client';

import Link from 'next/link';
import './globals.css';

// Replaces the root layout when it throws, so it renders its own <html>/<body>
// (Next.js convention) and must not use inline styles (CSP's style-src-attr).
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <main className="mx-auto max-w-3xl px-4 py-16 text-center">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">Sorry, an unexpected error occurred.</p>
          <div className="mt-6 flex justify-center gap-4">
            <button type="button" onClick={() => reset()} className="text-brand underline">
              Try again
            </button>
            <Link href="/" className="text-brand underline">
              OpenCell home
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
