/** On every NOC page while the portal runs on the fake core (NOC design §10): what is shown is not the network. */
export function DemoBanner({ fake }: { fake: boolean }) {
  if (!fake) return null;
  return (
    <p role="note" className="rounded border border-amber-500 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      Fake core: demo data, not the OpenCell network (OC_CORE=fake).
    </p>
  );
}
