const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
  'he', 'her', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'our', 'she',
  'so', 'that', 'the', 'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'which',
  'who', 'will', 'with', 'you', 'your',
]);

export interface RelatedDocument {
  id: string;
  text: string;
}

export interface RelatedScore {
  id: string;
  score: number;
  sharedTerms: string[];
}

function terms(text: string): string[] {
  const words = (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  const bigrams = words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`);
  return [...words, ...bigrams];
}

export function relatedScores(documents: RelatedDocument[], targetId: string, limit = 5): RelatedScore[] {
  const termCounts = new Map<string, Map<string, number>>();
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    const counts = new Map<string, number>();
    for (const term of terms(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    termCounts.set(document.id, counts);
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const vectors = new Map<string, Map<string, number>>();
  for (const document of documents) {
    const weighted = new Map<string, number>();
    for (const [term, count] of termCounts.get(document.id) ?? []) {
      const inverseFrequency = Math.log((documents.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
      weighted.set(term, (1 + Math.log(count)) * inverseFrequency);
    }
    const magnitude = Math.sqrt([...weighted.values()].reduce((sum, value) => sum + value * value, 0));
    if (magnitude > 0) for (const [term, value] of weighted) weighted.set(term, value / magnitude);
    vectors.set(document.id, weighted);
  }

  const target = vectors.get(targetId);
  if (!target) return [];
  return documents.flatMap((document) => {
    if (document.id === targetId) return [];
    const candidate = vectors.get(document.id);
    if (!candidate) return [];
    const contributions = [...target].flatMap(([term, weight]) => {
      const contribution = weight * (candidate.get(term) ?? 0);
      return contribution > 0 ? [{ term, contribution }] : [];
    }).sort((left, right) => right.contribution - left.contribution);
    const score = contributions.reduce((sum, value) => sum + value.contribution, 0);
    return score >= 0.04 ? [{ id: document.id, score, sharedTerms: contributions.slice(0, 3).map((value) => value.term) }] : [];
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, Math.max(1, Math.min(20, limit)));
}
