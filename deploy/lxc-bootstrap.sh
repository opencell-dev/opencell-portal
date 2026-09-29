#!/bin/bash
# First setup of the portal guest (LXC 116), run once inside it as root:
#   bash lxc-bootstrap.sh NGINX_PROXY_IP
# Installs Node.js 22 (NodeSource), sqlite3 and the build tools, creates the
# oc-portal user and directories, the firewall, and the backup timer. The
# deploy script (oc-portal-deploy) does the rest.
set -euo pipefail
PROXY_IP="${1:?usage: lxc-bootstrap.sh NGINX_PROXY_IP}"
[[ "$PROXY_IP" =~ ^10\.0\.0\.[0-9]{1,3}$ ]] || { echo "expected an address on internal (10.0.0.x)" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg sqlite3 nftables openssl build-essential python3 unattended-upgrades

install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs
node --version | grep -q '^v22\.' || { echo "Node.js 22 did not install" >&2; exit 1; }

id oc-portal >/dev/null 2>&1 || useradd --system --home-dir /var/lib/oc-portal --shell /usr/sbin/nologin oc-portal
install -d -o oc-portal -g oc-portal -m 0700 /var/lib/oc-portal /var/lib/oc-portal/backups
install -d -o root -g root -m 0755 /opt/oc-portal /opt/oc-portal/releases
install -d -o root -g root -m 0700 /etc/opencell

sed "s/NGINX_PROXY_IP/$PROXY_IP/" "$HERE/nftables.conf" > /etc/nftables.conf
nft -c -f /etc/nftables.conf
systemctl enable --now nftables
nft -f /etc/nftables.conf

install -m 0755 "$HERE/oc-portal-admin" /usr/local/bin/oc-portal-admin
install -m 0755 "$HERE/oc-portal-backup" /usr/local/sbin/oc-portal-backup
install -m 0644 "$HERE/oc-portal.service" "$HERE/oc-portal-backup.service" "$HERE/oc-portal-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable oc-portal.service
systemctl enable --now oc-portal-backup.timer
echo "bootstrap done: node $(node --version); now write /etc/opencell/portal.env and portal-smtp.env, then deploy"
