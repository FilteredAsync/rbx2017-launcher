'use strict';

// Fills the IntValues a stored place lost to an older converter, from the
// place's original file. Newer Studio saves IntValue.Value (and the
// IntConstrainedValue numbers) as int64, which lib/placefile.js used to drop
// as unreadable, so they all loaded as 0. "Convert again" starts from the
// stored copy and cannot bring them back; this takes them from the original
// and changes nothing else: in a binary .rbxl only those values' PROP chunks
// are rewritten; an XML .rbxlx gets only those values and is then stored as
// binary like any converted place.
//
// Objects are matched by path: from the top-level services down, each step
// is (ClassName, Name, index among the siblings with that class and name).
// The converter's own changes are allowed for: a Folder can stand for an
// object of another class (misplaced Attachments and Teams, a dumped core
// UI) and a set-aside name ends in " (newer, unused)", when exactly one
// sibling in the original has that name. Objects renamed, added or copied
// since the upload have no counterpart; one removed shifts the index of its
// later same-name siblings.

const zlib = require('zlib');
const rbxbinary = require('./rbxbinary');

const { T } = rbxbinary;
const INT_CLASSES = new Set(['IntValue', 'IntConstrainedValue']);
const MAIN_VALUE = { IntValue: 'Value', IntConstrainedValue: 'value' };
const SET_ASIDE = ' (newer, unused)'; // lib/placefile.js
const ZSTD_MAGIC = 0xfd2fb528;

const clamp = (v) => Number(v < -2147483648n ? -2147483648n : v > 2147483647n ? 2147483647n : v);

// --- a place's objects ------------------------------------------------------------

// Class, name, parent and children (in file order) of every object; for the
// properties wanted(className, prop, type) asks for, their int/int64 values;
// tree.int64: every int64 property but SourceAssetId, counted ('Class.prop').
function newTree() {
  return { className: [], name: [], parent: [], children: [], roots: [], ints: new Map(), int64: new Map() };
}
function addNode(tree, className) {
  tree.className.push(className);
  tree.name.push('');
  tree.parent.push(-1);
  tree.children.push(null);
  return tree.className.length - 1;
}
function attach(tree, node, parent) {
  tree.parent[node] = parent;
  if (parent === -1) tree.roots.push(node);
  else (tree.children[parent] || (tree.children[parent] = [])).push(node);
}
function setInt(tree, node, prop, entry) {
  if (!tree.ints.has(node)) tree.ints.set(node, {});
  tree.ints.get(node)[prop] = entry;
}
function count64(tree, className, prop, nonZero) {
  if (prop === 'SourceAssetId') return;
  const key = `${className}.${prop}`;
  const entry = tree.int64.get(key) || { count: 0, nonZero: 0 };
  entry.count++;
  if (nonZero) entry.nonZero++;
  tree.int64.set(key, entry);
}

function binaryTree(bytes, wanted) {
  const model = rbxbinary.read(bytes);
  const tree = Object.assign(newTree(), { binary: true, model, classId: [], classFirst: new Map(), columnTypes: new Map() });
  const nodeOf = new Map();
  model.classes.forEach((cls, classId) => {
    if (!cls) return;
    const first = tree.className.length;
    tree.classFirst.set(classId, first);
    for (let i = 0; i < cls.count; i++) {
      const node = addNode(tree, cls.name);
      tree.classId.push(classId);
      if (!nodeOf.has(cls.refs[i])) nodeOf.set(cls.refs[i], node);
    }
    for (const prop of cls.props) {
      tree.columnTypes.set(`${cls.name}.${prop.name}`, prop.type);
      if (prop.name === 'Name' && prop.type === T.String) {
        const { d, starts, lengths } = prop.col;
        for (let i = 0; i < cls.count; i++) tree.name[first + i] = d.toString('latin1', starts[i], starts[i] + lengths[i]);
      } else if (prop.type === T.Int32 || prop.type === T.Int64) {
        const type = prop.type === T.Int64 ? 'int64' : 'int';
        if (type === 'int64') for (let i = 0; i < cls.count; i++) count64(tree, cls.name, prop.name, prop.col.v[i] !== 0n);
        if (!wanted(cls.name, prop.name, type)) continue;
        for (let i = 0; i < cls.count; i++) setInt(tree, first + i, prop.name, { type, value: BigInt(prop.col.v[i]) });
      }
    }
  });
  // The tree as lib/rbxbinary.js toXml makes it: PRNT order, the rest at the top.
  const linked = new Uint8Array(tree.className.length);
  const children = model.children || [];
  for (let k = 0; k < children.length; k++) {
    const node = nodeOf.get(children[k]);
    if (node === undefined || linked[node]) continue;
    let parent = model.parents[k] === -1 || !nodeOf.has(model.parents[k]) ? -1 : nodeOf.get(model.parents[k]);
    if (parent === node) parent = -1;
    linked[node] = 1;
    attach(tree, node, parent);
  }
  for (let node = 0; node < linked.length; node++) if (!linked[node]) attach(tree, node, -1);
  return tree;
}

