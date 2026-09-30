# Anubis in front of the portal

[Anubis](https://github.com/TecharoHQ/anubis) (MIT, pinned at v1.27.0) sits
between nginx-proxy and the portal on the portal guest (LXC 116, 10.0.0.61).
It makes a browser prove itself before it reaches the sign-in pages and the
signed-in pages. The public pages, the static files and the health check go
straight through.

```
client --https--> nginx-proxy (LXC 100, NPM, 10.0.0.100)
                    --http--> 10.0.0.61:3000  Anubis   anubis@oc-portal.service
                                --http--> 127.0.0.1:3001  the portal   oc-portal.service
```

nginx-proxy is unchanged: it still forwards to `10.0.0.61:3000`. Anubis now
answers on that port, and the portal has moved to loopback. nftables is
unchanged too: only nginx-proxy may reach 3000, and loopback (the portal on
3001, Anubis's metrics on 127.0.0.1:9090) is always allowed.

## Files

| here | on the guest | what |
| --- | --- | --- |
| `release.env` | (read by the installer) | pinned version, SHA-256 of the .deb and of the linux-amd64 tarball, signing-key fingerprint |
| `techaro-packages.asc` | (read by the installer) | the release signing key (ed25519 `833F 6416 1167 B501 058C 3947 5637 5DA2 DF02 ABFF`, "Techaro Packages Signatures", published at <https://github.com/Xe.gpg>) |
| `oc-portal.env` | `/etc/anubis/oc-portal.env` 0644 | the instance's settings (nothing secret) |
| `oc-portal.botPolicies.yaml` | `/etc/anubis/oc-portal.botPolicies.yaml` 0644 | the policy |
| `opencell.conf` | `/etc/systemd/system/anubis@oc-portal.service.d/opencell.conf` | drop-in for the package's `anubis@.service`: signing key, hardening, `LimitNOFILE` a container can grant |
| (made on the guest) | `/etc/anubis/oc-portal.key.env` 0600 | `ED25519_PRIVATE_KEY_HEX`: signs the pass cookies, so passes survive restarts |
| `install-anubis.sh` | | installs or updates all of the above (see below) |

`install-anubis.sh` is idempotent. `lxc-bootstrap.sh` runs it on a new
guest, and you can run it on its own. It checks the pinned version with
`dpkg-query`. If that version is not installed, it downloads the .deb and
its `.asc`, checks the SHA-256 against `release.env`, and checks the
signature with `gpgv` against `techaro-packages.asc`. The `VALIDSIG`
fingerprint must be the pinned one. Only then does it run `apt-get install`.
It places the three files, makes the signing key once, then reloads systemd
and enables `anubis@oc-portal`. It restarts the instance only when something
changed. It never starts Anubis while port 3000 is taken, for example by the
portal before its move to 3001. In that case it says so and leaves the unit
enabled but stopped.

The portal side (`deploy/portal.env.example`) has `PORT=3001`,
`OC_LISTEN=127.0.0.1` and `OC_TRUSTED_PROXY=127.0.0.1`.
`oc-portal-deploy` now health-checks the portal itself, on the `PORT` in
`/etc/opencell/portal.env` (default 3000). It never goes through Anubis.
Because it reads the port from the file, deploys work both before and after
the switch.

## The policy (rules in order; the first match decides)

| # | rule | matches | action | why |
| --- | --- | --- | --- | --- |
| 1 | `health-check` | GET/HEAD `/healthz` | ALLOW | Deploy and monitoring checks must never meet a challenge. It comes first so a rule added later cannot shadow it. |
| 2 | `next-static` | GET/HEAD `/_next/static/…` | ALLOW | The content-hashed JS and CSS that every page needs, the public ones included. |
| 3 | `site-files` | GET/HEAD `/favicon.ico`, `/icon…`, `/apple-icon…`, `/manifest.webmanifest`, `/altcha/*.js`, `/.well-known/…` | ALLOW | Browsers and crawlers fetch these on their own, without cookies. `robots.txt` never reaches the policy: Anubis serves it itself (`SERVE_ROBOTS_TXT=true`). |
| 4 | `public-pages` | GET/HEAD `/`, `/coverage`, `/operator-agreement` | ALLOW | Public content, for anyone and any client. |
| 5 | `email-links` | any method on `/auth/email/<token>` | CHALLENGE, `metarefresh`, difficulty 1 | Email links still work with no JavaScript. The page refreshes itself after 2 s. The page only shows the Confirm button; the token is used by the POST. |
| 6 | `portal` | everything else, any method | CHALLENGE, `fast` proof of work, difficulty 4 | This covers `/sign-in`, `/sign-up`, `/welcome`, every signed-in page (`/numbers`, `/calls`, `/directory`, `/nodes`, `/account`, `/admin/…`), their server-action POSTs, `/api/altcha`, POSTs to the public pages, and any unknown path. |

Why it is laid out this way:

- **Unknown paths are challenged.** Only the listed public pages are open.
  Scanners probing `/wp-login.php` and the like get the challenge page, not
  a server-rendered 404, and a page added to the portal later starts out
  protected. Adding it to rule 4 is a deliberate step.
- **POSTs are never public.** Next.js accepts any server action at any page
  path and forwards the call to the page that owns it. If POSTs to `/` were
  allowed, every action (sign-up, sign-in link, passkey sign-in) would be
  reachable without a challenge. So rules 1–4 take GET and HEAD only.
- **The proof-of-work paths are one rule.** An Anubis pass is bound to the
  rule that issued it: the cookie's JWT carries a hash of the rule's name
  and matchers. Under another CHALLENGE rule the pass is cleared and the
  browser is challenged again. Separate rules for sign-in pages, signed-in
  pages and unknown paths would re-challenge people as they moved between
  them, and would turn a server-action POST into a challenge page. So all of
  them are the one catch-all rule.
- **The email-link rule is the one exception, with two consequences.**
  - A person who opens an emailed link does the 2 s wait, presses Confirm,
    and then gets one proof-of-work interstitial on the way to
    `/numbers`, `/welcome` or `/account`. The signed-in pages need
    JavaScript either way.
  - The site header must not prefetch the challenged pages (`/sign-in`,
    `/sign-up`, `/numbers`). On the email-link page, a background prefetch
    of one of them would clear that page's pass, and the Confirm POST would
    get a challenge instead of the portal. `src/components/site-header.tsx`
    sets `prefetch={false}` on those links, and
    `tests/unit/site-header.test.ts` checks it against rule 4's list.
- **Difficulty 4** is Anubis's default: 4 leading hex zeros, about 65 000
  SHA-256 hashes. That is well under a second on a laptop and a second or
  two on a phone.
- **The store is bbolt, on disk** (`/var/lib/anubis/oc-portal/anubis.bdb`,
  in the unit's StateDirectory). The in-memory store is unbounded, and
  Anubis's docs keep it for testing. Pass cookies are checked by signature,
  so they survive restarts because the key is fixed.
- **Logs are at WARN.** At INFO, Anubis logs every challenge with the
  client's address. To watch it for a while, set `level: INFO` in the
  policy and restart.

## Client addresses

nginx-proxy's `proxy.conf` sets `X-Forwarded-For $remote_addr` and
`X-Real-IP $remote_addr`, overwriting what the client sent.

- **Anubis uses X-Real-IP** for its rules and for binding a pass to an
  address (`JWT_RESTRICTION_HEADER=X-Real-IP`). If a request has no
  X-Real-IP, Anubis derives one from X-Forwarded-For. If it ends up with
  none, it answers **500** ("X-Real-Ip header is not set"). A local
  `curl http://127.0.0.1:3000/…` without those headers therefore gets a
  500. Local checks through Anubis must send them, as the runbook does.
- **The portal uses X-Forwarded-For only**, from `OC_TRUSTED_PROXY`, which
  is Anubis at 127.0.0.1. Anubis flattens X-Forwarded-For to one address:
  starting from the right of the list plus its own peer, the first address
  that is not private, loopback, CGNAT or link-local. nginx-proxy's
  10.0.0.100 never counts, so the portal sees the real client, IPv4 or
  IPv6. A client-sent X-Real-IP or `x-oc-client-ip` is never read (the
  portal overwrites `x-oc-client-ip` itself), and forged left-hand
  X-Forwarded-For entries are dropped. `tests/anubis/` checks all of this.
- **Private-address clients are the exception.** If a client reaches
  nginx-proxy from a private address (from the LAN through hairpin NAT, or
  from `internal`), Anubis strips it and sends no X-Forwarded-For. The
  portal then sees 127.0.0.1, so such clients share one rate-limit bucket
  and the audit shows 127.0.0.1. Anubis itself still has their X-Real-IP.
  `XFF_STRIP_PRIVATE=false` is not the fix: then 10.0.0.100 would be the
  address kept.

## Cookies and sessions

- **The Anubis pass cookie** is `oc-anubis-auth-<hash of the cookie
  settings>`, with `Domain=opencell.k4ozi.com; Secure; HttpOnly;
  SameSite=Lax`, not partitioned, valid 7 days, and good only from the
  address that earned it.
  - Lax, like the portal's session cookie, is sent on a top-level
    navigation from a mail client and on the portal's own fetches and form
    posts. That covers the server-action POSTs and the passkey begin/finish
    calls. Nothing embeds the portal cross-site, so `None` is not needed.
  - Anubis's scripts never read the cookie, so it can be HttpOnly.
  - Changing any cookie setting renames the cookie (Anubis ≥ 1.27), so
    everyone passes a fresh challenge once.
- **The pass and the session are independent.** The portal's session cookie
  (`HttpOnly; SameSite=Lax`) is untouched, and passkeys need no change: the
  WebAuthn ceremony happens in the browser, and the RP ID and origin are
  still `opencell.k4ozi.com`.
- **When a signed-in person's address changes** (a phone moving from Wi-Fi
  to mobile data, an IPv6 privacy address rotating), their pass stops
  counting but their session does not. The next page load shows the
  interstitial for a second, then carries on. A server-action POST made
  from a page loaded before the change gets the challenge instead. Next
  shows its generic "unexpected response" error, and a reload fixes it.
  Binding to the address is what stops one solved challenge being shared
  across a bot fleet. Setting `JWT_RESTRICTION_HEADER` empty would trade
  that away for fewer of these moments.
- **The portal's CSP and Origin check are not involved.** Anubis serves its
  challenge pages and `/.within.website/x/…` assets itself, so they never
  reach the portal or its CSP. After a pass, Anubis 302s back to the
  original URL with a GET, which the Origin check ignores. On POSTs, Anubis
  passes `Origin` and `Host` through unchanged, so both the portal's own
  Origin check and Next's action check still see the real ones. The test's
  form POSTs through Anubis pass both checks.

## Tests

- `npm run test:anubis` builds the portal, fetches the pinned
  `anubis-1.27.0-linux-amd64.tar.gz` into `~/.cache/oc-portal/anubis/`, and
  checks it: the SHA-256, plus the signature if `gpgv` is installed. It then
  runs Anubis with this policy and environment in front of the portal on
  loopback. The rules, both challenges, the passes, the email-link flow
  without JavaScript, and the client addresses are all exercised for real.
- `npm run test:deploy` runs `install-anubis.sh` in the fake-root
  simulation: refusals (arch, checksum, signature, swapped key),
  first install, idempotent re-run, restart on change, port 3000 still
  taken. It also checks the deploy health check's port.

## Updating Anubis

1. Download the new `.deb`, the linux-amd64 tarball and both `.asc` files.
2. Check them: `gpg --import techaro-packages.asc` (or refresh the key from
   <https://github.com/Xe.gpg>), then `gpg --verify X.asc X` and
   `sha256sum`. Compare with the digests on the GitHub release page.
3. Update the four lines of `release.env`. Read the release notes for
   changes to cookies, the policy format, or `X-Real-IP`/`X-Forwarded-For`
   handling.
4. Run `npm run test:anubis`. On the guest, run `install-anubis.sh`.

## Runbook: putting Anubis in front of the live portal (LXC 116)

**Before you start:**

- This branch must be merged into the branch the portal deploys from.
- Every later `oc-portal-deploy` must be run from a checkout that has this
  change. An older `oc-portal-deploy` health-checks `127.0.0.1:3000`, which
  is now Anubis. Its answer there is a 500 (no X-Real-IP), so the older
  script would roll back a good release.
- No other deploy may be running (`oc-portal-deploy status`).

The switch is a few seconds of downtime. Every step names how to undo it.

```sh
# From the laptop. G is the guest, through the Proxmox host.
G='ssh -J root@147.135.11.61:222 root@10.0.0.61'
```

**0. Inspect (read-only).**

```sh
# nginx-proxy (LXC 100): the portal's proxy host forwards to 10.0.0.61:3000
# and sets both headers from $remote_addr. NPM keeps its generated config in
# /data/nginx/proxy_host/*.conf and includes conf.d/include/proxy.conf.
grep -rn -e '10.0.0.61' -e 'X-Real-IP' -e 'X-Forwarded-For' /data/nginx/proxy_host/ /etc/nginx/conf.d/include/proxy.conf
#   expect: proxy_set_header X-Forwarded-For $remote_addr;
#           proxy_set_header X-Real-IP $remote_addr;
#   If X-Real-IP is not set from $remote_addr, STOP: add
#   `proxy_set_header X-Real-IP $remote_addr;` to the proxy host's custom
#   config first. Without it, clients could choose their own X-Real-IP, and
#   private-address clients would get a 500.

# The guest:
$G 'systemctl is-active oc-portal; readlink /opt/oc-portal/current
    grep -E "^(PORT|OC_LISTEN|OC_TRUSTED_PROXY)=" /etc/opencell/portal.env
    ss -Hltnp "( sport = :3000 or sport = :3001 or sport = :9090 )"
    curl -fsS http://127.0.0.1:3000/healthz; echo
    dpkg-query -W anubis 2>&1; dpkg --print-architecture; systemd --version | head -1
    nft list ruleset | grep -n 3000; df -h / | tail -1'
#   expect: active; PORT=3000, OC_LISTEN=0.0.0.0, OC_TRUSTED_PROXY=10.0.0.100
#   (nginx-proxy); only node on :3000; nothing on 3001 or 9090; health ok;
#   anubis not installed; amd64.
```

**1. Back up.** Nothing here touches the database, but a backup is cheap.

```sh
$G 'B=/root/pre-anubis-$(date -u +%Y%m%dT%H%M%SZ) && install -d -m 0700 $B &&
    cp -a /etc/opencell/portal.env /etc/nftables.conf /etc/systemd/system/oc-portal.service $B/ &&
    systemctl start oc-portal-backup.service && ls -l $B && ls -lt /var/lib/oc-portal/backups | head -3 && echo $B'
#   Note the $B it prints; the rollback uses it.
```

**2. Copy `deploy/anubis/` to the guest** from the merged commit.

```sh
git -C ~/Documents/opencell/portal archive HEAD deploy/anubis |
  $G 'rm -rf /root/oc-anubis && mkdir -m 0700 /root/oc-anubis && tar -x -C /root/oc-anubis'
```

**3. Install Anubis, not yet started.** Port 3000 is still the portal's.

```sh
$G 'bash /root/oc-anubis/deploy/anubis/install-anubis.sh'
#   expect: installing Anubis 1.27.0 ... and "port 3000 is still taken ...
#   enabled but not started". It refuses (and installs nothing) on a checksum
#   or signature mismatch.
$G 'dpkg-query -W anubis; anubis --version; ls -l /etc/anubis/;
    systemctl cat anubis@oc-portal | head -40; systemctl is-enabled anubis@oc-portal'
#   Undo: systemctl disable anubis@oc-portal; apt-get remove anubis;
#         rm -r /etc/anubis /etc/systemd/system/anubis@oc-portal.service.d
```

**4. Switch** (the downtime is between the two restarts).

```sh
$G 'set -e
    sed -i -e "s/^PORT=.*/PORT=3001/" -e "s/^OC_LISTEN=.*/OC_LISTEN=127.0.0.1/" \
           -e "s/^OC_TRUSTED_PROXY=.*/OC_TRUSTED_PROXY=127.0.0.1/" /etc/opencell/portal.env
    grep -E "^(PORT|OC_LISTEN|OC_TRUSTED_PROXY)=" /etc/opencell/portal.env
    [ "$(grep -cxE "PORT=3001|OC_LISTEN=127.0.0.1|OC_TRUSTED_PROXY=127.0.0.1" /etc/opencell/portal.env)" = 3 ]
    systemctl restart oc-portal
    for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3001/healthz && break; sleep 1; done; echo
    systemctl start anubis@oc-portal
    sleep 1; systemctl is-active anubis@oc-portal
    ss -Hltnp "( sport = :3000 or sport = :3001 or sport = :9090 )"'
#   expect: the portal healthy on 3001; anubis active; anubis on *:3000 and
#   127.0.0.1:9090, node on 127.0.0.1:3001. The portal logs
#   "trusted proxy is 127.0.0.1".
```

**5. Verify.**

```sh
# On the guest, through Anubis as nginx-proxy would call it:
$G 'curl -fsS -H "X-Forwarded-For: 192.0.2.1" -H "X-Real-IP: 192.0.2.1" http://127.0.0.1:3000/healthz; echo
    curl -fsS http://127.0.0.1:9090/metrics | grep -c ^anubis_
    journalctl -u anubis@oc-portal -u oc-portal --since -5min --no-pager | tail -30'
# From outside, through nginx-proxy:
curl -fsS https://opencell.k4ozi.com/healthz; echo                          # {"ok":true,"version":...}
curl -fsS https://opencell.k4ozi.com/ | grep -c anubis_challenge            # 0: public
curl -fsS https://opencell.k4ozi.com/sign-in | grep -c anubis_challenge     # 1: proof of work
curl -fsS https://opencell.k4ozi.com/auth/email/x | grep -o 'http-equiv="refresh"\|"algorithm":"metarefresh"' | head -1
curl -fsS https://opencell.k4ozi.com/robots.txt | head -3
oc-portal-deploy status                                     # health via 3001, anubis: active
```

Then, in a browser:

1. Open `/sign-in`: a short "making sure you're not a bot", then the page.
2. Sign in with a passkey.
3. Click through the tabs.
4. Sign out.
5. Ask for a sign-in link, open it from the mail: the 2 s page, then
   Confirm, one short check, then `/numbers`.

After that, confirm that the portal recorded your real address:

```sh
$G "sqlite3 /var/lib/oc-portal/portal.db \"select action, ip, datetime(at/1000,'unixepoch') from audit order by id desc limit 5\""
#   expect your public address, not 127.0.0.1 or 10.0.0.100.
```

**Rollback** (at any point after step 4). Free 3000 first, then put the
portal back on it:

```sh
$G 'set -e; B=<the directory from step 1>
    systemctl disable --now anubis@oc-portal
    cp -a $B/portal.env /etc/opencell/portal.env
    systemctl restart oc-portal
    for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/healthz && break; sleep 1; done; echo'
```

nginx-proxy needs no change either way. The package, `/etc/anubis` and the
key can stay (undo step 3 removes them). The new `oc-portal-deploy` reads
`PORT=3000` again from the restored `portal.env`.

**Later changes to the policy or environment:** edit them here, merge, then
repeat steps 2 and 3. The installer restarts Anubis only if a file changed.
The restart takes about a second, and passes survive it.
