#!/usr/bin/env node
// Validate ISO 6346 container numbers (4 letters + 6 digits + check digit).
// Usage: node scripts/check-iso6346.mjs ZZZU1234564 ...
// Exit code 1 if any number is invalid.

export function checkDigit(first10) {
  const letterValues = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++; // skip multiples of 11
    letterValues[ch] = v++;
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i];
    const val = /[A-Z]/.test(ch) ? letterValues[ch] : Number(ch);
    sum += val * 2 ** i;
  }
  return (sum % 11) % 10;
}

export function isValidContainerNo(no) {
  const s = String(no).toUpperCase().replace(/\s|-/g, '');
  if (!/^[A-Z]{4}\d{7}$/.test(s)) return false;
  return checkDigit(s.slice(0, 10)) === Number(s[10]);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/check-iso6346.mjs <container_no...>');
    process.exit(2);
  }
  let bad = 0;
  for (const a of args) {
    const ok = isValidContainerNo(a);
    console.log(`${a}\t${ok ? 'valid' : 'INVALID'}`);
    if (!ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}
