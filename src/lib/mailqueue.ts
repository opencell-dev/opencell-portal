import { randomBytes } from 'node:crypto';
import type { Mail, Mailer } from '@/lib/mail';

export interface MailQueue {
  /** Queue a mail to send in the background; never blocks the caller (spec §3, §10 — no timing oracle). */
  send(mail: Mail): void;
  /** Resolves once every queued send (and its retry) has settled. Tests only. */
  drain(): Promise<void>;
}

/**
 * What kind of failure `e` was, and nothing else: its name, nodemailer's
 * error code (EENVELOPE, EAUTH, …) and the SMTP reply code, each only when it
 * has the expected shape. Never the message or the error object: nodemailer
 * puts a rejected recipient's address in both (`rejected`, `response`,
 * `rejectedErrors[].recipient`), which would defeat the tag below.
 */
function errorClass(e: unknown): string {
  if (!(e instanceof Error) || !/^[A-Za-z]{1,40}$/.test(e.name)) return 'unknown error';
  const { code, responseCode } = e as { code?: unknown; responseCode?: unknown };
  const parts = [e.name];
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) parts.push(code);
  if (typeof responseCode === 'number' && Number.isInteger(responseCode) && responseCode >= 100 && responseCode <= 599) parts.push(String(responseCode));
  return parts.join(' ');
}

/** A tiny in-process fire-and-forget sender: one retry, then it just logs. */
export function createMailQueue(mailer: Mailer): MailQueue {
  const pending = new Set<Promise<void>>();
  return {
    send(mail) {
      // Never log the address itself (spec §10), and not even an unkeyed
      // hash of it: an email's low entropy makes that dictionary-able back
      // to the address. A random per-send tag correlates the two log lines
      // of one failure without saying anything about who it was to.
      const tag = randomBytes(4).toString('hex');
      const task = (async () => {
        try {
          await mailer.send(mail);
        } catch {
          try {
            await mailer.send(mail);
          } catch (e) {
            console.error(`mail to recipient ${tag} failed twice, giving up (${errorClass(e)})`);
          }
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    async drain() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
