#!/bin/bash
# First setup of the portal guest (LXC 116) or the NOC's guest (LXC 118,
# NOC design §N1.5), run once inside it as root:
#   bash lxc-bootstrap.sh NGINX_PROXY_IP [portal|noc]
# The two differ only in Anubis's settings and policy (the site argument,
# default portal) and in what portal.env says (portal.env.example or
# noc.env.example).
# Installs Node.js 22 (NodeSource), sqlite3 and the build tools, creates the
# oc-portal user and directories, the firewall, the backup timer, and Anubis
# in front of the portal (anubis/install-anubis.sh: nginx-proxy -> :3000
# Anubis -> 127.0.0.1:3001 the portal). The deploy script (oc-portal-deploy)
# does the rest. Safe to re-run: every step checks before it changes.
set -euo pipefail
PROXY_IP="${1:?usage: lxc-bootstrap.sh NGINX_PROXY_IP [portal|noc]}"
# No default (final review I1): a missing site is left for
# anubis/install-anubis.sh to read from what is already on this guest
# (its own marker, OC_SITE in /etc/opencell/portal.env, or the files
# already installed), so re-running this script on an upgrade never
# silently takes a NOC guest back to the portal's settings.
SITE="${2:-}"
[[ "$PROXY_IP" =~ ^10\.0\.0\.[0-9]{1,3}$ ]] || { echo "expected an address on internal (10.0.0.x)" >&2; exit 2; }
if [ -n "$SITE" ]; then
  [[ "$SITE" =~ ^(portal|noc)$ ]] || { echo "usage: lxc-bootstrap.sh NGINX_PROXY_IP [portal|noc] (got '$SITE')" >&2; exit 2; }
fi
HERE="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg gpgv iproute2 sqlite3 nftables openssl build-essential python3 unattended-upgrades logrotate

install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs
node --version | grep -q '^v22\.' || { echo "Node.js 22 did not install" >&2; exit 1; }

id oc-portal >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/oc-portal --shell /usr/sbin/nologin oc-portal
install -d -o oc-portal -g oc-portal -m 0700 /var/lib/oc-portal /var/lib/oc-portal/backups
install -d -o root -g root -m 0755 /opt/oc-portal /opt/oc-portal/releases
install -d -o root -g root -m 0700 /etc/opencell
# Root-owned, never writable by the oc-portal service user: unlike
# /var/lib/oc-portal (which that user owns), this tree cannot be
# symlink-swapped by a compromised service process before a later
# deploy/rollback (running as root) writes into it. oc-portal-deploy
# refuses to proceed if it ever finds this a symlink or not root-owned.
install -d -o root -g root -m 0700 /var/lib/oc-portal-deploy /var/lib/oc-portal-deploy/status

sed "s/NGINX_PROXY_IP/$PROXY_IP/" "$HERE/nftables.conf" > /etc/nftables.conf
nft -c -f /etc/nftables.conf
systemctl enable --now nftables
nft -f /etc/nftables.conf

install -m 0755 "$HERE/oc-portal-admin" /usr/local/bin/oc-portal-admin
install -m 0755 "$HERE/oc-portal-backup" /usr/local/sbin/oc-portal-backup
install -m 0644 "$HERE/oc-portal-deploy.logrotate" /etc/logrotate.d/oc-portal-deploy

# Re-running this script (e.g. after editing a unit) should pick up the
# change: restart the affected units instead of leaving the old ones running.
UNITS_CHANGED=0
for f in oc-portal.service oc-portal-backup.service oc-portal-backup.timer; do
  cmp -s "$HERE/$f" "/etc/systemd/system/$f" 2>/dev/null || UNITS_CHANGED=1
done
install -m 0644 "$HERE/oc-portal.service" "$HERE/oc-portal-backup.service" "$HERE/oc-portal-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable oc-portal.service
systemctl enable --now oc-portal-backup.timer
if [ "$UNITS_CHANGED" -eq 1 ]; then
  systemctl try-restart oc-portal.service oc-portal-backup.timer
  echo "unit files changed: restarted the affected units"
fi

# Anubis, the pinned release, verified; its instance anubis@oc-portal on
# :3000. With no site given, install-anubis.sh reads what is already here
# (final review I1) instead of defaulting to portal.
if [ -n "$SITE" ]; then
  bash "$HERE/anubis/install-anubis.sh" "$SITE"
else
  bash "$HERE/anubis/install-anubis.sh"
fi

site_installed="$(cat "${OC_PORTAL_ROOT:-}/etc/anubis/oc-portal.site" 2>/dev/null || echo "${SITE:-portal}")"
echo "bootstrap done: node $(node --version), $(anubis --version 2>/dev/null || echo 'anubis ?')"
example=portal.env.example
if [ "$site_installed" = noc ]; then example=noc.env.example; fi
echo "now write /etc/opencell/portal.env (from $example: PORT=3001, OC_LISTEN=127.0.0.1,"
echo "OC_TRUSTED_PROXY=127.0.0.1) and portal-smtp.env, then deploy"