// XML read byte by byte (a big place passes Node's string limit). For
// patching, an int property's element range and where an object's
// <Properties> start are kept.
function skipTo(x, text, from) {
  const at = x.indexOf(text, from, 'latin1');
  if (at < 0) throw new Error(`the XML ends early (no ${text})`);
  return at + text.length;
}

function xmlTree(x, wanted) {
  if (!/<roblox[\s>]/.test(x.toString('latin1', 0, Math.min(x.length, 512)))) throw new Error('This is not a Roblox place file (.rbxl or .rbxlx).');
  const tree = Object.assign(newTree(), { binary: false, propsAt: new Map() });
  const open = [];
  let p = 0;
  for (;;) {
    const lt = x.indexOf(0x3c, p);
    if (lt < 0) break;
    const c = x[lt + 1];
    if (c === 0x21) { p = x[lt + 2] === 0x5b ? skipTo(x, ']]>', lt) : x[lt + 2] === 0x2d ? skipTo(x, '-->', lt) : skipTo(x, '>', lt); continue; }
    if (c === 0x3f) { p = skipTo(x, '?>', lt); continue; }
    if (c === 0x2f) {
      if (x.toString('latin1', lt + 2, lt + 7) === 'Item>') open.pop();
      p = skipTo(x, '>', lt);
      continue;
    }
    const close = skipTo(x, '>', lt);
    const tag = x.toString('latin1', lt + 1, close - 1);
    p = close;
    if (/^Item(?:[\s/]|$)/.test(tag)) {
      const node = addNode(tree, rbxbinary.decodeText((/\sclass="([^"]*)"/.exec(tag) || [])[1] || 'Folder'));
      attach(tree, node, open.length > 0 ? open[open.length - 1] : -1);
      if (!tag.endsWith('/')) open.push(node);
    } else if (tag === 'Properties' && open.length > 0) {
      p = properties(x, p, tree, open[open.length - 1], wanted);
    }
  }
  return tree;
}

// The properties of one object, from p (after <Properties>) -> after </Properties>.
function properties(x, p, tree, node, wanted) {
  const className = tree.className[node];
  if (INT_CLASSES.has(className)) tree.propsAt.set(node, p);
  for (;;) {
    const lt = x.indexOf(0x3c, p);
    if (lt < 0) throw new Error('the XML ends early (in <Properties>)');
    if (x[lt + 1] === 0x2f) return skipTo(x, '>', lt);
    if (x[lt + 1] === 0x21) { p = x[lt + 2] === 0x5b ? skipTo(x, ']]>', lt) : skipTo(x, '-->', lt); continue; }
    const close = skipTo(x, '>', lt);
    const tag = x.toString('latin1', lt + 1, close - 1);
    const type = /^[^\s/]*/.exec(tag)[0];
    const name = (/\sname="([^"]*)"/.exec(tag) || [])[1];
    let body = close;
    let bodyEnd = close;
    p = close;
    if (!tag.endsWith('/')) {
      const closing = `</${type}>`;
      for (let q = close; ;) {
        const at = x.indexOf(0x3c, q);
        if (at < 0) throw new Error(`the XML ends early (no ${closing})`);
        if (x[at + 1] === 0x21 && x[at + 2] === 0x5b) { q = skipTo(x, ']]>', at); continue; }
        if (x.toString('latin1', at, at + closing.length) === closing) { bodyEnd = at; p = at + closing.length; break; }
        q = at + 1;
      }
    } else {
      body = bodyEnd;
    }
    if (name === undefined) continue;
    if (type === 'string' && name === 'Name') {
      const raw = x.toString('latin1', body, bodyEnd);
      const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(raw);
      tree.name[node] = cdata ? cdata[1] : rbxbinary.decodeText(raw);
    } else if (type === 'int' || type === 'int64') {
      let value;
      try { value = BigInt(x.toString('latin1', body, bodyEnd).trim() || '0'); } catch (error) { continue; }
      if (type === 'int64') count64(tree, className, name, value !== 0n);
      if (wanted(className, name, type)) setInt(tree, node, name, { type, value, start: lt, end: p });
    }
  }
}

