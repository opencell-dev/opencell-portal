'use client';

import 'altcha/altcha.css';
import { useEffect } from 'react';

type AltchaGlobal = { algorithms: Map<string, () => Worker> };

/**
 * The ALTCHA widget, CSP-friendly build: no inline styles, no blob: workers.
 * The PBKDF2 worker is served from /altcha/pbkdf2.js (scripts/copy-altcha.mjs).
 * It puts its payload in a hidden input named `altcha`.
 */
export function AltchaWidget() {
  useEffect(() => {
    void import('altcha/external').then(() => {
      const g = globalThis as typeof globalThis & { $altcha?: AltchaGlobal };
      g.$altcha?.algorithms.set('PBKDF2/SHA-256', () => new Worker('/altcha/pbkdf2.js'));
    });
  }, []);
  return <altcha-widget challenge="/api/altcha" name="altcha" auto="onfocus" workers={2} />;
}
