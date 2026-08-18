import test from 'node:test';
import assert from 'node:assert/strict';
import { cosine, deterministicClusters } from '../src/memory/embeddings.js';

test('cosine similarity is bounded and rejects mixed dimensions', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1], [1, 0]), 0);
});

test('semantic cluster snapshots are deterministic and keep every item once', () => {
  const records = [
    { itemId: 'a', contentHash: '1', vector: [1, 0] },
    { itemId: 'b', contentHash: '2', vector: [0.9, 0.1] },
    { itemId: 'c', contentHash: '3', vector: [0, 1] },
    { itemId: 'd', contentHash: '4', vector: [0.1, 0.9] },
  ];
  const first = deterministicClusters(records, 2);
  const second = deterministicClusters([...records].reverse(), 2);
  assert.deepEqual(first, second);
  assert.deepEqual(first.flatMap((cluster) => cluster.itemIds).sort(), ['a', 'b', 'c', 'd']);
  assert.ok(first.every((cluster) => cluster.itemIds.length === 2));
});