function readTree(bytes, wanted) {
  return rbxbinary.isBinary(bytes) ? binaryTree(bytes, wanted) : xmlTree(bytes, wanted);
}

// --- matching -----------------------------------------------------------------------

function matcher(stored, original) {
  const kids = (tree, parent) => (parent === -1 ? tree.roots : tree.children[parent] || []);
  const keyOf = (tree, node) => `${tree.className[node]}\0${tree.name[node]}`;
  const groups = new Map(); // original parent -> key -> [children]
  const ranks = new Map();  // stored object -> index among same-key siblings
  const memo = new Map();

  function rankOf(node) {
    if (!ranks.has(node)) {
      const seen = new Map();
      for (const sibling of kids(stored, stored.parent[node])) {
        const key = keyOf(stored, sibling);
        const n = seen.get(key) || 0;
        ranks.set(sibling, n);
        seen.set(key, n + 1);
      }
    }
    return ranks.get(node) || 0;
  }

  function groupOf(parent) {
    let map = groups.get(parent);
    if (!map) {
      map = new Map();
      for (const node of kids(original, parent)) {
        const key = keyOf(original, node);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(node);
      }
      groups.set(parent, map);
    }
    return map;
  }

  // The converter's changes: a Folder for another class, a set-aside name.
  function loose(node, parent) {
    let name = stored.name[node];
    while (name.endsWith(SET_ASIDE)) name = name.slice(0, -SET_ASIDE.length);
    const className = stored.className[node];
    if (name === stored.name[node] && className !== 'Folder') return null;
    const found = kids(original, parent).filter((other) => original.name[other] === name && (className === 'Folder' || original.className[other] === className));
    return found.length === 1 ? found[0] : null;
  }

  // The original's object for a stored one, or null.
  function counterpart(node) {
    if (memo.has(node)) return memo.get(node);
    memo.set(node, null); // ends a parent loop
    const parent = stored.parent[node] === -1 ? -1 : counterpart(stored.parent[node]);
    let found = null;
    if (parent !== null) {
      const same = groupOf(parent).get(keyOf(stored, node));
      found = same && same[rankOf(node)] !== undefined ? same[rankOf(node)] : loose(node, parent);
    }
    memo.set(node, found);
    return found;
  }

  // Workspace.Factory.CloneStats.Speed; Name[2] is the second of that class and name.
  function pathOf(node) {
    const steps = [];
    for (let at = node, guard = 0; at !== -1 && guard < 10000; at = stored.parent[at], guard++) {
      const rank = rankOf(at);
      steps.push(Buffer.from(stored.name[at], 'latin1').toString('utf8') + (rank > 0 ? `[${rank + 1}]` : ''));
    }
    return steps.reverse().join('.');
  }

  return { counterpart, pathOf };
}

// --- writing the values back ---------------------------------------------------------

function unpack(bytes, p, compressed, size) {
  const start = p + 16;
  if (compressed === 0) return bytes.subarray(start, start + size);
  if (bytes.readUInt32LE(start) === ZSTD_MAGIC) return zlib.zstdDecompressSync(bytes.subarray(start, start + compressed), { maxOutputLength: size });
  return rbxbinary.lz4Decompress(bytes, start, start + compressed, size);
}

