// State codes (OCSS spec §3.3): `US-` + a USPS code, `CA-` + a Canada Post
// code, or a country's ISO alpha-2 for the other NANP countries. KY is the
// Cayman Islands and US-KY Kentucky; MS is Montserrat and US-MS Mississippi.
// These are the East and West lists oc-route writes into a delegation (the
// Mississippi split, portal spec §4.3): the core checks an added block's state
// against them, so a code in neither would refuse the whole addition.

export const STATE_CODE = /^([A-Z]{2}|(US|CA)-[A-Z]{2})$/;

const us = (s: string) => s.split(' ').map((c) => `US-${c}`);
const ca = (s: string) => s.split(' ').map((c) => `CA-${c}`);

export const EAST_STATES: ReadonlySet<string> = new Set([
  ...us('AL CT DC DE FL GA IL IN KY MA MD ME MI MS NC NH NJ NY OH PA RI SC TN VA VT WI WV PR VI'),
  ...ca('ON QC NB NS PE NL'),
  ...'AG AI BB BM BS DM DO GD JM KN KY LC MS SX TC TT VC VG'.split(' '),
]);

export const WEST_STATES: ReadonlySet<string> = new Set([
  ...us('AK AR AZ CA CO HI IA ID KS LA MN MO MT ND NE NM NV OK OR SD TX UT WA WY GU MP AS'),
  ...ca('MB SK AB BC YT NT NU'),
]);
