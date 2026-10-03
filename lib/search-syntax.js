/**
 * Library search syntax: mode detection, the boolean tokenizer/parser, and the
 * word splitter the SQL search builds on.
 *
 * The tokenizer and parser moved here from the viewer
 * (player-lib/search-engine.js at 13c23ec) unchanged: uppercase-only AND/OR/NOT,
 * quotes for phrases, parentheses for grouping, terms lowercased. Evaluation is
 * no longer a substring test over joined text; lib/library-query.js turns each
 * leaf into the same match() the plain search uses (SERVER_SEARCH_SPEC 3.2).
 */

/** Uppercase whole-word AND/OR/NOT means a boolean search. */
const BOOLEAN_RE = /\b(AND|OR|NOT)\b/;

/**
 * 'none' | 'boolean' | 'fuzzy' | 'plain'. Same precedence as the browser's
 * detectSearchMode(): boolean beats the Fuzzy option. Semantic is decided by
 * the caller, before this.
 */
function detectSearchMode(query, fuzzy) {
  if (!query) return 'none';
  if (BOOLEAN_RE.test(query)) return 'boolean';
  if (fuzzy) return 'fuzzy';
  return 'plain';
}

function tokenizeBoolean(query) {
  const tokens = [];
  let i = 0;
  while (i < query.length) {
    // Skip whitespace
    if (query[i] === ' ') { i++; continue; }

    // Quoted phrase
    if (query[i] === '"') {
      const end = query.indexOf('"', i + 1);
      if (end === -1) {
        tokens.push({ type: 'term', value: query.substring(i + 1).toLowerCase() });
        break;
      }
      tokens.push({ type: 'term', value: query.substring(i + 1, end).toLowerCase() });
      i = end + 1;
      continue;
    }

    // Parentheses
    if (query[i] === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (query[i] === ')') { tokens.push({ type: 'rparen' }); i++; continue; }

    // Read a word
    let word = '';
    while (i < query.length && query[i] !== ' ' && query[i] !== '(' && query[i] !== ')') {
      word += query[i]; i++;
    }

    if (word === 'AND') tokens.push({ type: 'and' });
    else if (word === 'OR') tokens.push({ type: 'or' });
    else if (word === 'NOT') tokens.push({ type: 'not' });
    else tokens.push({ type: 'term', value: word.toLowerCase() });
  }
  return tokens;
}

// Recursive descent parser: expr = andExpr (OR andExpr)*
function parseBooleanExpr(tokens, pos) {
  if (!pos) pos = { i: 0 };
  let left = parseBooleanAnd(tokens, pos);
  while (pos.i < tokens.length && tokens[pos.i]?.type === 'or') {
    pos.i++; // consume OR
    const right = parseBooleanAnd(tokens, pos);
    left = { op: 'or', left, right };
  }
  return left;
}

function parseBooleanAnd(tokens, pos) {
  let left = parseBooleanNot(tokens, pos);
  while (pos.i < tokens.length && tokens[pos.i]?.type === 'and') {
    pos.i++; // consume AND
    const right = parseBooleanNot(tokens, pos);
    left = { op: 'and', left, right };
  }
  return left;
}

function parseBooleanNot(tokens, pos) {
  if (pos.i < tokens.length && tokens[pos.i]?.type === 'not') {
    pos.i++; // consume NOT
    const operand = parseBooleanAtom(tokens, pos);
    return { op: 'not', operand };
  }
  return parseBooleanAtom(tokens, pos);
}

function parseBooleanAtom(tokens, pos) {
  if (pos.i >= tokens.length) return { op: 'term', value: '' };

  if (tokens[pos.i].type === 'lparen') {
    pos.i++; // consume (
    const expr = parseBooleanExpr(tokens, pos);
    if (pos.i < tokens.length && tokens[pos.i]?.type === 'rparen') {
      pos.i++; // consume )
    }
    return expr;
  }

  if (tokens[pos.i].type === 'term') {
    const term = tokens[pos.i].value;
    pos.i++;
    return { op: 'term', value: term };
  }

  // Skip unexpected tokens
  pos.i++;
  return { op: 'term', value: '' };
}

/**
 * Parse a boolean query into a tree, or null when it cannot be parsed (the
 * caller then falls back to a plain search of the whole text, as the browser
 * did). The parser is forgiving, so in practice only a pathological input
 * (nesting deep enough to overflow the stack) lands here.
 */
function parseBoolean(query) {
  try {
    return parseBooleanExpr(tokenizeBoolean(query));
  } catch {
    return null;
  }
}

/**
 * Words the way FTS5's unicode61 tokenizer splits them: runs of letters,
 * numbers, combining marks and private-use characters; everything else
 * separates (checked against SQLite 3.49.2 on symbols, punctuation, emoji,
 * underscores and zero-width spaces). Used for the
 * fuzzy word list and the "has any letters or digits" test. The FTS queries
 * themselves pass the whole quoted text and let the tokenizer split it, so a
 * rare disagreement here can never produce a malformed query.
 */
const WORD_RE = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;
function words(text) {
  return String(text || '').match(WORD_RE) || [];
}

module.exports = {
  detectSearchMode, tokenizeBoolean, parseBooleanExpr, parseBoolean, words,
};
