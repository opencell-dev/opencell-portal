// Words for the page, no server code: client and server components both use these.

const STATUS: Record<string, string> = {
  pending: 'Waiting for an admin',
  question: 'An admin has a question for you',
  approved: 'Approved',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

/** A request's status in words. */
export function requestStatusLabel(status: string): string {
  return STATUS[status] ?? status;
}
