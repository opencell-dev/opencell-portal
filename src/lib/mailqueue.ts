import { createHash } from 'node:crypto';
import type { Mail, Mailer } from '@/lib/mail';

export interface MailQueue {
  /** Queue a mail to send in the background; never blocks the caller (spec §3, §10 — no timing oracle). */
  send(mail: Mail): void;
  /** Resolves once every queued send (and its retry) has settled. Tests only. */
  drain(): Promise<void>;
}

/** A tiny in-process fire-and-forget sender: one retry, then it just logs. */
export function createMailQueue(mailer: Mailer): MailQueue {
  const pending = new Set<Promise<void>>();
  return {
    send(mail) {
      const task = (async () => {
        try {
          await mailer.send(mail);
        } catch {
          try {
            await mailer.send(mail);
          } catch (e) {
            // Never log the address itself (spec §10): a short, non-reversible
            // tag is enough to correlate repeated failures in the log.
            const tag = createHash('sha256').update(mail.to).digest('hex').slice(0, 8);
            console.error(`mail to recipient ${tag} failed twice, giving up:`, e);
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
