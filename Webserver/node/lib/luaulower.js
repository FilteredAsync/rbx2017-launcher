'use strict';

// Luau syntax the 2017 engine's Lua 5.1 cannot compile, written out in plain
// Lua 5.1 (lib/luacompat.js runs this after removing type annotations):
//   - `interpolated {strings}`     -> ("interpolated " .. tostring(strings))
//   - if c then a else b (an expression) -> ((c) and {(a)} or {(b)})[1]
//     (or (c) and (a) or (b) when every then-value is a literal)
//   - continue                     -> the loop body inside repeat ... until true;
//     continue -> break, and the loop's own break -> a flag and break
//   - a // b                       -> math.floor(a / b)
//   - x op= e that spans lines     -> x = x op (e) (one-line ones are done
//     by lib/placefile.js before)
//   - 1_000, 0b101                 -> 1000, 5
//   - "\x41", "\u{263A}", "\z"     -> decimal escapes / UTF-8 bytes
//   - @native, @checked            -> removed
//   - for k, v in t do (generalized iteration) -> for k, v in __rbx2017.Iter(t) do
// Line numbers stay as they were (lines removed inside an expression are
// added back after it).
//
//   lower(text) -> { text, changes: [names], helpers: [helper names] }

// --- tokens --------------------------------------------------------------------

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
const SYMBOLS3 = new Set(['...', '//=', '..=']);
const SYMBOLS2 = new Set(['..', '==', '~=', '<=', '>=', '::', '->', '+=', '-=', '*=', '/=', '%=', '^=', '//']);

// Index after the long bracket ([==[ ... ]==]) starting at `at`, or -1.
function longBracketEnd(src, at) {
  const m = /^\[(=*)\[/.exec(src.slice(at, at + 64));
  if (!m) return -1;
  const close = src.indexOf(`]${m[1]}]`, at + m[0].length);
  return close < 0 ? src.length : close + m[1].length + 2;
}

// Index after a quoted string starting at `at` ('...' or "...").
function quotedEnd(src, at) {
  const q = src[at];
  let j = at + 1;
  while (j < src.length && src[j] !== q && src[j] !== '\n') j = afterChar(src, j);
  return Math.min(src.length, j + 1);
}

// Index after the character (or escape) at j inside a quoted string. \z
// takes the spaces and line breaks after it (Luau), \ before a CRLF line
// break takes both.
function afterChar(src, j) {
  if (src[j] !== '\\') return j + 1;
  if (src[j + 1] === 'z') {
    let k = j + 2;
    while (k < src.length && /\s/.test(src[k])) k++;
    return k;
  }
  if (src[j + 1] === '\r' && src[j + 2] === '\n') return j + 3;
  return j + 2;
}

// An interpolated string starting at `at` (a backtick) -> { end, parts },
// parts: { lit: raw text } and { expr: raw text }.
function scanInterpolated(src, at) {
  const parts = [];
  let j = at + 1;
  let lit = '';
  while (j < src.length && src[j] !== '`') {
    if (src[j] === '\\') { lit += src.slice(j, j + 2); j += 2; continue; }
    if (src[j] === '{') {
      if (lit) parts.push({ lit });
      lit = '';
      const start = j + 1;
      let depth = 0;
      j = start;
      while (j < src.length) {
        const c = src[j];
        if (c === '"' || c === "'") { j = quotedEnd(src, j); continue; }
        if (c === '`') { j = scanInterpolated(src, j).end; continue; }
        if (c === '[') { const e = longBracketEnd(src, j); if (e >= 0) { j = e; continue; } }
        if (c === '-' && src[j + 1] === '-') { const nl = src.indexOf('\n', j); j = nl < 0 ? src.length : nl; continue; }
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) break; depth--; }
        j++;
      }
      parts.push({ expr: src.slice(start, j) });
      j++;
      continue;
    }
    lit += src[j];
    j++;
  }
  if (lit) parts.push({ lit });
  return { end: Math.min(src.length, j + 1), parts };
}

