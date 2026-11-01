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

const spaced = (n: string) => n.replace(/^\+883(1)(\d{3})(\d{3})(\d{5})$/, '+883 $1 $2 $3 $4');
const utc = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * "Email it to me" on the activation page (portal spec §4.1 step 4): the
 * QR's text form, which a terminal takes instead of a scan. No image: plain
 * text, as every OpenCell mail. Only ever sent to the account's own verified address.
 */
export function activationQrMail(name: string, number: string, qrText: string, expiresAt: number, origin: string): Template {
  return {
    subject: `Your OpenCell activation code for ${spaced(number)}`,
    text:
      `Hello ${name},\n\nThis is the activation code for your number ${spaced(number)}, as you asked. ` +
      `On the terminal, choose to activate by text and enter it exactly:\n\n${qrText}\n\n` +
      `It works once, until ${utc(expiresAt)}. If no terminal activates the number by then, it goes back to the pool. ` +
      `Anyone with this code can take the number, so don't forward this message. ` +
      `If you make a new QR code on the portal, this one stops working.${sig(origin)}`,
  };
}

export function limitRequestMail(adminName: string, who: string, wanted: number, reason: string, origin: string): Template {
  return {
    subject: 'OpenCell: a subscriber asks for more numbers',
    text:
      `Hello ${adminName},\n\n${who} asks to hold up to ${wanted} numbers. Their reason:\n\n${reason}\n\n` +
      `Decide on the Admin page: ${origin}/admin/limits${sig(origin)}`,
  };
}

export function limitDecisionMail(name: string, raised: boolean, limit: number, note: string | null, origin: string): Template {
  return {
    subject: raised ? 'OpenCell: you can hold more numbers' : 'OpenCell: your request for more numbers',
    text: raised
      ? `Hello ${name},\n\nYour account can now hold up to ${limit} numbers. Get one on My numbers: ${origin}/numbers${sig(origin)}`
      : `Hello ${name},\n\nWe can't raise your number limit right now; it stays at ${limit}.` +
        `${note ? `\n\n${note}` : ''}${sig(origin)}`,
  };
}

// ---- Portal P3: nodes. A contact phone and an exact pin never go in a mail (spec §10). ----

export function nodeRequestMail(adminName: string, who: string, siteName: string, region: string, link: string, origin: string): Template {
  return {
    subject: 'OpenCell: a subscriber asks to host a base station',
    text: `Hello ${adminName},\n\n${who} asks to host a base station: ${siteName} (${region}).\n\nReview it: ${link}${sig(origin)}`,
  };
}

export function nodeReplyMail(adminName: string, who: string, siteName: string, link: string, origin: string): Template {
  return {
    subject: 'OpenCell: a reply about a base station request',
    text: `Hello ${adminName},\n\n${who} answered your question about ${siteName}.\n\nRead it: ${link}${sig(origin)}`,
  };
}

export function nodeQuestionMail(name: string, siteName: string, question: string, link: string, origin: string): Template {
  return {
    subject: 'OpenCell: a question about your base station request',
    text: `Hello ${name},\n\nAn OpenCell admin has a question about your request for ${siteName}:\n\n${question}\n\nAnswer it in the portal: ${link}${sig(origin)}`,
  };
}

const NO_RELEASE_YET = 'Setup opens when the cell software is published: we will write again, and your node page will show the command.';

export function nodeApprovedMail(name: string, siteName: string, command: string | null, expiresAt: number | null, link: string, origin: string): Template {
  const setup =
    command !== null && expiresAt !== null
      ? `Set it up with one command on the Raspberry Pi, with the W12 board on USB. It works once, until ${utc(expiresAt)}:\n\n${command}\n\nOpen the address in a browser first if you want to read the script. ` +
        `Anyone with this command can set up your node, so don't forward this message. Your node page can make a new one if it runs out.`
      : NO_RELEASE_YET;
  return {
    subject: `OpenCell: your base station ${siteName} is approved`,
    text: `Hello ${name},\n\nYour base station ${siteName} is approved. Thank you for hosting it.\n\n${setup}\n\nYour node: ${link}${sig(origin)}`,
  };
}

export function nodeDeclinedMail(name: string, siteName: string, note: string, origin: string): Template {
  return {
    subject: 'OpenCell: your base station request',
    text: `Hello ${name},\n\nWe can't approve your request for ${siteName} right now:\n\n${note}\n\nYou can answer by writing to opencell@k4ozi.com.${sig(origin)}`,
  };
}
