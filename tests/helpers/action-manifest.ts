// A server-action manifest fixture for the email-link guard's tests.
// The shape Next 16 writes to .next/server/server-reference-manifest.json:
// action id -> the pages that hold it, the source file and export name.
export const CONFIRM = '4030739de5664322c6d1fe5ab53d3d0af4ded452a7';
export const MAGIC = '6076cafa2c4a6329865286f3f7f19e0fb83d6c66db';
export const SIGNUP = '608934df412cddfb80e894cb5e46b9c763886c13b3';
const worker = { 'app/(public)/auth/email/[token]/page': { moduleId: 1, async: false } };
export const MANIFEST = {
  node: {
    [CONFIRM]: { workers: worker, filename: 'src/app/actions/auth.ts', exportedName: 'confirmEmailLinkAction' },
    [MAGIC]: { workers: worker, filename: 'src/app/actions/auth.ts', exportedName: 'magicLinkAction' },
    [SIGNUP]: { workers: worker, filename: 'src/app/actions/auth.ts', exportedName: 'signUpAction' },
    // Same export name in another file: not the confirm action.
    '00aa': { workers: worker, filename: 'src/app/actions/other.ts', exportedName: 'confirmEmailLinkAction' },
  },
  edge: {},
  encryptionKey: 'x',
};
