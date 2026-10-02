// The portal's HTTP server: Next.js behind one job of our own, stamping each
// request with the client's address (x-oc-client-ip) so rate limits and the
// audit can use it. Anything a client sends in that header is overwritten.
import { createServer } from 'node:http';
import next from 'next';
import { clientIp, forwardedHeadersTrusted, parseTrustedProxy } from './server/client-ip.mjs';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const host = process.env.OC_LISTEN ?? '127.0.0.1';

// This process always speaks plain HTTP on its own loopback port, whatever
// scheme the client used (TLS is terminated upstream, by nginx-proxy/Anubis).
// Without this, Next derives its own "origin" from X-Forwarded-Proto when a
// trusted proxy sends it (so absolute URLs it builds for the browser are
// correct) and reuses that same origin for an internal self-fetch when a
// Server Action redirects (next/navigation's redirect()) — trying to speak
// TLS to this http-only port, failing ("failed to get redirect response …
// wrong version number"), and falling back to a plain redirect. `next start`
// sets this same variable itself; a custom server like this one must set it
// too. See node_modules/next/dist/server/app-render/action-handler.js.
process.env.__NEXT_PRIVATE_ORIGIN = `http://${host}:${port}`;

let trusted;
try {
  trusted = parseTrustedProxy(process.env.OC_TRUSTED_PROXY);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
console.log(`oc-portal: trusted proxy is ${trusted || '(none configured — every X-Forwarded-* header is dropped)'}`);

const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();
await app.prepare();

createServer((req, res) => {
  const peer = req.socket.remoteAddress;
  req.headers['x-oc-client-ip'] = clientIp(peer, req.headers['x-forwarded-for'], trusted);
  if (!forwardedHeadersTrusted(peer, trusted)) {
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-forwarded-host'];
    delete req.headers['x-forwarded-proto'];
  }
  void handle(req, res);
}).listen(port, host, () => {
  console.log(`oc-portal listening on http://${host}:${port} (${dev ? 'development' : 'production'})`);
});
