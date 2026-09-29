// The portal's HTTP server: Next.js behind one job of our own, stamping each
// request with the client's address (x-oc-client-ip) so rate limits and the
// audit can use it. Anything a client sends in that header is overwritten.
import { createServer } from 'node:http';
import next from 'next';
import { clientIp, forwardedHeadersTrusted, parseTrustedProxy } from './server/client-ip.mjs';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const host = process.env.OC_LISTEN ?? '127.0.0.1';

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
