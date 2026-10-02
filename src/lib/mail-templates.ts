// Plain-text messages. No HTML, no tracking, no remote images.
import type { Site } from '@/lib/site';

export interface Template {
  subject: string;
  text: string;
}

// Signed with the origin that mailed it (final review M4), not a hardcoded
// one: a NOC-site mail pointing at noc.opencell.k4ozi.com must not sign
// itself with the portal's address, which is poor anti-phishing practice
// and tells the reader, wrongly, to ignore a link that is in fact genuine.
const sig = (origin: string) => `\n\n— OpenCell\n${origin}\n`;

// Mail to an address nobody has verified yet (sign-up, a new address) never
// carries the name typed with it: anyone can type any name and any address,
// so that would let strangers put their words into our mail (final review I2).

export function verifyMail(url: string, origin: string, site: Site): Template {
  if (site === 'noc') {
    // final review M4: an account here comes from oc-portal-admin add, not
    // a sign-up, so "someone signed up" is wrong and the "ignore it" advice
    // is actively bad (this is the one link that lets them in at all).
    return {
      subject: 'Your OpenCell NOC account',
      text:
        `Hello,\n\nAn OpenCell administrator created a staff account for you on the OpenCell NOC. ` +
        `Open this link to confirm your email address. It works for 30 minutes:\n\n${url}\n\n` +
        `If you were not expecting this, you can ignore this message, but check with whoever ` +
        `added you.${sig(origin)}`,
    };
  }
  return {
    subject: 'Confirm your email for OpenCell',
    text:
      `Hello,\n\nSomeone (hopefully you) signed up for OpenCell with this address. ` +
      `Open this link to confirm it. It works for 30 minutes:\n\n${url}\n\n` +
      `If you didn't sign up, ignore this message and nothing happens.${sig(origin)}`,
  };
}

export function magicLinkMail(name: string, url: string, origin: string, site: Site): Template {
  const where = site === 'noc' ? 'the OpenCell NOC' : 'OpenCell';
  return {
    subject: site === 'noc' ? 'Your OpenCell NOC sign-in link' : 'Your OpenCell sign-in link',
    text:
      `Hello ${name},\n\nOpen this link to sign in to ${where}. It works for 15 minutes, and only once:\n\n${url}\n\n` +
      `If you didn't ask for it, ignore this message.${sig(origin)}`,
  };
}

export function emailChangeMail(url: string, origin: string): Template {
  return {
    subject: 'Confirm your new email for OpenCell',
    text:
      `Hello,\n\nOpen this link to make this your OpenCell email address. It works for 30 minutes:\n\n${url}\n\n` +
      `If you didn't ask for this, ignore this message.${sig(origin)}`,
  };
}

export function emailChangedNotice(name: string, newEmail: string, origin: string): Template {
  return {
    subject: 'Your OpenCell email address was changed',
    text:
      `Hello ${name},\n\nYour OpenCell account now uses ${newEmail}. ` +
      `If you didn't do this, write to opencell@k4ozi.com at once.${sig(origin)}`,
  };
}