function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      const end = src[i + 2] === '[' ? longBracketEnd(src, i + 2) : -1;
      if (end >= 0) { i = end; continue; }
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '"' || c === "'") { const end = quotedEnd(src, i); tokens.push({ type: 'string', start: i, end }); i = end; continue; }
    if (c === '`') { const end = scanInterpolated(src, i).end; tokens.push({ type: 'interp', start: i, end }); i = end; continue; }
    if (c === '[') {
      const end = longBracketEnd(src, i);
      if (end >= 0) { tokens.push({ type: 'string', long: true, start: i, end }); i = end; continue; }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9_]+)?)/.exec(src.slice(i, i + 80));
      const len = m ? m[0].length : 1;
      tokens.push({ type: 'number', start: i, end: i + len });
      i += len;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const value = src.slice(i, j);
      tokens.push({ type: KEYWORDS.has(value) ? 'keyword' : 'name', value, start: i, end: j });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    const op = SYMBOLS3.has(three) ? three : SYMBOLS2.has(two) ? two : c;
    tokens.push({ type: 'symbol', value: op, start: i, end: i + op.length });
    i += op.length;
  }
  tokens.push({ type: 'eof', value: '', start: n, end: n });
  return tokens;
}

const isSym = (t, v) => t && t.type === 'symbol' && t.value === v;
const isKw = (t, v) => t && t.type === 'keyword' && t.value === v;
const CLOSE = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

function matchForward(tokens, index) {
  const open = tokens[index].value;
  const close = CLOSE.get(open);
  let depth = 0;
  for (let i = index; i < tokens.length; i++) {
    if (tokens[i].type !== 'symbol') continue;
    if (tokens[i].value === open) depth++;
    else if (tokens[i].value === close && --depth === 0) return i;
  }
  return -1;
}

function matchBackward(tokens, index) {
  const close = tokens[index].value;
  const open = close === ')' ? '(' : close === ']' ? '[' : '{';
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    if (tokens[i].type !== 'symbol') continue;
    if (tokens[i].value === close) depth++;
    else if (tokens[i].value === open && --depth === 0) return i;
  }
  return -1;
}

// Does token i start an expression (rather than a statement)? Used for `if`:
// after an operator, an opening bracket, a comma or return/and/or/not... it
// is an if-expression.
const EXPRESSION_KEYWORDS = new Set(['return', 'and', 'or', 'not', 'until', 'if', 'elseif', 'while', 'in']);
function inExpression(tokens, i) {
  const before = tokens[i - 1];
  if (!before) return false;
  if (before.type === 'keyword') return EXPRESSION_KEYWORDS.has(before.value);
  if (before.type === 'symbol') return !(before.value === ')' || before.value === ']' || before.value === '}' || before.value === ';' || before.value === '...');
  return false;
}

// --- expressions ---------------------------------------------------------------

// Binary operators: [left priority, right priority] (Lua 5.1, plus //).
const BINARY = new Map([['or', [1, 1]], ['and', [2, 2]], ['<', [3, 3]], ['>', [3, 3]], ['<=', [3, 3]], ['>=', [3, 3]], ['~=', [3, 3]], ['==', [3, 3]],
  ['..', [5, 4]], ['+', [6, 6]], ['-', [6, 6]], ['*', [7, 7]], ['/', [7, 7]], ['%', [7, 7]], ['//', [7, 7]], ['^', [10, 9]]]);
const UNARY_PRIORITY = 8;

function binaryOf(t) {
  if (!t) return null;
  if (t.type === 'keyword' && (t.value === 'and' || t.value === 'or')) return BINARY.get(t.value);
  if (t.type === 'symbol' && BINARY.has(t.value)) return BINARY.get(t.value);
  return null;
}

// Index after the block that starts after token `from` and ends with its own
// `end` (function bodies), or -1.
function blockEnd(tokens, from) {
  let depth = 1;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'keyword') continue;
    if (t.value === 'function' || t.value === 'do' || t.value === 'repeat' || (t.value === 'if' && !inExpression(tokens, i))) depth++;
    else if (t.value === 'end' || t.value === 'until') { if (--depth === 0) return i + 1; }
  }
  return -1;
}

// A parser over tokens that only finds where expressions end. `found` collects
// if-expressions and // operators it passes.
class Expressions {
  constructor(tokens) { this.tokens = tokens; this.ifs = []; this.floors = []; }

  expression(i) { return this.sub(i, 0); }

