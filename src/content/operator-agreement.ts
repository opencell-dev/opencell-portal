// Base Station Operator Agreement, version 1 (portal spec §6.4), verbatim.
// A change of wording is a new version: operators re-accept it (spec §6.4).

export const AGREEMENT_VERSION = 1;

export const AGREEMENT = {
  lead: 'Thank you for hosting an OpenCell base station.',
  intro:
    "Every node carries calls for the people around it. When a node goes down, everyone it serves loses service — often without knowing why. This agreement is not a contract and creates no legal obligation; it's a promise, in good faith, to look after equipment that other people rely on.",
  promise: 'As an operator, I will do my best to:',
  items: [
    ['Keep it running.', 'Keep the node powered and connected to the internet, and bring it back as soon as I reasonably can when it goes down.'],
    ['Keep it current.', "Let it install OpenCell updates, and not run modified software on a node connected to the network without the admins' agreement."],
    [
      'Stay within the rules.',
      'Use only the radio settings the network gives my node (frequencies, power, mode), keep antennas and amplifiers within what I declared, and follow the radio regulations that apply where I live. Part 97 (amateur) mode needs a licensed control operator.',
    ],
    ['Give notice.', 'Post a downtime notice in the portal before planned maintenance, a move, or retiring the node, when I can.'],
    [
      'Keep it secure.',
      "Keep the Pi's login private, not share the node's key or certificate, and tell the admins at once if I think the node has been tampered with or stolen.",
    ],
    ['Respect privacy.', "Not try to read, record or reveal other people's calls, numbers or locations passing through my node."],
    ['Keep my details current.', "Keep my contact details and my node's location and hardware up to date."],
  ] as [string, string][],
  closing:
    'The network may pause or disable a node that harms service or breaks these rules, and will try to contact me first. I can retire my node at any time by telling the admins. The hardware stays mine.',
};

/** The agreement as Markdown, exactly as the spec prints it. */
export function agreementMarkdown(): string {
  const items = AGREEMENT.items.map(([t, s], i) => `${i + 1}. **${t}** ${s}`).join('\n');
  return `**${AGREEMENT.lead}** ${AGREEMENT.intro}\n\n${AGREEMENT.promise}\n${items}\n\n${AGREEMENT.closing}`;
}
