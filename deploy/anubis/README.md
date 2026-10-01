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
It places the three files, makes the signing key once, then reloads systemd.
It restarts a running instance only when something changed. While port 3000
is taken, for example by the portal before its move to 3001, it neither
enables nor starts `anubis@oc-portal` (a reboot would race the two for the
port); it says so, and the switch does `systemctl enable --now`. With the
port free it enables and starts it.

The portal side (`deploy/portal.env.example`) has `PORT=3001`,
`OC_LISTEN=127.0.0.1` and `OC_TRUSTED_PROXY=127.0.0.1`.
`oc-portal-deploy` now health-checks the portal itself, on the `PORT` in
`/etc/opencell/portal.env` (default 3000). It never goes through Anubis.
Because it reads the port from the file, deploys work both before and after
the switch.

## The NOC's site (NOC design §N1.5)

The NOC runs the same build on its own guest (LXC 118 `oc-noc`, 10.0.0.63,
`OC_SITE=noc`, `deploy/noc.env.example`) behind its own Anubis, set up by
`lxc-bootstrap.sh NGINX_PROXY_IP noc`, which runs `install-anubis.sh noc`.
That installs `oc-noc.env` and `oc-noc.botPolicies.yaml` under the usual
instance name (`/etc/anubis/oc-portal.env`, `anubis@oc-portal`), so the unit,
its drop-in and `oc-portal-deploy status` are the same on both guests.

- `oc-noc.env` is `oc-portal.env` with `COOKIE_DOMAIN` and
  `REDIRECT_DOMAINS` set to `noc.opencell.k4ozi.com`. The portal's pass
  cookie (`Domain=opencell.k4ozi.com`) also reaches the NOC's host, but
  Anubis names its cookie after its settings, so the two never mix.
- `oc-noc.botPolicies.yaml` is the portal's policy without rule 4 (no public
  pages: the NOC's front page is the NOC) and without the ALTCHA worker (no
  sign-up). `tests/anubis/anubis-noc.test.ts` checks both against the
  portal's and runs them in front of an `OC_SITE=noc` build.
- nginx-proxy: the NOC's proxy host gets `npm-proxy-host.advanced.conf` as its
  advanced config (NPM's default `location /` with X-Forwarded-For
  `$remote_addr` only, the text applied to the portal's host 3 on
  2026-09-30; see "Client addresses" for why the `more_clear_input_headers`
  one-liner does not apply to the live nginx), and a custom location
  `/auth/email/` with the access log off, as host 3 has.



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
- **No dot segments through an open door.** Anubis matches the path as
  sent (percent-decoded, never cleaned). nginx-proxy passes it on raw and
  Next resolves `.` and `..`, so `/_next/static/../../sign-in` would be a
  static file to Anubis and the sign-in page to the portal. Every ALLOW rule
  therefore also requires `!path.matches("/\\.\\.?(/|$)")`: a path with a
  `.` or `..` segment (`%2e%2e` and `.%2E` included, being decoded) falls
  through to the proof of work. test:anubis sends these paths as-is.
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
- **The email-link rule is the one exception, with three consequences.**
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
  - **The portal accepts only the Confirm action on that page.** Next.js
    serves every action of a module a page imports on that page, and the
    email-link page imports `src/app/actions/auth.ts`. Without a guard,
    waiting out the light challenge would open sign-up, sign-in links and
    passkey sign-in to any client. So the portal's proxy
    (`src/lib/email-link-guard.ts`, called from `src/proxy.ts`) 403s every
    unsafe request to `/auth/email/*` that is not plainly the Confirm
    action:
    - as a fetch action, the `Next-Action` id must be the confirm action's;
    - as a no-JavaScript form, every action key React reads
      (`$ACTION_ID_<id>`, or `$ACTION_REF_<n>` with a literal id in
      `$ACTION_<n>:0`) must name it. The guard parses only a form with a
      `Content-Length` of at most 64 KiB (Next's own action limit; a
      Confirm form is a few hundred bytes), since Next hands the proxy up
      to 10 MB of body.

    Next.js has no API for an action's id. The id comes from the manifest
    the build writes (`.next/server/server-reference-manifest.json`), found
    there by file and export name (`src/app/actions/auth.ts`,
    `confirmEmailLinkAction`), and reread when the file changes. If the
    manifest is missing or lacks the action, every POST there is refused
    and the portal logs why. So renaming or moving that action needs the
    guard updated; `npm run test:anubis` and the e2e tests would catch it.
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