  sub(i, limit) {
    const t = this.tokens[i];
    let j;
    if ((t.type === 'keyword' && t.value === 'not') || isSym(t, '-') || isSym(t, '#')) j = this.sub(i + 1, UNARY_PRIORITY);
    else j = this.simple(i);
    if (j < 0) return -1;
    for (;;) {
      const op = binaryOf(this.tokens[j]);
      if (!op || op[0] <= limit) return j;
      const opIndex = j;
      const k = this.sub(j + 1, op[1]);
      if (k < 0) return -1;
      if (this.tokens[opIndex].value === '//') this.floors.push({ left: i, op: opIndex, end: k });
      j = k;
    }
  }

  simple(i) {
    const t = this.tokens[i];
    if (!t) return -1;
    if (t.type === 'number' || t.type === 'string' || t.type === 'interp' || isSym(t, '...')) return i + 1;
    if (t.type === 'keyword') {
      if (t.value === 'nil' || t.value === 'true' || t.value === 'false') return i + 1;
      if (t.value === 'function') return this.functionBody(i + 1);
      if (t.value === 'if') return this.ifExpression(i);
      return -1;
    }
    if (isSym(t, '{')) { const c = matchForward(this.tokens, i); return c < 0 ? -1 : c + 1; }
    return this.primary(i);
  }

  functionBody(i) {
    if (!isSym(this.tokens[i], '(')) return -1;
    const close = matchForward(this.tokens, i);
    if (close < 0) return -1;
    return blockEnd(this.tokens, close + 1);
  }

  primary(i) {
    const t = this.tokens[i];
    let j;
    if (t.type === 'name') j = i + 1;
    else if (isSym(t, '(')) { const c = matchForward(this.tokens, i); if (c < 0) return -1; j = c + 1; }
    else return -1;
    for (;;) {
      const n = this.tokens[j];
      if (isSym(n, '.') && this.tokens[j + 1].type === 'name') j += 2;
      else if (isSym(n, '[') || isSym(n, '(') || isSym(n, '{')) { const c = matchForward(this.tokens, j); if (c < 0) return -1; j = c + 1; }
      else if (n.type === 'string' || n.type === 'interp') j++;
      else if (isSym(n, ':') && this.tokens[j + 1].type === 'name') {
        const a = this.tokens[j + 2];
        if (isSym(a, '(') || isSym(a, '{')) { const c = matchForward(this.tokens, j + 2); if (c < 0) return -1; j = c + 1; }
        else if (a.type === 'string') j += 3;
        else return -1;
      } else return j;
    }
  }

  // if c then a {elseif c then a} else b
  ifExpression(i) {
    const node = { start: i, branches: [], otherwise: null, end: -1 };
    let j = i;
    for (;;) {
      const cond = this.expression(j + 1);
      if (cond < 0 || !isKw(this.tokens[cond], 'then')) return -1;
      const value = this.expression(cond + 1);
      if (value < 0) return -1;
      node.branches.push({ cond: [j + 1, cond], value: [cond + 1, value] });
      if (isKw(this.tokens[value], 'elseif')) { j = value; continue; }
      if (!isKw(this.tokens[value], 'else')) return -1;
      const last = this.expression(value + 1);
      if (last < 0) return -1;
      node.otherwise = [value + 1, last];
      node.end = last;
      this.ifs.push(node);
      return last;
    }
  }
}

// --- edits -----------------------------------------------------------------------

// Applies [start, end, text] edits (characters; none overlapping).
function applyEdits(text, edits) {
  edits.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [start, end, replacement] of edits) out = out.slice(0, start) + replacement + out.slice(end);
  return out;
}

// A replacement for text[start, end) with as many newlines as the original
// (added at the end), so later lines keep their numbers.
function keepLines(original, replacement) {
  const missing = (original.match(/\n/g) || []).length - (replacement.match(/\n/g) || []).length;
  return missing > 0 ? replacement + '\n'.repeat(missing) : replacement;
}

// Keeps only the edits not inside another one (and one of any duplicates).
function outermost(edits) {
  const unique = [...new Map(edits.map((e) => [`${e[0]}:${e[1]}`, e])).values()];
  return unique.filter((e) => !unique.some((o) => o !== e && o[0] <= e[0] && o[1] >= e[1]));
}

// Keeps only the edits with no other one inside (and one of any duplicates).
function innermost(edits) {
  const unique = [...new Map(edits.map((e) => [`${e[0]}:${e[1]}`, e])).values()];
  return unique.filter((e) => !unique.some((o) => o !== e && o[0] >= e[0] && o[1] <= e[1]));
}