// A PROP chunk of ints for a class: its values (`current`: the old chunk's
// value bytes, or none: all 0) with the changes.
function intChunk(model, { classId, prop, values }, current) {
  const n = model.classes[classId].count;
  const ints = new Int32Array(n);
  if (current) {
    if (current.length !== 4 * n) throw new Error(`${model.classes[classId].name}.${prop} has an unexpected size`);
    for (let i = 0; i < n; i++) {
      const u = ((current[i] << 24) | (current[n + i] << 16) | (current[2 * n + i] << 8) | current[3 * n + i]) >>> 0;
      ints[i] = (u >>> 1) ^ -(u & 1);
    }
  }
  for (const [i, value] of values) ints[i] = value;
  const name = Buffer.from(prop, 'latin1');
  const o = 9 + name.length;
  const data = Buffer.alloc(o + 4 * n);
  data.writeUInt32LE(classId, 0);
  data.writeUInt32LE(name.length, 4);
  name.copy(data, 8);
  data[8 + name.length] = T.Int32;
  for (let i = 0; i < n; i++) {
    const u = ((ints[i] << 1) ^ (ints[i] >> 31)) >>> 0;
    data[o + i] = u >>> 24; data[o + n + i] = (u >>> 16) & 255; data[o + 2 * n + i] = (u >>> 8) & 255; data[o + 3 * n + i] = u & 255;
  }
  const packed = rbxbinary.lz4Compress(data);
  const head = Buffer.alloc(16);
  head.write('PROP', 0, 'latin1');
  head.writeUInt32LE(packed.length, 4);
  head.writeUInt32LE(data.length, 8);
  return Buffer.concat([head, packed]);
}

// The binary file with the changed values: their PROP chunks rewritten (or
// added before PRNT), every other byte as it was.
function patchBinary(bytes, tree, changes) {
  const chunks = new Map(); // classId \0 prop -> { classId, prop, values: index -> value }
  for (const { node, prop, value } of changes) {
    const classId = tree.classId[node];
    const key = `${classId}\0${prop}`;
    if (!chunks.has(key)) chunks.set(key, { classId, prop, values: new Map() });
    chunks.get(key).values.set(node - tree.classFirst.get(classId), value);
  }
  const out = [bytes.subarray(0, 32)];
  let p = 32;
  while (p + 16 <= bytes.length) {
    const name = bytes.toString('latin1', p, p + 4).replace(/\0+$/, '');
    const compressed = bytes.readUInt32LE(p + 4);
    const size = bytes.readUInt32LE(p + 8);
    const end = p + 16 + (compressed || size);
    let chunk = bytes.subarray(p, end);
    if (name === 'PROP') {
      const data = unpack(bytes, p, compressed, size);
      const length = data.readUInt32LE(4);
      const key = `${data.readUInt32LE(0)}\0${data.toString('latin1', 8, 8 + length)}`;
      if (chunks.has(key)) {
        chunk = intChunk(tree.model, chunks.get(key), data.subarray(9 + length));
        chunks.delete(key);
      }
    } else if (name === 'PRNT' || name === 'END') {
      for (const change of chunks.values()) out.push(intChunk(tree.model, change, null));
      chunks.clear();
    }
    out.push(chunk);
    p = end;
    if (name === 'END') break;
  }
  out.push(bytes.subarray(p));
  const result = Buffer.concat(out);

  // Read back: the same objects, the new values.
  const check = rbxbinary.read(result);
  for (const { node, prop, value } of changes) {
    const cls = check.classes[tree.classId[node]];
    const col = cls && cls.count === tree.model.classes[tree.classId[node]].count && cls.props.find((item) => item.name === prop);
    if (!col || col.col.v[node - tree.classFirst.get(tree.classId[node])] !== value) throw new Error('the changed file did not read back right');
  }
  return result;
}

// The XML with the changed values (each <int> replaced, or added first in <Properties>).
function patchXml(bytes, tree, changes) {
  const edits = changes.map(({ node, prop, value }) => {
    const text = Buffer.from(`<int name="${prop}">${value}</int>`, 'latin1');
    const old = (tree.ints.get(node) || {})[prop];
    return old ? { start: old.start, end: old.end, text } : { start: tree.propsAt.get(node), end: tree.propsAt.get(node), text };
  }).sort((a, b) => a.start - b.start);
  const parts = [];
  let p = 0;
  for (const edit of edits) {
    parts.push(bytes.subarray(p, edit.start), edit.text);
    p = edit.end;
  }
  parts.push(bytes.subarray(p));
  return Buffer.concat(parts);
}

// --- the whole job ----------------------------------------------------------------------

