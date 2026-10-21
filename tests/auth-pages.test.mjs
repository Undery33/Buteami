import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const pages = ['login', 'find-id', 'reset-password', 'signup'];

test('all account pages resolve their local assets and navigation targets', () => {
  for (const page of pages) {
    const file = new URL(`auth/${page}.html`, root);
    const html = readFileSync(file, 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(?:https?:|#)/.test(ref)) continue;
      assert.ok(existsSync(new URL(ref, file)), `${page}: missing ${ref}`);
    }
  }
});
test('preview forms fail closed before JS attaches and cannot submit native form data', () => {
  for (const page of pages) {
    const html = readFileSync(new URL(`auth/${page}.html`, root), 'utf8');
    assert.match(html, /<fieldset disabled>/);
    assert.match(html, /form-action 'none'/);
    assert.match(html, /<noscript\b[^>]*>/);
    for (const [input] of html.matchAll(/<input\b[^>]*>/g)) assert.doesNotMatch(input, /\bname=/);
  }
});
test('auth directory is shipped by the NGINX image and README stays empty', () => {
  assert.match(readFileSync(new URL('Dockerfile', root), 'utf8'), /COPY auth\/ \/usr\/share\/nginx\/html\/auth\//);
  assert.equal(readFileSync(new URL('README.md', root)).length, 0);
});
