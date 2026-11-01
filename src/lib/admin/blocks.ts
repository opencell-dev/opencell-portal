import { asc, like, or } from 'drizzle-orm';
import type { CoreBlock, RouteStatus } from '@/core/types';
import { npas, settings } from '@/db/schema';
import { askReported, askWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { blockOf } from '@/lib/numbers/blocks';
import { type Side, sideOfNpa } from '@/lib/numbers/homing';
import { recentRefreshes } from '@/lib/numbers/nanpa-refresh';
import { coreActor } from '@/lib/site';

// Numbers & blocks (portal spec §4.3). The cores' signed table is the truth. An
// override is a routing-table change signed offline with the root key, so the
// portal only records the home an admin wants, prints the laptop's command,
// and counts it done when core.blocks shows that home. Nothing here routes.

const READ_MS = 3000;
export const WANTED_PREFIX = 'npa_home_wanted:';

export interface NpaRow {
  npa: string;
  region: string;
  stateCode: string | null;
  /** The core number in the block table on hand; null: not in it, or no table yet. */
  home: number | null;
  ruleSide: Side | null;
  geographic: boolean;
  inService: boolean;
  overrideWanted: number | null;
  overrideDone: boolean;
}

export function wantedHomes(ctx: Ctx): Map<string, number> {
  const rows = ctx.db.select().from(settings).where(like(settings.key, `${WANTED_PREFIX}%`)).all();
  return new Map(rows.map((r) => [r.key.slice(WANTED_PREFIX.length), Number(r.value)]));
}

const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, '')}%`;

export function npaTable(ctx: Ctx, q?: string): NpaRow[] {
  const query = q?.trim().slice(0, 32).toUpperCase() ?? '';
  const pattern = likePrefix(query);
  // % and _ are not search characters: what is left of them finds nothing rather than everything.
  if (query !== '' && pattern === '%') return [];
  const wanted = wantedHomes(ctx);
  return ctx.db
    .select()
    .from(npas)
    .where(query === '' ? undefined : or(like(npas.npa, pattern), like(npas.region, pattern)))
    .orderBy(asc(npas.npa))
    .all()
    .map((n) => {
      const home = blockOf(ctx, n.npa)?.homeCore ?? null;
      const want = wanted.get(n.npa) ?? null;
      return {
        npa: n.npa,
        region: n.region,
        stateCode: n.stateCode,
        home,
        ruleSide: sideOfNpa(ctx, n.npa),
        geographic: n.geographic,
        inService: n.inService,
        overrideWanted: want,
        overrideDone: want !== null && home === want,
      };
    });
}

export async function coreBlocksAll(ctx: Ctx, adminId: number): Promise<{ coreId: string; blocks: CoreBlock[] | 'unreachable' | 'unsupported' }[]> {
  const actor = coreActor(ctx.config.site, adminId);
  return Promise.all(
    ctx.cores.map(async (h) => {
      const r = await askReported(h, 'core.blocks', () => h.core.coreBlocks(actor), READ_MS);
      return { coreId: h.id, blocks: r.state === 'ok' ? r.value : r.state };
    }),
  );
}

export const refreshLog = (ctx: Ctx, limit = 20) => recentRefreshes(ctx, limit);

async function firstRouteStatus(ctx: Ctx, adminId: number): Promise<RouteStatus | null> {
  const actor = coreActor(ctx.config.site, adminId);
  for (const h of ctx.cores) {
    const st = await askWithin(h, 'route.status', () => h.core.routeStatus(actor), READ_MS);
    if (st) return st;
  }
  return null;
}

/**
 * The command for the laptop, where the root key lives, that makes the wanted
 * homes true; null when none is outstanding. N and MAX come from route.status;
 * a core that didn't answer leaves them as words to fill in.
 */
export async function overrideCommand(ctx: Ctx, adminId: number, wanted: Map<string, number>): Promise<string | null> {
  const open = [...wanted].filter(([npa, core]) => blockOf(ctx, npa)?.homeCore !== core).sort(([a], [b]) => (a < b ? -1 : 1));
  if (open.length === 0) return null;
  const st = await firstRouteStatus(ctx, adminId);
  const next = st ? String(st.rootVersion + 1) : 'N';
  const prev = st ? String(st.rootVersion) : 'N-1';
  const floor = st ? String(st.maxIdx) : 'MAX';
  const homes = open.map(([npa, core]) => `--home ${npa}=${core}`).join(' ');
  return `oc-route make ~/.config/opencell/secrets/route-root.key route-v${next}.tbl --version ${next} --prev route-v${prev}.tbl --floor ${floor} --npa npa.csv --core 1=oc-core-1 --core 2=oc-core-2 --east 1 --west 2 ${homes}`;
}