// --- strings ---------------------------------------------------------------------

function utf8Escapes(code) {
  const bytes = Buffer.from(String.fromCodePoint(code), 'utf8');
  return [...bytes].map((b) => `\\${String(b).padStart(3, '0')}`).join('');
}

// Escapes Lua 5.1 lacks, in the body of a quoted string (without quotes).
function lowerEscapes(body) {
  if (!body.includes('\\')) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const next = body[i + 1];
    if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) { out += `\\${String(parseInt(body.slice(i + 2, i + 4), 16)).padStart(3, '0')}`; i += 3; continue; }
    if (next === 'u' && body[i + 2] === '{') {
      const close = body.indexOf('}', i + 3);
      const code = close > 0 ? parseInt(body.slice(i + 3, close), 16) : NaN;
      if (Number.isFinite(code) && code <= 0x10ffff) { out += utf8Escapes(code); i = close; continue; }
    }
    if (next === 'z') { let j = i + 2; while (j < body.length && /\s/.test(body[j])) j++; i = j - 1; continue; }
    out += body.slice(i, i + 2);
    i++;
  }
  return out;
}

// A literal part of an interpolated string -> a "quoted" Lua 5.1 string.
function quoteLiteral(raw) {
  let body = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      const next = raw[i + 1];
      if (next === '`' || next === '{' || next === '}') { body += next; i++; continue; }
      body += raw.slice(i, i + 2);
      i++;
      continue;
    }
    if (c === '"') { body += '\\"'; continue; }
    if (c === '\n') { body += '\\n'; continue; }
    body += c;
  }
  return `"${lowerEscapes(body)}"`;
}

function lowerInterpolated(raw) {
  const { parts } = scanInterpolated(raw, 0);
  if (parts.length === 0) return '""';
  const pieces = parts.map((p) => (p.lit !== undefined ? quoteLiteral(p.lit) : `tostring(${lowerAllInterpolated(p.expr)})`));
  return pieces.length === 1 && parts[0].lit !== undefined ? pieces[0] : `(${pieces.join(' .. ')})`;
}

function lowerAllInterpolated(text) {
  const edits = [];
  for (const t of tokenize(text)) {
    if (t.type === 'interp') {
      const original = text.slice(t.start, t.end);
      edits.push([t.start, t.end, keepLines(original, lowerInterpolated(original))]);
    }
  }
  return edits.length ? applyEdits(text, edits) : text;
}

// --- passes ------------------------------------------------------------------------

function lowerTokens(text, changes) {
  const edits = [];
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const raw = text.slice(t.start, t.end);
    if (t.type === 'number' && /_|^0[bB]/.test(raw)) {
      let value = raw.replace(/_/g, '');
      if (/^0[bB]/.test(value)) value = String(parseInt(value.slice(2), 2));
      edits.push([t.start, t.end, value]);
      changes.add('number literals');
    } else if (t.type === 'string' && !t.long && raw.includes('\\')) {
      const body = lowerEscapes(raw.slice(1, -1));
      // (line breaks a \z took go after the string, so line numbers stay)
      if (body !== raw.slice(1, -1)) { edits.push([t.start, t.end, keepLines(raw, raw[0] + body + raw[raw.length - 1])]); changes.add('string escapes'); }
    } else if (t.type === 'interp') {
      edits.push([t.start, t.end, keepLines(raw, lowerInterpolated(raw))]);
      changes.add('interpolated strings');
    } else if (isSym(t, '@') && tokens[i + 1] && (tokens[i + 1].type === 'name' || isSym(tokens[i + 1], '['))) {
      // @native / @checked / @[native, deprecated{...}] before a function
      let end = tokens[i + 1].end;
      if (isSym(tokens[i + 1], '[')) { const c = matchForward(tokens, i + 1); if (c < 0) continue; end = tokens[c].end; }
      else if (isSym(tokens[i + 2], '{')) { const c = matchForward(tokens, i + 2); if (c >= 0) end = tokens[c].end; }
      edits.push([t.start, end, '']);
      changes.add('function attributes');
    }
  }
  return edits.length ? applyEdits(text, edits) : text;
}

// Is the expression tokens[a, b) a literal that is never false or nil?
function alwaysTruthy(tokens, a, b) {
  const t = tokens[a];
  if (b === a + 1) return t.type === 'number' || t.type === 'string' || isKw(t, 'true');
  if (isSym(t, '{')) return matchForward(tokens, a) === b - 1;
  return false;
}

