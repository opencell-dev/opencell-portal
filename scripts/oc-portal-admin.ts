// The portal's admin CLI. On the guest:
//   sudo -u oc-portal env $(cat /etc/opencell/portal.env) npx tsx scripts/oc-portal-admin.ts promote you@example.org
// (the deploy installs /usr/local/bin/oc-portal-admin, which does exactly that).
import { runAdmin } from '@/lib/admin-cli';
import { appCtx } from '@/lib/ctx';

const { code, out } = runAdmin(appCtx(), process.argv.slice(2));
(code === 0 ? console.log : console.error)(out);
process.exit(code);