// stored, original: place files (Buffers; binary, zstd too, or XML) ->
// { bytes (to store; the stored file when nothing changed), notes,
//   restored: [{ path, property, value }], stillZero: [{ path, reason }],
//   otherInt64: [{ property, inOriginal, nonZero, zeroHere }] }
// otherInt64: int64 properties of the original that are int in 2017 (the
// converter keeps CharacterMesh IDs that fit), with how many are 0 in the
// stored place but not in the original; those are not restored.
function restoreValues(storedBytes, originalBytes) {
  const int2017 = (className, prop) => rbxbinary.apiType(className, prop) === 'int';
  const original = readTree(originalBytes, (className, prop, type) => INT_CLASSES.has(className) || (type === 'int64' && prop !== 'SourceAssetId' && int2017(className, prop)));
  const others = new Map(); // class -> [props]
  for (const key of original.int64.keys()) {
    const [className, prop] = key.split('.');
    if (INT_CLASSES.has(className) || !int2017(className, prop)) continue;
    if (!others.has(className)) others.set(className, []);
    others.get(className).push(prop);
  }
  const stored = readTree(storedBytes, (className, prop) => INT_CLASSES.has(className) || (others.get(className) || []).includes(prop));
  const match = matcher(stored, original);
  const otherInt64 = new Map([...others].flatMap(([className, props]) => props.map((prop) => {
    const key = `${className}.${prop}`;
    return [key, { property: key, inOriginal: original.int64.get(key).count, nonZero: original.int64.get(key).nonZero, zeroHere: 0 }];
  })));

  const restored = [];
  const stillZero = [];
  const changes = [];
  for (let node = 0; node < stored.className.length; node++) {
    const className = stored.className[node];
    if (!INT_CLASSES.has(className) && !others.has(className)) continue;
    const mine = stored.ints.get(node) || {};
    const twin = match.counterpart(node);
    const theirs = twin === null ? null : original.ints.get(twin) || {};
    const isZero = (prop) => !mine[prop] || mine[prop].value === 0n;
    if (!INT_CLASSES.has(className)) {
      for (const prop of others.get(className)) {
        if (theirs && theirs[prop] && theirs[prop].type === 'int64' && theirs[prop].value !== 0n && isZero(prop)) otherInt64.get(`${className}.${prop}`).zeroHere++;
      }
      continue;
    }
    const main = MAIN_VALUE[className];
    let mainRestored = false;
    for (const [prop, value] of Object.entries(theirs || {})) {
      if (value.type !== 'int64' || prop === 'SourceAssetId' || value.value === 0n || !isZero(prop)) continue;
      // A value the stored file keeps as another type, or with nowhere to go, stays.
      const column = stored.binary ? stored.columnTypes.get(`${className}.${prop}`) : undefined;
      if ((column !== undefined && column !== T.Int32) || (!stored.binary && !mine[prop] && !stored.propsAt.has(node))) continue;
      const int = clamp(value.value);
      changes.push({ node, prop, value: int });
      restored.push({ path: match.pathOf(node), property: prop, value: int });
      if (prop === main) mainRestored = true;
    }
    if (mainRestored || !isZero(main)) continue;
    const reason = theirs === null ? 'no counterpart' : theirs[main] && theirs[main].value !== 0n ? 'not int64 in original' : 'zero in original too';
    stillZero.push({ path: match.pathOf(node), reason });
  }

  let bytes = storedBytes;
  let notes = [];
  if (changes.length > 0) {
    if (stored.binary) bytes = patchBinary(storedBytes, stored, changes);
    else ({ bytes, notes } = rbxbinary.placeToStore(patchXml(storedBytes, stored, changes)));
  }
  return { bytes, notes, restored, stillZero, otherInt64: [...otherInt64.values()] };
}

// Lines for the version's notes.
function summary(result, fileName) {
  const lines = [`Restored ${result.restored.length} IntValue${result.restored.length === 1 ? '' : 's'} from ${fileName}`];
  const missing = result.stillZero.filter((entry) => entry.reason === 'no counterpart');
  const zero = result.stillZero.filter((entry) => entry.reason === 'zero in original too').length;
  const other = result.stillZero.length - missing.length - zero;
  if (result.stillZero.length > 0) {
    const parts = [zero > 0 ? `${zero} zero in the original too` : null, missing.length > 0 ? `${missing.length} not in the original` : null, other > 0 ? `${other} not int64 there` : null];
    lines.push(`  ${result.stillZero.length} still 0: ${parts.filter(Boolean).join(', ')}`);
    for (const entry of missing.slice(0, 10)) lines.push(`    ${entry.path}`);
    if (missing.length > 10) lines.push(`    ... and ${missing.length - 10} more`);
  }
  for (const entry of result.otherInt64) {
    if (entry.zeroHere > 0) lines.push(`  ${entry.zeroHere} ${entry.property} values are 0 here but not in the original (not restored)`);
  }
  return lines;
}

module.exports = { restoreValues, summary };