function lowerIfExpressions(text, changes) {
  for (let round = 0; round < 200; round++) {
    const tokens = tokenize(text);
    const parser = new Expressions(tokens);
    for (let i = 0; i < tokens.length; i++) if (isKw(tokens[i], 'if') && inExpression(tokens, i)) parser.ifExpression(i);
    if (parser.ifs.length === 0) return text;
    const src = (range) => text.slice(tokens[range[0]].start, tokens[range[1] - 1].end);
    const edits = [];
    for (const node of parser.ifs) {
      const start = tokens[node.start].start;
      const end = tokens[node.end - 1].end;
      const simple = node.branches.every((b) => alwaysTruthy(tokens, b.value[0], b.value[1]));
      let out;
      if (simple) out = `(${node.branches.map((b) => `(${src(b.cond)}) and (${src(b.value)})`).join(' or ')} or (${src(node.otherwise)}))`;
      else out = `((${node.branches.map((b) => `(${src(b.cond)}) and {(${src(b.value)})}`).join(' or ')} or {(${src(node.otherwise)})})[1])`;
      edits.push([start, end, keepLines(text.slice(start, end), out)]);
    }
    // Nested ones come out again next round.
    text = applyEdits(text, outermost(edits));
    changes.add('if-then-else expressions');
  }
  return text;
}

// The first token of the operand that ends at token `last`, going back over
// suffixes, ^ powers and unary operators (for a // b: the left operand at *
// level is found by the parser instead).
function targetStart(tokens, last) {
  let i = last;
  for (;;) {
    const t = tokens[i];
    if (!t) return -1;
    if (isSym(t, ')') || isSym(t, ']')) {
      const open = matchBackward(tokens, i);
      if (open < 0) return -1;
      const before = tokens[open - 1];
      if (isSym(t, ']') || (before && (before.type === 'name' || isSym(before, ')') || isSym(before, ']')))) { i = open - 1; continue; }
      return open;
    }
    if (t.type === 'name') {
      const before = tokens[i - 1];
      if (isSym(before, '.') || isSym(before, ':')) { i -= 2; continue; }
      return i;
    }
    return -1;
  }
}

const COMPOUND = new Map([['+=', '+'], ['-=', '-'], ['*=', '*'], ['/=', '/'], ['%=', '%'], ['^=', '^'], ['..=', '..'], ['//=', '//']]);

function lowerCompound(text, changes) {
  for (let round = 0; round < 100; round++) {
    const tokens = tokenize(text);
    const parser = new Expressions(tokens);
    const edits = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'symbol' || !COMPOUND.has(t.value)) continue;
      const start = targetStart(tokens, i - 1);
      const end = parser.expression(i + 1);
      if (start < 0 || end < 0) continue;
      const target = text.slice(tokens[start].start, tokens[i - 1].end);
      const value = text.slice(tokens[i + 1].start, tokens[end - 1].end);
      const op = COMPOUND.get(t.value);
      const out = op === '//' ? `${target} = math.floor(${target} / (${value}))` : `${target} = ${target} ${op} (${value})`;
      const from = tokens[start].start;
      const to = tokens[end - 1].end;
      edits.push([from, to, keepLines(text.slice(from, to), out)]);
    }
    // One inside another's value (a function body) comes out next round.
    const chosen = innermost(edits);
    if (chosen.length === 0) return text;
    text = applyEdits(text, chosen);
    changes.add('compound assignments');
  }
  return text;
}

// Every // in the script, through statements' expressions: the parser is run
// from each token that can start an expression after = , ( [ { return etc.
function lowerFloorDivision(text, changes) {
  for (let round = 0; round < 500; round++) {
    const tokens = tokenize(text);
    if (!tokens.some((t) => isSym(t, '//'))) return text;
    const parser = new Expressions(tokens);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const starts = (t.type === 'symbol' && ['=', '(', '[', '{', ',', '==', '~=', '<', '>', '<=', '>=', '..'].includes(t.value))
        || (t.type === 'keyword' && ['return', 'if', 'elseif', 'while', 'until', 'and', 'or', 'not', 'in'].includes(t.value));
      if (starts) parser.expression(i + 1);
    }
    const edits = parser.floors.map((n) => {
      const from = tokens[n.left].start;
      const to = tokens[n.end - 1].end;
      const left = text.slice(from, tokens[n.op - 1].end);
      const right = text.slice(tokens[n.op + 1].start, to);
      return [from, to, keepLines(text.slice(from, to), `math.floor((${left}) / (${right}))`)];
    });
    // Innermost first (a // b // c takes two rounds); partly overlapping
    // ranges cannot come from one parse, but a later round settles them.
    const chosen = innermost(edits).filter((e, k, all) => !all.some((o, m) => m < k && o[0] < e[1] && e[0] < o[1]));
    if (chosen.length === 0) return text;
    text = applyEdits(text, chosen);
    changes.add('// floor division');
  }
  return text;
}

