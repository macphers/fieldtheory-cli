import { randomBytes, timingSafeEqual } from 'node:crypto';

function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface LocalSession {
  id: string;
  csrf: string;
  expiresAt: number;
}

export class LocalCapabilitySessions {
  private readonly bootstrapTokens = new Map<string, number>();
  private readonly sessions = new Map<string, LocalSession>();

  issueBootstrap(now = Date.now(), ttlMs = 60_000): string {
    const value = token();
    this.bootstrapTokens.set(value, now + ttlMs);
    return value;
  }

  exchangeBootstrap(value: string | null, now = Date.now(), sessionTtlMs = 12 * 60 * 60_000): LocalSession | null {
    if (!value) return null;
    const match = Array.from(this.bootstrapTokens.keys()).find((candidate) => safeEqual(candidate, value));
    if (!match) return null;
    const expiresAt = this.bootstrapTokens.get(match)!;
    this.bootstrapTokens.delete(match);
    if (expiresAt < now) return null;
    const session: LocalSession = { id: token(), csrf: token(), expiresAt: now + sessionTtlMs };
    this.sessions.set(session.id, session);
    return session;
  }

  authenticate(sessionId: string | undefined, now = Date.now()): LocalSession | null {
    if (!sessionId) return null;
    const match = Array.from(this.sessions.keys()).find((candidate) => safeEqual(candidate, sessionId));
    if (!match) return null;
    const session = this.sessions.get(match)!;
    if (session.expiresAt < now) {
      this.sessions.delete(match);
      return null;
    }
    return session;
  }

  verifyCsrf(session: LocalSession, value: string | undefined): boolean {
    return safeEqual(session.csrf, value);
  }
}

export class ConfirmationChallenges {
  private readonly challenges = new Map<string, { action: string; target: string; expiresAt: number }>();

  issue(action: string, target: string, now = Date.now(), ttlMs = 60_000): string {
    const value = token(24);
    this.challenges.set(value, { action, target, expiresAt: now + ttlMs });
    return value;
  }

  consume(value: string | undefined, action: string, target: string, now = Date.now()): boolean {
    if (!value) return false;
    const match = Array.from(this.challenges.keys()).find((candidate) => safeEqual(candidate, value));
    if (!match) return false;
    const challenge = this.challenges.get(match)!;
    this.challenges.delete(match);
    return challenge.expiresAt >= now && challenge.action === action && challenge.target === target;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 1) return [];
    return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  }));
}
