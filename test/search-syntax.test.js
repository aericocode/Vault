/**
 * The boolean search syntax moved from player-lib/search-engine.js to
 * lib/search-syntax.js. These pin the behavior the browser had: quotes,
 * parentheses, precedence (NOT > AND > OR), uppercase-only operators, and the
 * parse-error fallback.
 */

const test = require('node:test');
const assert = require('node:assert');

const s = require('../lib/search-syntax');

// Evaluate a tree the way the browser did (substring over lowercased text).
function evalTree(node, text) {
  switch (node.op) {
    case 'term': return node.value === '' || text.includes(node.value);
    case 'and': return evalTree(node.left, text) && evalTree(node.right, text);
    case 'or': return evalTree(node.left, text) || evalTree(node.right, text);
    case 'not': return !evalTree(node.operand, text);
    default: return true;
  }
}
const t = (value) => ({ op: 'term', value });

test('mode: uppercase whole-word AND/OR/NOT is boolean, beating fuzzy', () => {
  assert.strictEqual(s.detectSearchMode('', true), 'none');
  assert.strictEqual(s.detectSearchMode('cat AND dog', false), 'boolean');
  assert.strictEqual(s.detectSearchMode('cat AND dog', true), 'boolean');
  assert.strictEqual(s.detectSearchMode('NOT dog', false), 'boolean');
  assert.strictEqual(s.detectSearchMode('cat and dog', false), 'plain');
  assert.strictEqual(s.detectSearchMode('cat and dog', true), 'fuzzy');
  assert.strictEqual(s.detectSearchMode('ANDROID', false), 'plain', 'whole words only');
  assert.strictEqual(s.detectSearchMode('ORANGE NOTE', true), 'fuzzy');
});

test('tokenizer: quotes keep a phrase, terms are lowercased, operators are not', () => {
  assert.deepStrictEqual(s.tokenizeBoolean('"Blue Sky" OR Sunset'), [
    { type: 'term', value: 'blue sky' }, { type: 'or' }, { type: 'term', value: 'sunset' },
  ]);
  assert.deepStrictEqual(s.tokenizeBoolean('(a)b'), [
    { type: 'lparen' }, { type: 'term', value: 'a' }, { type: 'rparen' }, { type: 'term', value: 'b' },
  ]);
  // An unclosed quote runs to the end of the text.
  assert.deepStrictEqual(s.tokenizeBoolean('x AND "open phrase'), [
    { type: 'term', value: 'x' }, { type: 'and' }, { type: 'term', value: 'open phrase' },
  ]);
  // Lowercase words are just terms.
  assert.deepStrictEqual(s.tokenizeBoolean('a and b').map(x => x.type), ['term', 'term', 'term']);
});

test('parser: precedence is NOT, then AND, then OR, left to right', () => {
  assert.deepStrictEqual(s.parseBoolean('a OR b AND c'),
    { op: 'or', left: t('a'), right: { op: 'and', left: t('b'), right: t('c') } });
  assert.deepStrictEqual(s.parseBoolean('a AND NOT b'),
    { op: 'and', left: t('a'), right: { op: 'not', operand: t('b') } });
  assert.deepStrictEqual(s.parseBoolean('(a OR b) AND NOT c'), {
    op: 'and', left: { op: 'or', left: t('a'), right: t('b') }, right: { op: 'not', operand: t('c') },
  });
  assert.deepStrictEqual(s.parseBoolean('a AND b AND c'),
    { op: 'and', left: { op: 'and', left: t('a'), right: t('b') }, right: t('c') });
});

test('parser: forgiving about stray tokens and missing operands, like the browser', () => {
  // A dangling operator yields an empty term, which matches everything.
  assert.deepStrictEqual(s.parseBoolean('a AND'), { op: 'and', left: t('a'), right: t('') });
  assert.deepStrictEqual(s.parseBoolean('NOT'), { op: 'not', operand: t('') });
  // Unbalanced parentheses: a missing ')' is tolerated, a stray ')' ends the parse.
  assert.deepStrictEqual(s.parseBoolean('(a OR b'), { op: 'or', left: t('a'), right: t('b') });
  assert.deepStrictEqual(s.parseBoolean(') a'), t(''));
  // Adjacent terms without an operator: the parser stops after the first.
  assert.deepStrictEqual(s.parseBoolean('a b AND c'), t('a'));
});

test('evaluation keeps the browser semantics on sample text', () => {
  const text = 'a cat and a dog under a blue sky';
  const ok = (q) => evalTree(s.parseBoolean(q), text);
  assert.strictEqual(ok('cat AND dog'), true);
  assert.strictEqual(ok('cat AND NOT dog'), false);
  assert.strictEqual(ok('fish OR "blue sky"'), true);
  assert.strictEqual(ok('(fish OR bird) AND cat'), false);
  assert.strictEqual(ok('NOT fish'), true);
});

test('parse error falls back: parseBoolean returns null instead of throwing', () => {
  // Nesting deep enough to overflow the recursive-descent parser.
  assert.strictEqual(s.parseBoolean('('.repeat(200000) + 'a AND b'), null);
});

test('words split like the unicode61 tokenizer', () => {
  assert.deepStrictEqual(s.words('IMG_2019_0714.jpg'), ['IMG', '2019', '0714', 'jpg']);
  assert.deepStrictEqual(s.words("red dre"), ['red', 'dre']);
  assert.deepStrictEqual(s.words('café-au-lait'), ['café', 'au', 'lait']);
  assert.deepStrictEqual(s.words('!!! ...'), []);
  assert.deepStrictEqual(s.words('éx'), ['éx'], 'combining marks stay inside a word');
});
