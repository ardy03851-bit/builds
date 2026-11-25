import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHierarchy } from '../src/app/project.js';

test('project hierarchy recovery breaks cycles and orphans without dropping valid ancestry', () => {
  const input = [
    { id: 'a', parentId: 'b' },
    { id: 'b', parentId: 'a' },
    { id: 'child', parentId: 'a' },
    { id: 'orphan', parentId: 'missing' },
  ];
  const result = normalizeHierarchy(input);
  assert.deepEqual(result.map((node) => [node.id, node.parentId]), [
    ['a', 'b'],
    ['b', null],
    ['child', 'a'],
    ['orphan', null],
  ]);
  assert.equal(input[1].parentId, 'a', 'normalization must not mutate its input');
});
