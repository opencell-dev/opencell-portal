// Plain-text messages. No HTML, no tracking, no remote images.

export interface Template {
  subject: string;
  text: string;
}

const sig = '\n\n— OpenCell\nhttps://opencell.k4ozi.com\n';

// Mail to an address nobody has verified yet (sign-up, a new address) never
// carries the name typed with it: anyone can type any name and any address,
// so that would let strangers put their words into our mail (final review I2).

export function verifyMail(url: string): Template {
  return {
    subject: 'Confirm your email for OpenCell',
    text:
      `Hello,\n\nSomeone (hopefully you) signed up for OpenCell with this address. ` +
      `Open this link to confirm it. It works for 30 minutes:\n\n${url}\n\n` +
      `If you didn't sign up, ignore this message and nothing happens.${sig}`,
  };
}

export function magicLinkMail(name: string, url: string): Template {
  return {
    subject: 'Your OpenCell sign-in link',
    text:
      `Hello ${name},\n\nOpen this link to sign in to OpenCell. It works for 15 minutes, and only once:\n\n${url}\n\n` +
      `If you didn't ask for it, ignore this message.${sig}`,
  };
}

export function emailChangeMail(url: string): Template {
  return {
    subject: 'Confirm your new email for OpenCell',
    text:
      `Hello,\n\nOpen this link to make this your OpenCell email address. It works for 30 minutes:\n\n${url}\n\n` +
      `If you didn't ask for this, ignore this message.${sig}`,
  };
}

export function emailChangedNotice(name: string, newEmail: string): Template {
  return {
    subject: 'Your OpenCell email address was changed',
    text:
      `Hello ${name},\n\nYour OpenCell account now uses ${newEmail}. ` +
      `If you didn't do this, write to opencell@k4ozi.com at once.${sig}`,
  };
}
