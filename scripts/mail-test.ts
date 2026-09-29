// Send one test message through the configured transport:
//   npx tsx scripts/mail-test.ts you@example.org
import { config } from '@/config';
import { createMailer } from '@/lib/mail';

const to = process.argv[2];
if (!to) {
  console.error('usage: mail-test.ts ADDRESS');
  process.exit(2);
}
const c = config();
await createMailer(c.mail).send({
  to,
  subject: 'OpenCell portal mail test',
  text: `This is a test message from the OpenCell portal at ${c.origin} (${c.mail.transport}).`,
});
console.log(`sent to ${to} via ${c.mail.transport}`);
