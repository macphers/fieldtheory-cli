import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReadableArticle, isUnsafeAddress } from '../src/memory/article.js';

test('manual article resolver rejects local, private, mapped, and documentation addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.1.2', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isUnsafeAddress(address), true, address);
  }
  assert.equal(isUnsafeAddress('1.1.1.1'), false);
  assert.equal(isUnsafeAddress('2606:4700:4700::1111'), false);
});

test('article extraction prefers semantic content and removes active page chrome', () => {
  const article = extractReadableArticle(`<!doctype html><html><head><title>Useful systems</title><meta name="author" content="Ada"></head><body><nav>Ignore navigation forever</nav><article><h1>Useful systems</h1><p>A useful article paragraph contains enough meaningful words to become part of durable memory.</p><script>steal()</script><p>A second paragraph connects this observation to an active project and a practical decision.</p></article></body></html>`, 'https://example.com/read');
  assert.equal(article.title, 'Useful systems');
  assert.equal(article.creator, 'Ada');
  assert.match(article.text, /durable memory/);
  assert.doesNotMatch(article.text, /steal|navigation/);
});