// Loops with continue, and generalized iteration.
const ITERATOR_FUNCTIONS = /(?:^|[.:])(?:pairs|ipairs|next|gmatch|codes|gsplit)$/;

function lowerLoops(text, changes, helpers) {
  const tokens = tokenize(text);
  const stack = [];
  const loops = [];
  const edits = [];
  const statementEnd = (t) => isKw(t, 'end') || isKw(t, 'else') || isKw(t, 'elseif') || isKw(t, 'until') || isSym(t, ';') || t.type === 'eof';
  const innermostLoop = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].kind === 'function') return null;
      if (stack[k].kind === 'loop' || stack[k].kind === 'repeat') return stack[k];
    }
    return null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'name' && t.value === 'continue' && statementEnd(tokens[i + 1]) && !inExpression(tokens, i) && !isSym(tokens[i - 1], '.') && !isSym(tokens[i - 1], ':')) {
      const loop = innermostLoop();
      if (loop) loop.continues.push(i);
      continue;
    }
    if (t.type !== 'keyword') continue;
    switch (t.value) {
      case 'function': stack.push({ kind: 'function' }); break;
      case 'for': case 'while': {
        const frame = { kind: 'loop', header: true, start: i, body: -1, end: -1, breaks: [], continues: [] };
        stack.push(frame);
        if (t.value === 'for') {
          // generalized iteration: for <names> in <one expression> do
          let j = i + 1;
          while (tokens[j].type === 'name' && (isSym(tokens[j + 1], ',') || isKw(tokens[j + 1], 'in'))) { j++; if (isSym(tokens[j], ',')) j++; else break; }
          if (isKw(tokens[j], 'in')) {
            const parser = new Expressions(tokens);
            const end = parser.expression(j + 1);
            if (end > 0 && isKw(tokens[end], 'do')) {
              const expr = text.slice(tokens[j + 1].start, tokens[end - 1].end);
              const call = /^([\w.:]+)\s*\(/.exec(expr);
              const callee = call && parser.primary(j + 1) === end ? call[1] : null;
              if (!(callee && ITERATOR_FUNCTIONS.test(callee)) && !/^__rbx2017\.Iter\(/.test(expr) && expr !== 'next') {
                edits.push([tokens[j + 1].start, tokens[end - 1].end, `__rbx2017.Iter(${expr})`]);
                helpers.add('Iter');
                changes.add('generalized iteration');
              }
            }
          }
        }
        break;
      }
      case 'do': {
        const top = stack[stack.length - 1];
        if (top && top.kind === 'loop' && top.header) { top.header = false; top.body = i; } else stack.push({ kind: 'block' });
        break;
      }
      case 'if': if (!inExpression(tokens, i)) stack.push({ kind: 'block' }); break;
      case 'repeat': stack.push({ kind: 'repeat', breaks: [], continues: [] }); break;
      case 'end': case 'until': {
        const frame = stack.pop();
        if (frame && frame.kind === 'loop') { frame.end = i; loops.push(frame); }
        if (frame && frame.kind === 'repeat' && frame.continues.length) changes.add('continue in repeat (not converted)');
        break;
      }
      case 'break': { const loop = innermostLoop(); if (loop) loop.breaks.push(i); break; }
      default: break;
    }
  }
  for (const loop of loops) {
    if (loop.continues.length === 0 || loop.body < 0 || loop.end < 0) continue;
    const flag = loop.breaks.length > 0;
    edits.push([tokens[loop.body].end, tokens[loop.body].end, flag ? ' local __break2017 = false repeat' : ' repeat']);
    edits.push([tokens[loop.end].start, tokens[loop.end].start, flag ? 'until true if __break2017 then break end ' : 'until true ']);
    for (const c of loop.continues) edits.push([tokens[c].start, tokens[c].end, 'break']);
    for (const b of loop.breaks) edits.push([tokens[b].start, tokens[b].end, '__break2017 = true break']);
    changes.add('continue');
  }
  return edits.length ? applyEdits(text, edits) : text;
}

