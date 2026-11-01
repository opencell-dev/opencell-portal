import type { Metadata } from 'next';
import { CoverageMap } from '@/components/coverage-map';
import { publicNodes } from '@/lib/coverage';
import { appCtx } from '@/lib/ctx';

export const metadata: Metadata = { title: 'Coverage' };

// Read at each request: the nodes change, and the numbers are rounded before they leave lib/coverage.ts.
export const dynamic = 'force-dynamic';

export default function Coverage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Coverage</h1>
      <p>Approved base stations, each rounded to about a kilometre, and whether they are online. This map never shows where subscribers are.</p>
      <CoverageMap nodes={publicNodes(appCtx())} />
    </div>
  );
}
