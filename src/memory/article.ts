import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, request } from 'undici';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function unsafeIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 88 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113);
}

export function isUnsafeAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  const version = net.isIP(normalized);
  if (version === 4) return unsafeIpv4(normalized);
  if (version !== 6) return true;
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff') || normalized.startsWith('2001:10:')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? unsafeIpv4(mapped[1]) : normalized.startsWith('2001:db8:');
}

async function pinnedDispatcher(hostname: string): Promise<Agent> {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isUnsafeAddress(address))) throw new Error('unsafe_capture_address');
  const selected = addresses[0];
  return new Agent({ connect: { lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family) } });
}

function decodeEntities(value: string): string {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function meta(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, 'i'),
  ];
  return patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean);
}

export function extractReadableArticle(html: string, canonicalUrl: string): { title: string; creator: string; text: string; canonicalUrl: string } {
  const title = decodeEntities(meta(html, 'og:title') ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? 'Saved article').replace(/\s+/g, ' ').trim();
  const creator = decodeEntities(meta(html, 'author') ?? meta(html, 'article:author') ?? new URL(canonicalUrl).hostname.replace(/^www\./, '')).replace(/\s+/g, ' ').trim();
  const main = html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1] ?? html;
  const text = decodeEntities(main
    .replace(/<(script|style|svg|nav|footer|header|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length >= 30).join('\n\n').slice(0, 2_000_000);
  if (text.length < 120) throw new Error('article_text_unavailable');
  return { title, creator, text, canonicalUrl };
}

export async function fetchReadableArticle(input: string, signal?: AbortSignal): Promise<{ title: string; creator: string; text: string; canonicalUrl: string }> {
  let current = new URL(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password || current.port && !['80', '443'].includes(current.port)) throw new Error('unsafe_capture_url');
    const dispatcher = await pinnedDispatcher(current.hostname);
    try {
      const response = await request(current, {
        dispatcher,
        signal,
        maxRedirections: 0,
        headersTimeout: 10_000,
        bodyTimeout: 20_000,
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9', 'user-agent': 'FieldTheory/1 local-reader' },
      });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        await response.body.dump();
        if (!location || hop === MAX_REDIRECTS) throw new Error('article_redirect_limit');
        current = new URL(Array.isArray(location) ? location[0] : location, current);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`article_http_${response.statusCode}`);
      const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new Error('article_content_type');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BYTES) throw new Error('article_too_large');
        chunks.push(buffer);
      }
      return extractReadableArticle(Buffer.concat(chunks).toString('utf8'), current.toString());
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error('article_redirect_limit');
}
