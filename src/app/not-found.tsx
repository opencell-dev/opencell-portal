import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-300">There is nothing at this address.</p>
      <Link href="/" className="mt-6 inline-block text-brand underline">
        OpenCell home
      </Link>
    </main>
  );
}
