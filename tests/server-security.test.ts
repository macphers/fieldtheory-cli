import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfirmationChallenges, LocalCapabilitySessions, parseCookies } from '../src/server/security.js';

test('bootstrap capabilities are short-lived, single-use, and exchanged for expiring sessions', () => {
  const sessions = new LocalCapabilitySessions();
  const bootstrap = sessions.issueBootstrap(1000, 100);
  const session = sessions.exchangeBootstrap(bootstrap, 1050, 500);
  assert.ok(session);
  assert.equal(sessions.exchangeBootstrap(bootstrap, 1050), null);
  assert.equal(sessions.authenticate(session!.id, 1500)?.id, session!.id);
  assert.equal(sessions.authenticate(session!.id, 1551), null);

  const expired = sessions.issueBootstrap(2000, 10);
  assert.equal(sessions.exchangeBootstrap(expired, 2011), null);
});

test('session and CSRF comparisons reject partial or malformed tokens', () => {
  const sessions = new LocalCapabilitySessions();
  const session = sessions.exchangeBootstrap(sessions.issueBootstrap(1000), 1000)!;
  assert.equal(sessions.authenticate(session.id.slice(0, -1), 1000), null);
  assert.equal(sessions.verifyCsrf(session, session.csrf), true);
  assert.equal(sessions.verifyCsrf(session, `${session.csrf}x`), false);
});

test('cookie parser handles multiple values without treating attributes as session data', () => {
  assert.deepEqual(parseCookies('other=one; ft_session=abc%20123'), { other: 'one', ft_session: 'abc 123' });
  assert.deepEqual(parseCookies('broken=%E0%A4%A; ft_session=valid'), { ft_session: 'valid' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('destructive confirmation challenges are scoped, expiring, and single-use', () => {
  const challenges = new ConfirmationChallenges();
  const value = challenges.issue('delete_item', 'youtube:id', 1000, 100);
  assert.equal(challenges.consume(value, 'delete_item', 'other', 1050), false);
  assert.equal(challenges.consume(value, 'delete_item', 'youtube:id', 1050), false);
  const valid = challenges.issue('delete_item', 'youtube:id', 1000, 100);
  assert.equal(challenges.consume(valid, 'delete_item', 'youtube:id', 1050), true);
  assert.equal(challenges.consume(valid, 'delete_item', 'youtube:id', 1050), false);
  const expired = challenges.issue('delete_activity', 'all', 1000, 10);
  assert.equal(challenges.consume(expired, 'delete_activity', 'all', 1011), false);
});
