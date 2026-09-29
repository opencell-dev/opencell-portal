// Serve ALTCHA's PBKDF2 worker from our own origin (no blob: workers, no CDN).
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public/altcha', { recursive: true });
copyFileSync('node_modules/altcha/dist/workers/pbkdf2.js', 'public/altcha/pbkdf2.js');
console.log('copied the ALTCHA worker to public/altcha/');
