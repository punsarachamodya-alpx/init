import { describe, expect, test } from 'vitest';
import { assertLocalUrl } from './setup/rebuild.ts';

describe('the database rebuild helper only ever touches this machine', () => {
  test.each([
    'postgresql://u:p@localhost:5432/postgres',
    'postgresql://u:p@127.0.0.1/colombo_test',
    'postgresql://u:p@[::1]:5432/postgres',
    'postgresql:///colombo_test?host=/var/run/postgresql',
  ])('allowed: %s', (url) => {
    expect(() => assertLocalUrl(url, 'X')).not.toThrow();
  });

  test.each([
    'postgresql://u:p@db.example.com:5432/postgres',
    'postgresql://u:p@10.0.0.5/postgres',
    'postgresql://u:p@localhost/postgres?host=db.example.com', // node-pg lets ?host= override the authority
    'postgresql://u:p@localhost/postgres?host=/run/pg,db.example.com',
    'not a url',
  ])('refused: %s', (url) => {
    expect(() => assertLocalUrl(url, 'X')).toThrow(/local/);
  });
});