function lower(source) {
  const changes = new Set();
  const helpers = new Set();
  if (typeof source !== 'string') return { text: source, changes: [], helpers: [] };
  let text = source;
  // Quick exit: nothing Luau-only can be in the script.
  if (!/`|\bcontinue\b|\bif\b|\/\/|[-+*/%^.]=|\d_|0[bB]|\\[xuz]|@\w|\bfor\b/.test(text)) return { text, changes: [], helpers: [] };
  text = lowerTokens(text, changes);
  text = lowerIfExpressions(text, changes);
  text = lowerCompound(text, changes);
  text = lowerFloorDivision(text, changes);
  text = lowerLoops(text, changes, helpers);
  return { text, changes: [...changes], helpers: [...helpers] };
}

// a.X, b.Newer = x, y where guard("Newer") is true -> each target set on its
// own, so the newer one can be guarded alone (lib/luacompat.js does that):
// do local __m2017_1, __m2017_2 = x, y a.X = __m2017_1 b.Newer = __m2017_2 end
function guardMultipleAssignments(text, guard) {
  const tokens = tokenize(text);
  const parser = new Expressions(tokens);
  const edits = [];
  let count = 0;
  for (let i = 1; i < tokens.length; i++) {
    if (!isSym(tokens[i], '=')) continue;
    // the targets, back from =
    const targets = [];
    let end = i - 1;
    for (;;) {
      const start = targetStart(tokens, end);
      if (start < 0) break;
      targets.unshift([start, end]);
      if (!isSym(tokens[start - 1], ',')) break;
      end = start - 2;
    }
    if (targets.length < 2) continue;
    const first = targets[0][0];
    const before = tokens[first - 1];
    if (isKw(before, 'local') || isKw(before, 'for') || (before && before.type === 'symbol' && !isSym(before, ';') && !isSym(before, ')') && !isSym(before, ']'))) continue;
    const guarded = targets.map(([s, e]) => isSym(tokens[e - 1], '.') && tokens[e].type === 'name' && guard(tokens[e].value));
    if (!guarded.some(Boolean)) continue;
    // the values: expressions separated by commas
    let j = i + 1;
    for (;;) {
      const k = parser.expression(j);
      if (k < 0) { j = -1; break; }
      j = k;
      if (!isSym(tokens[j], ',')) break;
      j++;
    }
    if (j < 0) continue;
    const names = targets.map((t, n) => `__m2017_${n + 1}`);
    const values = text.slice(tokens[i + 1].start, tokens[j - 1].end);
    const sets = targets.map(([s, e], n) => `${text.slice(tokens[s].start, tokens[e].end)} = ${names[n]}`);
    const from = tokens[first].start;
    const to = tokens[j - 1].end;
    edits.push([from, to, keepLines(text.slice(from, to), `do local ${names.join(', ')} = ${values} ${sets.join(' ')} end`)]);
    count++;
    i = j - 1;
  }
  return { text: edits.length ? applyEdits(text, edits) : text, count };
}

// Luau syntax still in a script (after lower): the names of what is left.
function leftovers(text) {
  if (typeof text !== 'string') return [];
  const found = new Set();
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'interp') found.add('`interpolated strings`');
    else if (t.type === 'symbol' && COMPOUND.has(t.value)) found.add('compound assignments');
    else if (isSym(t, '//')) found.add('// floor division');
    else if (isSym(t, '::') || isSym(t, '->')) found.add('type annotations');
    else if (isKw(t, 'if') && inExpression(tokens, i)) found.add('if-then-else expressions');
    else if (t.type === 'name' && t.value === 'continue' && !inExpression(tokens, i)) {
      const next = tokens[i + 1];
      if (isKw(next, 'end') || isKw(next, 'else') || isKw(next, 'elseif') || isKw(next, 'until') || isSym(next, ';') || next.type === 'eof') found.add('continue');
    }
  }
  return [...found];
}

module.exports = { lower, leftovers, guardMultipleAssignments, tokenize, Expressions };
