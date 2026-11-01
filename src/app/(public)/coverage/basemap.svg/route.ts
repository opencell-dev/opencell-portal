import { BASEMAP } from '@/content/basemap';
import { MAP_VIEWBOX } from '@/lib/map-projection';

export const dynamic = 'force-static';

/** The basemap alone, for the request form's pin preview: no node is on it. */
export function GET() {
  const paths = BASEMAP.regions.map((r) => `<path d="${r.d}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MAP_VIEWBOX.map((n) => n.toFixed(1)).join(' ')}"><g fill="#e2e8f0" stroke="#94a3b8" stroke-width="0.3">${paths}</g></svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
}
