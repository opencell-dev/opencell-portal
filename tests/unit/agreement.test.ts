import { describe, expect, it } from 'vitest';
import { AGREEMENT_VERSION, agreementMarkdown } from '@/content/operator-agreement';

// Portal spec §6.4, verbatim (the blockquote without its "> " prefixes).
const SPEC_6_4 = `**Thank you for hosting an OpenCell base station.** Every node carries calls for the people around it. When a node goes down, everyone it serves loses service — often without knowing why. This agreement is not a contract and creates no legal obligation; it's a promise, in good faith, to look after equipment that other people rely on.

As an operator, I will do my best to:
1. **Keep it running.** Keep the node powered and connected to the internet, and bring it back as soon as I reasonably can when it goes down.
2. **Keep it current.** Let it install OpenCell updates, and not run modified software on a node connected to the network without the admins' agreement.
3. **Stay within the rules.** Use only the radio settings the network gives my node (frequencies, power, mode), keep antennas and amplifiers within what I declared, and follow the radio regulations that apply where I live. Part 97 (amateur) mode needs a licensed control operator.
4. **Give notice.** Post a downtime notice in the portal before planned maintenance, a move, or retiring the node, when I can.
5. **Keep it secure.** Keep the Pi's login private, not share the node's key or certificate, and tell the admins at once if I think the node has been tampered with or stolen.
6. **Respect privacy.** Not try to read, record or reveal other people's calls, numbers or locations passing through my node.
7. **Keep my details current.** Keep my contact details and my node's location and hardware up to date.

The network may pause or disable a node that harms service or breaks these rules, and will try to contact me first. I can retire my node at any time by telling the admins. The hardware stays mine.`;

describe('Base Station Operator Agreement', () => {
  it('is version 1 and says exactly what spec §6.4 says', () => {
    expect(AGREEMENT_VERSION).toBe(1);
    expect(agreementMarkdown()).toBe(SPEC_6_4);
  });
});
