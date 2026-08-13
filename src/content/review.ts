import type { ContentRepository, StoredContentItem, SummaryRecord, TranscriptRecord } from './repository.js';
import type { KnowledgeClaim, TranscriptSegment } from './types.js';

export interface ClaimReviewItem {
  item: StoredContentItem;
  transcript: TranscriptRecord;
  summary: SummaryRecord;
}

function timestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function quoted(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/^/gm, '> ');
}

function citedText(claim: KnowledgeClaim, segments: TranscriptSegment[], citationIndex: number): string {
  const citation = claim.citations[citationIndex];
  const ids = new Set(citation.segmentIds);
  return segments.filter((segment) => ids.has(segment.id)).map((segment) => segment.text).join(' ');
}

function reviewRisk(claim: KnowledgeClaim): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  if (/\b\d[\d,.]*\b|[$€£¥]|%/.test(claim.text)) reasons.push('exact number');
  if (/\b(because|caused?|therefore|result(?:ed|ing)?|leading|allow(?:ed|ing)?|saved|due to)\b/i.test(claim.text)) reasons.push('causal claim');
  if (/\b(all|always|never|only|every|first|entire|none)\b/i.test(claim.text)) reasons.push('broad or exclusive wording');
  if (claim.text.length >= 180) reasons.push('long compound claim');
  if (claim.citations.length === 1) reasons.push('single citation');
  return { score: reasons.length, reasons };
}

function claimSection(item: StoredContentItem, transcript: TranscriptRecord, claim: KnowledgeClaim, label: string): string {
  const evidence = claim.citations.map((citation, index) => {
    const startSeconds = Math.floor(citation.startMs / 1000);
    const source = `${item.canonicalUrl}${item.canonicalUrl.includes('?') ? '&' : '?'}t=${startSeconds}s`;
    const excerpt = citedText(claim, transcript.transcript.segments, index);
    return `- [${timestamp(citation.startMs)}–${timestamp(citation.endMs)}](${source})\n\n${quoted(excerpt || '[Missing cited transcript segments]')}`;
  }).join('\n\n');
  return `### ${label}\n\nVerdict: [ ] Supported  [ ] Unsupported  [ ] Needs edit\n\n**Claim:** ${claim.text}\n\n**Evidence**\n\n${evidence}\n\nReviewer notes:\n`;
}

export function buildClaimReviewPacket(items: ClaimReviewItem[], generatedAt = new Date().toISOString()): string {
  const claimCount = items.reduce((total, record) => total + record.summary.overview.length + record.summary.details.length, 0);
  const prioritized = items.flatMap(({ item, summary }, itemIndex) => [
    ...summary.overview.map((claim, index) => ({ item, claim, label: `${itemIndex + 1}-O${index + 1}`, ...reviewRisk(claim) })),
    ...summary.details.map((claim, index) => ({ item, claim, label: `${itemIndex + 1}-D${index + 1}`, ...reviewRisk(claim) })),
  ]).sort((left, right) => right.score - left.score || right.claim.text.length - left.claim.text.length || left.label.localeCompare(right.label)).slice(0, 20);
  const priorityQueue = prioritized.map(({ item, claim, label, reasons }) =>
    `- [${label}](#${label.toLowerCase()}) — ${item.title}: ${reasons.join(', ')}\n  - ${claim.text}`,
  ).join('\n');
  const sections = items.map(({ item, transcript, summary }, itemIndex) => {
    const overview = summary.overview.map((claim, index) => claimSection(item, transcript, claim, `${itemIndex + 1}-O${index + 1}`)).join('\n\n');
    const details = summary.details.map((claim, index) => claimSection(item, transcript, claim, `${itemIndex + 1}-D${index + 1}`)).join('\n\n');
    return `## ${itemIndex + 1}. ${item.title}\n\nSource: ${item.canonicalUrl}\n\nClaims: ${summary.overview.length + summary.details.length} (${summary.overview.length} overview, ${summary.details.length} detail)\n\n### Overview claims\n\n${overview}\n\n### Detail claims\n\n${details}`;
  }).join('\n\n---\n\n');

  return `# Knowledge Pages Claim Review\n\nGenerated: ${generatedAt}\n\nItems: ${items.length}  \nClaims: ${claimCount}\n\nReview every claim against its quoted evidence and timestamped source. Check exactly one verdict. A supported claim must not be broader or more certain than its cited excerpt.\n\nFinal tally: Supported ____ / ${claimCount}  ·  Unsupported ____  ·  Needs edit ____  ·  Precision ____%\n\n## Priority review queue\n\nUp to 20 claims rank highest by deterministic review risk: exact numbers, causal or broad wording, compound length, and single-citation support. Risk rank is triage, not a verdict. Every claim still requires review.\n\n${priorityQueue}\n\n${sections}\n`;
}

export async function loadClaimReviewPacket(repository: ContentRepository, generatedAt = new Date().toISOString()): Promise<string> {
  const items = await repository.listItems(100, 0);
  const records: ClaimReviewItem[] = [];
  for (const item of items) {
    const [transcript, summary] = await Promise.all([repository.getTranscript(item.canonicalId), repository.getSummary(item.canonicalId)]);
    if (transcript && summary) records.push({ item, transcript, summary });
  }
  return buildClaimReviewPacket(records, generatedAt);
}