nginx-proxy (NPM) always sets `X-Real-IP $remote_addr`. For
X-Forwarded-For, NPM's stock `conf.d/include/proxy.conf`, which the proxy
host's default `location /` includes, sets `$proxy_add_x_forwarded_for`:
the client's own X-Forwarded-For with `$remote_addr` appended. (A custom
location, such as the portal host's `/auth/email/`, sets `$remote_addr`
from NPM's `_location.conf`.) The runbook makes the default location send
just `$remote_addr` too, by clearing the client's header at the server
level of the proxy host (id 3) with one advanced-config line:

```nginx
more_clear_input_headers X-Forwarded-For;
```

This comes from the headers-more module, which OpenResty (NPM's nginx)
bundles. It runs before the proxy module builds the header and applies to
every location, so `$proxy_add_x_forwarded_for` becomes exactly
`$remote_addr`, with no second header. The obvious
`proxy_set_header X-Forwarded-For $remote_addr;` does not work there. At
server level, nginx ignores it in any location that sets its own
`proxy_set_header` lines, and both of NPM's locations do. Inside a location
it would add a second X-Forwarded-For. This was checked with nginx 1.26
and headers-more 0.38 against a replica of NPM's generated
`proxy_host/3.conf`: without the line a forged header arrives as
`198.51.100.99, …, <client>`; with it, as `<client>` only, on both
locations.

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
  address kept. Without the `more_clear_input_headers` line, a
  private-address client could also put a public address of its choosing in
  its own X-Forwarded-For. Anubis would keep it, because everything to its
  right is stripped, and the portal would record that address.

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
  So is the email-link guard: another action posted to `/auth/email/x`
  after the metarefresh wait, as a fetch action or as the sign-in page's
  no-JavaScript form, gets a 403 and never runs, and so does a form over
  64 KiB. Dot-segment paths out of the open prefixes
  (`/_next/static/../../sign-in`, `%2e%2e`, `.%2E`, `/.well-known/../…`)
  are sent as-is and must meet the proof of work.
- `tests/unit/email-link-guard.test.ts` and `tests/unit/proxy.test.ts`
  cover the guard's matching rules and its failing closed.
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

- The release is the tag `v0.2.1` (on `anubis`). It carries the email-link
  guard, the policy and the new `oc-portal-deploy`.
- From step 2 on, every `oc-portal-deploy` must run from a checkout of
  v0.2.1 or later. An older one health-checks `127.0.0.1:3000`, which after
  step 6 is Anubis. Anubis answers it with a 500 (no X-Real-IP), so the old
  script would roll back a good release.
- Never run v0.2.0 behind Anubis. It has no email-link guard, so waiting out
  the light challenge on `/auth/email/*` would open every sign-in and
  sign-up action.
- No other deploy may be running (`oc-portal-deploy status`).
- You need a shell on the guest and on nginx-proxy, and an NPM API token.

The switch in step 6 is a few seconds of downtime. Every step says how to
undo it.

```sh
# From the laptop. G and N use the operator's own SSH config (not in this
# repo), which defines `oc-portal` and the Proxmox host's `ovh-pve` alias;
# nginx-proxy has no alias of its own, so N jumps through ovh-pve directly.
TAG=v0.2.1
G='ssh -F "${OC_SSH_CONFIG:-$HOME/.ssh/cm/oc-portal.conf}" oc-portal'  # the portal guest (LXC 116)
N='ssh -J ovh-pve root@10.0.0.100'                   # nginx-proxy (LXC 100), or `pct exec 100 --` on the host
NPM_API=http://10.0.0.100:81/api                     # NPM's admin API, however you reach it
NPM_TOKEN=...                                        # your NPM API token
H="Authorization: Bearer $NPM_TOKEN"
```

**0. Inspect (read-only).**

```sh
# nginx-proxy: the portal's proxy host (id 3) as NPM generated it, and its tools.
$N 'grep -n -e "set \$server" -e "set \$port" -e "location" -e "include conf.d/include/proxy.conf" \
            -e X-Forwarded-For -e X-Real-IP -e more_ /data/nginx/proxy_host/3.conf
    grep -n -e X-Forwarded-For -e X-Real-IP /etc/nginx/conf.d/include/proxy.conf
    (openresty -V 2>&1; nginx -V 2>&1) | grep -o "headers-more-nginx-module[^ /]*" | sort -u'
#   expect: $server "10.0.0.61", $port 3000; `location /auth/email/` setting
#   X-Forwarded-For and X-Real-IP to $remote_addr; `location /` including
#   proxy.conf; proxy.conf with X-Forwarded-For $proxy_add_x_forwarded_for
#   and X-Real-IP $remote_addr; headers-more-nginx-module present.
#   STOP if X-Real-IP is not $remote_addr in both locations.
#   STOP if headers-more is missing. Step 3 needs it. The fallback is a full
#   `location /` in the advanced config (NPM then drops its own), copying
#   the current one from 3.conf with X-Forwarded-For $remote_addr instead of
#   the proxy.conf include. Review that by hand before applying it.
curl -fsS -H "$H" "$NPM_API/nginx/proxy-hosts/3" |
  jq '{id, domain_names, forward_host, forward_port, enabled, advanced_config,
       locations: [.locations[]? | {path, forward_host, forward_port, advanced_config}], meta}'

# The guest: service, settings, listeners, health, and what the installer needs.
$G 'systemctl is-active oc-portal; readlink /opt/oc-portal/current
    grep -E "^(PORT|OC_LISTEN|OC_TRUSTED_PROXY)=" /etc/opencell/portal.env
    ss -Hltnp "( sport = :3000 or sport = :3001 or sport = :9090 )"
    curl -fsS http://127.0.0.1:3000/healthz; echo
    dpkg-query -W anubis 2>&1; dpkg --print-architecture; systemd --version | head -1
    for t in gpg gpgv ss openssl curl sha256sum apt-get; do command -v $t >/dev/null || echo "MISSING $t"; done
    curl -fsSL --max-time 30 -o /dev/null -w "github: %{http_code}\n" \
      https://github.com/TecharoHQ/anubis/releases/download/v1.27.0/anubis_1.27.0_amd64.deb.asc
    nft list ruleset | grep -n 3000; df -h / | tail -1'
#   expect: active; PORT=3000, OC_LISTEN=0.0.0.0, OC_TRUSTED_PROXY=10.0.0.100;
#   only node on :3000; nothing on 3001 or 9090; health ok; anubis not
#   installed; amd64; no MISSING line; "github: 200".
```

**1. Back up.** This covers the guest's settings, the database, and the
NPM proxy host.

```sh
$G 'B=/root/pre-anubis-$(date -u +%Y%m%dT%H%M%SZ) && install -d -m 0700 $B &&
    cp -a /etc/opencell/portal.env /etc/nftables.conf /etc/systemd/system/oc-portal.service $B/ &&
    systemctl start oc-portal-backup.service && ls -l $B && ls -lt /var/lib/oc-portal/backups | head -3 && echo $B'
#   Note the $B it prints; the rollback uses it.
(umask 077; curl -fsS -H "$H" "$NPM_API/nginx/proxy-hosts/3" > ~/pre-anubis-npm-proxy-host-3.json)
```

**2. Deploy v0.2.1 while the portal is still on 3000**, with v0.2.1's own
`oc-portal-deploy`. Then check the guard.

```sh
cd ~/Documents/opencell/portal && git fetch --tags origin &&
  git worktree add ../portal-$TAG $TAG && ../portal-$TAG/deploy/oc-portal-deploy deploy $TAG
$G 'readlink /opt/oc-portal/current
    grep -c confirmEmailLinkAction /opt/oc-portal/current/.next/server/server-reference-manifest.json
    curl -s -w " %{http_code}\n" -X POST -H "Origin: https://opencell.k4ozi.com" -H "Next-Action: 00" \
         -H "Content-Type: text/plain" --data x http://127.0.0.1:3000/auth/email/x'
#   expect: .../releases/v0.2.1; a count >= 1;
#   "Forbidden: this page only confirms its link. 403".
#   Undo: ../portal-$TAG/deploy/oc-portal-deploy rollback (back to v0.2.0,
#   which is fine while Anubis is not in front).
```

**3. nginx-proxy: X-Forwarded-For from `$remote_addr` only.** This is
one advanced-config line at the server level of proxy host 3. It is
appended to whatever is already there (see "Client addresses" above).

```sh
cur="$(jq -r '.advanced_config // ""' ~/pre-anubis-npm-proxy-host-3.json)"
if grep -q more_clear_input_headers <<<"$cur"; then echo "already there"; else
  new="$(printf '%s\n%s\n%s\n' "$cur" \
    '# OpenCell: drop any client-sent X-Forwarded-For (portal deploy/anubis/README.md)' \
    'more_clear_input_headers X-Forwarded-For;')"
  jq -n --arg a "$new" '{advanced_config: $a}' |
    curl -fsS -X PUT -H "$H" -H 'Content-Type: application/json' --data @- "$NPM_API/nginx/proxy-hosts/3" |
    jq '{id, advanced_config, meta}'
fi
$N 'grep -n -e more_clear -e X-Forwarded-For /data/nginx/proxy_host/3.conf; nginx -t'
curl -fsS https://opencell.k4ozi.com/healthz; echo
#   expect: meta.nginx_online true and no nginx_err; the line in 3.conf
#   above the locations; "syntax is ok"; the site answers.
#   Undo: jq '{advanced_config}' ~/pre-anubis-npm-proxy-host-3.json |
#     curl -fsS -X PUT -H "$H" -H 'Content-Type: application/json' --data @- "$NPM_API/nginx/proxy-hosts/3"
```

**4. Copy v0.2.1's `deploy/anubis/` to the guest.** Copy it from the tag
you deployed, not HEAD.

```sh
git -C ~/Documents/opencell/portal archive "$TAG" deploy/anubis |
  $G 'rm -rf /root/oc-anubis && mkdir -m 0700 /root/oc-anubis && tar -x -C /root/oc-anubis'
```

**5. Install Anubis, neither enabled nor started.** Port 3000 is still the
portal's. Go straight on to step 6.

```sh
$G 'bash /root/oc-anubis/deploy/anubis/install-anubis.sh'
#   expect: "installing Anubis 1.27.0 ...", then "port 3000 is still taken
#   ... neither enabled nor started". It refuses, and installs nothing, on a
#   checksum or signature mismatch.
$G 'dpkg-query -W anubis; anubis --version; ls -l /etc/anubis/;
    systemctl cat anubis@oc-portal | head -40; systemctl is-enabled anubis@oc-portal'
#   expect: 1.27.0; the three files and oc-portal.key.env (0600); "disabled".
#   Undo: apt-get remove anubis; rm -r /etc/anubis /etc/systemd/system/anubis@oc-portal.service.d
```

**6. Switch.** The downtime runs from the portal's restart until Anubis
starts. Anubis starts only if the portal is healthy on 3001.

```sh
$G 'set -e
    sed -i -e "s/^PORT=.*/PORT=3001/" -e "s/^OC_LISTEN=.*/OC_LISTEN=127.0.0.1/" \
           -e "s/^OC_TRUSTED_PROXY=.*/OC_TRUSTED_PROXY=127.0.0.1/" /etc/opencell/portal.env
    grep -E "^(PORT|OC_LISTEN|OC_TRUSTED_PROXY)=" /etc/opencell/portal.env
    [ "$(grep -cxE "PORT=3001|OC_LISTEN=127.0.0.1|OC_TRUSTED_PROXY=127.0.0.1" /etc/opencell/portal.env)" = 3 ]
    systemctl restart oc-portal
    ok=; for i in $(seq 1 30); do if curl -fsS http://127.0.0.1:3001/healthz; then ok=1; break; fi; sleep 1; done; echo
    [ -n "$ok" ] || { echo "portal NOT healthy on 3001: Anubis not started; roll back"; journalctl -u oc-portal -n 30 --no-pager; exit 1; }
    systemctl enable --now anubis@oc-portal
    sleep 1; systemctl is-active anubis@oc-portal
    ss -Hltnp "( sport = :3000 or sport = :3001 or sport = :9090 )"'
#   expect: the portal healthy on 3001 (version v0.2.1); anubis active; anubis
#   on *:3000 and 127.0.0.1:9090, node on 127.0.0.1:3001. The portal logs
#   "trusted proxy is 127.0.0.1".
```

**7. Verify.**

```sh
# On the guest, through Anubis as nginx-proxy would call it:
$G 'curl -fsS -H "X-Forwarded-For: 192.0.2.1" -H "X-Real-IP: 192.0.2.1" http://127.0.0.1:3000/healthz; echo
    curl -fsS http://127.0.0.1:9090/metrics | grep -c ^anubis_
    journalctl -u anubis@oc-portal -u oc-portal --since -5min --no-pager | tail -30'
# From outside, through nginx-proxy:
curl -fsS https://opencell.k4ozi.com/healthz; echo                          # {"ok":true,"version":"v0.2.1"}
curl -fsS https://opencell.k4ozi.com/ | grep -c anubis_challenge            # 0: public
curl -fsS https://opencell.k4ozi.com/sign-in | grep -c anubis_challenge     # 1: proof of work
curl -s --path-as-is https://opencell.k4ozi.com/_next/static/../../sign-in | grep -c anubis_challenge   # 1: no dot-segment way round
curl -fsS https://opencell.k4ozi.com/auth/email/x | grep -o 'http-equiv="refresh"\|"algorithm":"metarefresh"' | head -1
curl -fsS https://opencell.k4ozi.com/robots.txt | head -3
../portal-$TAG/deploy/oc-portal-deploy status              # health via 3001, anubis: active
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

**Rollback of the switch** (at any point after step 6). Free 3000 first,
then put the portal back on it:

```sh
$G 'set -e; B=<the directory from step 1>
    systemctl disable --now anubis@oc-portal
    cp -a $B/portal.env /etc/opencell/portal.env
    systemctl restart oc-portal
    ok=; for i in $(seq 1 30); do if curl -fsS http://127.0.0.1:3000/healthz; then ok=1; break; fi; sleep 1; done; echo
    [ -n "$ok" ] || { echo "portal NOT healthy on 3000"; journalctl -u oc-portal -n 30 --no-pager; exit 1; }'
```

- nginx-proxy's forwarding needs no change. The step 3 line can stay: it
  is right with or without Anubis. Undo it only if it is itself the
  problem.
- The package, `/etc/anubis` and the key can stay (undo step 5 removes
  them).
- `oc-portal-deploy` reads `PORT=3000` again from the restored
  `portal.env`.
- To go back to v0.2.0 as well, do it only after this rollback, never with
  Anubis in front: `../portal-$TAG/deploy/oc-portal-deploy rollback`.

**Later changes to the policy or environment:**

1. Edit them here and merge.
2. Tag and deploy the release (step 2).
3. Copy that tag's `deploy/anubis/` (step 4).
4. Run the installer (step 5).

The installer restarts Anubis only if a file changed. The restart takes
about a second, and passes survive it.
