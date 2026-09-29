import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import type { Config } from '@/config';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

type Smtp = NonNullable<Config['mail']['smtp']>;

/** Proton's submission port 587 with STARTTLS required (portal spec §3 "Email"). */
export function smtpTransportOptions(smtp: Smtp) {
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.token },
    tls: { minVersion: 'TLSv1.2' as const, servername: smtp.host },
  };
}

/** The mailer the configuration names: SMTP, or JSON files in an outbox directory. */
export function createMailer(mail: Config['mail']): Mailer {
  if (mail.transport === 'smtp') {
    if (!mail.smtp) throw new Error('OC_MAIL=smtp needs SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_TOKEN');
    const t = nodemailer.createTransport(smtpTransportOptions(mail.smtp));
    return {
      async send(m) {
        await t.sendMail({ from: mail.from, to: m.to, subject: m.subject, text: m.text });
      },
    };
  }
  const t = nodemailer.createTransport({ jsonTransport: true });
  return {
    async send(m) {
      const info = await t.sendMail({ from: mail.from, to: m.to, subject: m.subject, text: m.text });
      mkdirSync(mail.outbox, { recursive: true });
      const name = `${Date.now()}-${randomBytes(4).toString('hex')}.json`;
      writeFileSync(join(mail.outbox, name), String(info.message), { mode: 0o600 });
    },
  };
}

/** Keeps messages in memory (unit and integration tests). */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
  /** The last URL sent to `to`, or throws. */
  lastLink(to: string): string {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    const url = m?.text.match(/https?:\/\/\S+/)?.[0];
    if (!url) throw new Error(`no link mailed to ${to}`);
    return url;
  }
}
