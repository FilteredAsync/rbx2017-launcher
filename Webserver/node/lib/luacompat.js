'use strict';

// Makes scripts written for newer Roblox run on the 2017 engine (used by
// lib/placefile.js when a place is converted). The 2017 engine lacks many
// functions newer games call, and its math/table/string/os libraries are
// read-only, so they cannot be added once for every script. Instead each
// script that needs them gets:
//   - its calls rewritten: obj:GetDescendants() -> __rbx2017.GetDescendants(obj),
//     and likewise obj:HasTag/AddTag/RemoveTag/GetTags (CollectionService),
//     MarketplaceService:UserOwnsGamePassAsync (always owned: there is no
//     store) and :PromptGamePassPurchase (nothing happens), s:split(sep), and
//     button.Activated (newer than 2017 on buttons: MouseButton1Click then);
//   - local stand-ins for library members the 2017 engine lacks
//     (math.clamp/sign/round, table.find/clear/unpack/pack/create/move,
//     string.split, os.clock, Vector3.zero/one, Vector2.zero/one,
//     UDim2.fromScale/fromOffset, CFrame.lookAt, Color3.fromHex, Random),
//     each falling back to the real library for everything else;
//   - Enum.Font names the 2017 engine does not have mapped to ones it has.
// The stand-ins go at the start of line 1, so error line numbers stay right.
//
//   convertSource(text) -> { text, changes: [names] } (text unchanged: changes empty)

const fs = require('fs');
const path = require('path');

const MARK = '--[[2017]]';

// Member names the 2017 engine has (any class), from the client's API dump.
// An event no 2017 class has (e.g. MarketplaceService.PromptGamePassPurchaseFinished)
// stops a whole script at :Connect; such connections get a stand-in.
const API_DUMP = path.join(__dirname, '..', '..', '..', 'Client', 'apidump.txt');
const NEWER_EVENTS = new Set(['PromptGamePassPurchaseFinished', 'PromptBundlePurchaseFinished', 'PromptPremiumPurchaseFinished',
  'PlayerMembershipChanged', 'PromptSubscriptionPurchaseFinished', 'AttributeChanged', 'Destroying', 'PromptShown', 'PromptHidden',
  'Triggered', 'TriggerEnded', 'PlayerChatted', 'LocalToolEquipped', 'LocalToolUnequipped']);
let members2017 = null;
function unknownTo2017(name) {
  if (members2017 === null) {
    try {
      members2017 = new Set();
      for (const m of fs.readFileSync(API_DUMP, 'latin1').matchAll(/^\t(?:Property|Function|YieldFunction|Event|Callback) .*?\w+[.:](\w+)/gm)) members2017.add(m[1]);
    } catch (error) {
      members2017 = false;
    }
  }
  return members2017 ? !members2017.has(name) : NEWER_EVENTS.has(name);
}

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue']);

// Lua (and Luau) tokens with their positions; comments and spaces dropped.
function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  const longBracket = (at) => {
    // [==[ at "at" -> index after the closing ]==], or -1 if not a long bracket
    const m = /^\[(=*)\[/.exec(src.slice(at, at + 64));
    if (!m) return -1;
    const close = src.indexOf(`]${m[1]}]`, at + m[0].length);
    return close < 0 ? n : close + m[1].length + 2;
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      const end = src[i + 2] === '[' ? longBracket(i + 2) : -1;
      if (end >= 0) { i = end; continue; }
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c && !(c !== '`' && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
      tokens.push({ type: 'string', start: i, end: Math.min(n, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const end = longBracket(i);
      if (end >= 0) { tokens.push({ type: 'string', start: i, end }); i = end; continue; }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9]+)?)/.exec(src.slice(i, i + 80));
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
    const op = three === '...' || three === '//=' || three === '..=' ? three
      : ['..', '==', '~=', '<=', '>=', '::', '->', '+=', '-=', '*=', '/=', '%=', '^=', '//'].includes(two) ? two : c;
    tokens.push({ type: 'symbol', value: op, start: i, end: i + op.length });
    i += op.length;
  }
  return tokens;
}

const OPEN = { ')': '(', ']': '[', '}': '{' };
const CLOSE = { '(': ')', '[': ']', '{': '}' };

function matchBackward(tokens, index) {
  const close = tokens[index].value;
  const open = OPEN[close];
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    if (tokens[i].type !== 'symbol') continue;
    if (tokens[i].value === close) depth++;
    else if (tokens[i].value === open && --depth === 0) return i;
  }
  return -1;
}

function matchForward(tokens, index) {
  const open = tokens[index].value;
  const close = CLOSE[open];
  let depth = 0;
  for (let i = index; i < tokens.length; i++) {
    if (tokens[i].type !== 'symbol') continue;
    if (tokens[i].value === open) depth++;
    else if (tokens[i].value === close && --depth === 0) return i;
  }
  return -1;
}

// Could this token end an expression that is then called (f(...), a.b(...))?
const endsPrefix = (t) => t && (t.type === 'name' || t.type === 'string' || (t.type === 'symbol' && (t.value === ')' || t.value === ']' || t.value === '}')));

// The first token of the object in "object:Method(" (index of ':'), or -1.
function prefixStart(tokens, colon) {
  let i = colon - 1;
  while (i >= 0) {
    const t = tokens[i];
    if (t.type === 'symbol' && OPEN[t.value]) {
      const open = matchBackward(tokens, i);
      if (open < 0) return -1;
      if (t.value === ')' && !endsPrefix(tokens[open - 1])) return open; // (expression)
      i = open - 1; // call arguments or an index: the callee comes before
      continue;
    }
    if (t.type === 'string') {
      if (!endsPrefix(tokens[i - 1])) return -1;
      i--;
      continue;
    }
    if (t.type === 'name') {
      const before = tokens[i - 1];
      if (before && before.type === 'symbol' && (before.value === '.' || before.value === ':')) { i -= 2; continue; }
      return i;
    }
    return -1;
  }
  return -1;
}

function argumentCount(tokens, openParen, closeParen) {
  if (closeParen === openParen + 1) return 0;
  let count = 1;
  for (let i = openParen + 1; i < closeParen; i++) {
    const t = tokens[i];
    if (t.type === 'symbol' && CLOSE[t.value]) { i = matchForward(tokens, i); if (i < 0) return -1; continue; }
    if (t.type === 'symbol' && t.value === ',') count++;
  }
  return count;
}

// Method -> argument counts of the newer form (the 2017 CollectionService
// form of HasTag/AddTag/RemoveTag/GetTags takes one more and is left alone).
const METHODS = {
  GetDescendants: [0],
  HasTag: [1], AddTag: [1], RemoveTag: [1], GetTags: [0],
  UserOwnsGamePassAsync: [2], PromptGamePassPurchase: [2],
  split: [0, 1],
  // The 2021 collision group API -> the 2017 one (CreateCollisionGroup...).
  RegisterCollisionGroup: [1], IsCollisionGroupRegistered: [1], UnregisterCollisionGroup: [1], GetRegisteredCollisionGroups: [0],
};

// A game's own object (a table) with a method of that name keeps its method.
const own = (name, args) => `if type(o) == "table" and o.${name} then return o:${name}(${args}) end`;
const HELPERS = {
  GetDescendants: `function(o) ${own('GetDescendants', '')} local r = {} local function w(x) for _, c in ipairs(x:GetChildren()) do r[#r + 1] = c w(c) end end w(o) return r end`,
  HasTag: `function(o, t) ${own('HasTag', 't')} return game:GetService("CollectionService"):HasTag(o, t) end`,
  AddTag: `function(o, t) ${own('AddTag', 't')} game:GetService("CollectionService"):AddTag(o, t) end`,
  RemoveTag: `function(o, t) ${own('RemoveTag', 't')} game:GetService("CollectionService"):RemoveTag(o, t) end`,
  GetTags: `function(o) ${own('GetTags', '')} return game:GetService("CollectionService"):GetTags(o) end`,
  UserOwnsGamePassAsync: `function(o, u, p) ${own('UserOwnsGamePassAsync', 'u, p')} return true end`,
  PromptGamePassPurchase: `function(o, u, p) ${own('PromptGamePassPurchase', 'u, p')} end`,
  Activated: 'function(o) local ok, e = pcall(function() return o.Activated end) if ok and e then return e end return o.MouseButton1Click end',
  RegisterCollisionGroup: `function(o, n) ${own('RegisterCollisionGroup', 'n')} pcall(function() o:CreateCollisionGroup(n) end) end`,
  IsCollisionGroupRegistered: `function(o, n) ${own('IsCollisionGroupRegistered', 'n')} return (pcall(function() return o:GetCollisionGroupId(n) end)) end`,
  UnregisterCollisionGroup: `function(o, n) ${own('UnregisterCollisionGroup', 'n')} pcall(function() o:RemoveCollisionGroup(n) end) end`,
  GetRegisteredCollisionGroups: `function(o) ${own('GetRegisteredCollisionGroups', '')} return o:GetCollisionGroups() end`,
  SetCollisionGroup: 'function(p, n) pcall(function() game:GetService("PhysicsService"):SetPartCollisionGroup(p, n) end) end',
  Event: 'function(o, n) local ok, e = pcall(function() return o[n] end) if ok and e ~= nil then return e end local s = {} local c = {connected = false, Connected = false} function c:disconnect() end c.Disconnect = c.disconnect function s:connect() return c end s.Connect = s.connect s.Once = s.connect s.ConnectParallel = s.connect function s:wait() while true do wait(3600) end end s.Wait = s.wait return s end',
  split: 'function(s, sep) if type(s) ~= "string" then return s:split(sep) end sep = sep or "," local r = {} if sep == "" then for i = 1, #s do r[i] = s:sub(i, i) end return r end local i = 1 while true do local a, b = s:find(sep, i, true) if not a then r[#r + 1] = s:sub(i) return r end r[#r + 1] = s:sub(i, a - 1) i = b + 1 end end',
};

// Library members the 2017 engine lacks: library -> member -> Lua value.
const LIBRARY = {
  math: {
    clamp: 'function(x, a, b) if x < a then return a elseif x > b then return b end return x end',
    sign: 'function(x) if x > 0 then return 1 elseif x < 0 then return -1 end return 0 end',
    round: 'function(x) if x >= 0 then return math.floor(x + 0.5) end return math.ceil(x - 0.5) end',
  },
  table: {
    find: 'function(t, v, init) for i = init or 1, #t do if t[i] == v then return i end end return nil end',
    clear: 'function(t) for k in pairs(t) do t[k] = nil end end',
    unpack: 'unpack',
    pack: 'function(...) return {n = select("#", ...), ...} end',
    create: 'function(n, v) local t = {} for i = 1, n do t[i] = v end return t end',
    move: 'function(a, f, e, t, b) b = b or a if e >= f then if t > f and t <= e and a == b then for i = e - f, 0, -1 do b[t + i] = a[f + i] end else for i = 0, e - f do b[t + i] = a[f + i] end end end return b end',
  },
  string: { split: 'HELPER_split' },
  os: { clock: 'function() return tick() end' },
  Vector3: {
    zero: 'Vector3.new(0, 0, 0)', one: 'Vector3.new(1, 1, 1)',
    xAxis: 'Vector3.new(1, 0, 0)', yAxis: 'Vector3.new(0, 1, 0)', zAxis: 'Vector3.new(0, 0, 1)',
  },
  Vector2: { zero: 'Vector2.new(0, 0)', one: 'Vector2.new(1, 1)', xAxis: 'Vector2.new(1, 0)', yAxis: 'Vector2.new(0, 1)' },
  UDim2: {
    fromScale: 'function(x, y) return UDim2.new(x, 0, y, 0) end',
    fromOffset: 'function(x, y) return UDim2.new(0, x, 0, y) end',
  },
  CFrame: { lookAt: 'function(a, b) return CFrame.new(a, b) end' },
  Color3: {
    fromHex: 'function(h) h = tostring(h):gsub("#", "") return Color3.new(tonumber(h:sub(1, 2), 16) / 255, tonumber(h:sub(3, 4), 16) / 255, tonumber(h:sub(5, 6), 16) / 255) end',
  },
};

// Random did not exist yet: a stand-in on math.random.
const RANDOM = 'local Random = {new = function(seed) if seed then math.randomseed(seed) end local r = {} '
  + 'function r:NextNumber(a, b) a = a or 0 b = b or 1 return a + math.random() * (b - a) end '
  + 'function r:NextInteger(a, b) return math.random(a, b) end '
  + 'function r:NextUnitVector() local v = Vector3.new(math.random() - 0.5, math.random() - 0.5, math.random() - 0.5) if v.magnitude == 0 then return Vector3.new(1, 0, 0) end return v.unit end '
  + 'function r:Shuffle(t) for i = #t, 2, -1 do local j = math.random(1, i) t[i], t[j] = t[j], t[i] end end '
  + 'function r:Clone() return r end return r end};';

// Enum.Font names the 2017 engine lacks (it has 0-15) -> the nearest it has.
const FONTS_2017 = new Set(['Legacy', 'Arial', 'ArialBold', 'SourceSans', 'SourceSansBold', 'SourceSansLight', 'SourceSansItalic',
  'Bodoni', 'Garamond', 'Cartoon', 'Code', 'Highway', 'SciFi', 'Arcade', 'Fantasy', 'Antique']);
function fontFor(name) {
  if (/Black|Bold|Heavy|Semibold|SemiBold|Medium/.test(name)) return 'SourceSansBold';
  if (/Light|Thin/.test(name)) return 'SourceSansLight';
  if (/Italic/.test(name)) return 'SourceSansItalic';
  if (/Fredoka|Bangers|Luckiest|Cartoon|Creepster/.test(name)) return 'Cartoon';
  if (/Mono|Code|Roboto ?Mono|Ubuntu ?Mono/.test(name)) return 'Code';
  if (/Arcade|PressStart|Pixel/.test(name)) return 'Arcade';
  return 'SourceSans';
}

// Is "name" assigned or declared as a local in this script (then it is the
// script's own, not the library)?
function declaresOwn(tokens, name) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'name' || t.value !== name) continue;
    const before = tokens[i - 1];
    if (before && before.type === 'keyword' && (before.value === 'local' || before.value === 'function')) return true;
    if (before && before.type === 'symbol' && before.value === ',' ) {
      // local a, math = ...
      for (let j = i - 1; j >= 0 && tokens[j].type !== 'keyword'; j--) if (j > 0 && tokens[j - 1].type === 'keyword' && tokens[j - 1].value === 'local') return true;
    }
  }
  return false;
}

// --- Luau type annotations ---------------------------------------------------

const isSymbol = (t, value) => t && t.type === 'symbol' && t.value === value;

// Index after the type expression starting at i (or -1 if it is not one).
function skipType(tokens, i) {
  let t = tokens[i];
  if (!t) return -1;
  if (isSymbol(t, '(')) {
    const close = matchForward(tokens, i);
    if (close < 0) return -1;
    i = close + 1;
    if (isSymbol(tokens[i], '->')) return skipType(tokens, i + 1);
  } else if (isSymbol(t, '{')) {
    const close = matchForward(tokens, i);
    if (close < 0) return -1;
    i = close + 1;
  } else if (isSymbol(t, '...')) {
    i++;
    if (tokens[i] && (tokens[i].type === 'name' || isSymbol(tokens[i], '(') || isSymbol(tokens[i], '{'))) i = skipType(tokens, i);
  } else if (t.type === 'name') {
    if (t.value === 'typeof' && isSymbol(tokens[i + 1], '(')) {
      const close = matchForward(tokens, i + 1);
      if (close < 0) return -1;
      i = close + 1;
    } else {
      i++;
      while (isSymbol(tokens[i], '.') && tokens[i + 1] && tokens[i + 1].type === 'name') i += 2;
      if (isSymbol(tokens[i], '<')) {
        let depth = 0;
        for (; i < tokens.length; i++) {
          if (isSymbol(tokens[i], '<')) depth++;
          else if (isSymbol(tokens[i], '>') && --depth === 0) break;
        }
        i++;
      }
    }
  } else if (t.type === 'string' || (t.type === 'keyword' && (t.value === 'nil' || t.value === 'true' || t.value === 'false'))) {
    i++;
  } else {
    return -1;
  }
  while (isSymbol(tokens[i], '?')) i++;
  if (isSymbol(tokens[i], '|') || isSymbol(tokens[i], '&')) return skipType(tokens, i + 1);
  return i;
}

// Removes Luau type annotations (local x: T, function f(a: T): R, x :: T,
// type X = ..., function f<T>()), which Lua 5.1 cannot read.
function stripTypes(text) {
  const tokens = tokenize(text);
  const cuts = []; // [start, end) character ranges
  const cut = (fromToken, toTokenExclusive) => {
    if (toTokenExclusive > fromToken) cuts.push([tokens[fromToken].start, tokens[toTokenExclusive - 1].end]);
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // local a: T, b: U = ...
    if (t.type === 'keyword' && t.value === 'local' && tokens[i + 1] && tokens[i + 1].type === 'name') {
      let j = i + 1;
      while (tokens[j] && tokens[j].type === 'name') {
        if (isSymbol(tokens[j + 1], ':')) {
          const end = skipType(tokens, j + 2);
          if (end < 0) break;
          cut(j + 1, end);
          j = end;
        } else {
          j++;
        }
        if (isSymbol(tokens[j], ',') && tokens[j + 1] && tokens[j + 1].type === 'name') { j++; continue; }
        break;
      }
      continue;
    }
    // for i: number, v: Thing in ...
    if (t.type === 'keyword' && t.value === 'for') {
      let j = i + 1;
      while (tokens[j] && tokens[j].type === 'name') {
        if (isSymbol(tokens[j + 1], ':')) {
          const end = skipType(tokens, j + 2);
          if (end < 0) break;
          cut(j + 1, end);
          j = end;
        } else {
          j++;
        }
        if (isSymbol(tokens[j], ',') && tokens[j + 1] && tokens[j + 1].type === 'name') { j++; continue; }
        break;
      }
      continue;
    }
    // function name<T>(a: T, ...: U): R
    if (t.type === 'keyword' && t.value === 'function') {
      let j = i + 1;
      while (tokens[j] && (tokens[j].type === 'name' || isSymbol(tokens[j], '.') || isSymbol(tokens[j], ':'))) j++;
      if (isSymbol(tokens[j], '<')) {
        const start = j;
        while (tokens[j] && !isSymbol(tokens[j], '>')) j++;
        cut(start, j + 1);
        j++;
      }
      if (!isSymbol(tokens[j], '(')) continue;
      const close = matchForward(tokens, j);
      if (close < 0) continue;
      for (let k = j + 1; k < close; k++) {
        if ((tokens[k].type === 'name' || isSymbol(tokens[k], '...')) && isSymbol(tokens[k + 1], ':')) {
          const end = skipType(tokens, k + 2);
          if (end < 0 || end > close) break;
          cut(k + 1, end);
          k = end - 1;
        }
      }
      if (isSymbol(tokens[close + 1], ':')) {
        const end = skipType(tokens, close + 2);
        if (end > 0) cut(close + 1, end);
      }
      continue;
    }
    // expression :: T
    if (isSymbol(t, '::')) {
      const end = skipType(tokens, i + 1);
      if (end > 0) cut(i, end);
      continue;
    }
    // [export] type Name<T> = T (a statement: not after . or :)
    if (t.type === 'name' && (t.value === 'type' || (t.value === 'export' && tokens[i + 1] && tokens[i + 1].value === 'type'))) {
      const before = tokens[i - 1];
      if (before && (isSymbol(before, '.') || isSymbol(before, ':') || isSymbol(before, '=') || isSymbol(before, '(') || isSymbol(before, ','))) continue;
      const k = t.value === 'export' ? i + 1 : i;
      const name = tokens[k + 1];
      if (!name || name.type !== 'name') continue;
      let j = k + 2;
      if (isSymbol(tokens[j], '<')) { while (tokens[j] && !isSymbol(tokens[j], '>')) j++; j++; }
      if (!isSymbol(tokens[j], '=')) continue;
      const end = skipType(tokens, j + 1);
      if (end < 0) continue;
      cut(i, end);
      i = end - 1;
    }
  }
  if (cuts.length === 0) return text;
  cuts.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [start, end] of cuts) out = out.slice(0, start) + out.slice(end);
  return out;
}

function convertSource(source) {
  if (typeof source !== 'string' || source.startsWith(MARK)) return { text: source, changes: [] };
  let text = source;
  const changes = new Set();
  const helpers = new Set();

  // 0. Luau type annotations.
  const untyped = stripTypes(text);
  if (untyped !== text) {
    text = untyped;
    changes.add('type annotations');
  }

  // 1. object:Method(...) -> __rbx2017.Method(object, ...), one at a time
  //    (each rewrite moves text, so the tokens are read again).
  for (let guard = 0; guard < 5000; guard++) {
    const tokens = tokenize(text);
    let done = true;
    for (let i = 1; i + 2 < tokens.length; i++) {
      // button.Activated:Connect(...) -> __rbx2017.Activated(button):Connect(...)
      // (GuiButton.Activated came later; Tool.Activated is kept as it is).
      if (tokens[i].type === 'symbol' && tokens[i].value === '.' && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'Activated'
        && tokens[i + 2].type === 'symbol' && tokens[i + 2].value === ':') {
        const start = prefixStart(tokens, i);
        if (start < 0) continue;
        const object = text.slice(tokens[start].start, tokens[i].start);
        text = `${text.slice(0, tokens[start].start)}__rbx2017.Activated(${object})${text.slice(tokens[i + 1].end)}`;
        helpers.add('Activated');
        changes.add('.Activated');
        done = false;
        break;
      }
      // object.NewerEvent:Connect(...) -> __rbx2017.Event(object, "NewerEvent"):Connect(...)
      // (the real event when there is one, else a stand-in that never fires).
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && tokens[i + 1].value !== 'Activated' && isSymbol(tokens[i + 2], ':')
        && tokens[i + 3] && tokens[i + 3].type === 'name' && /^(?:connect|Connect|wait|Wait|Once|ConnectParallel)$/.test(tokens[i + 3].value)
        && unknownTo2017(tokens[i + 1].value)) {
        const start = prefixStart(tokens, i);
        if (start >= 0) {
          const object = text.slice(tokens[start].start, tokens[i].start);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.Event(${object}, "${tokens[i + 1].value}")${text.slice(tokens[i + 1].end)}`;
          helpers.add('Event');
          changes.add(`.${tokens[i + 1].value}`);
          done = false;
          break;
        }
      }
      // part.CollisionGroup = "Name" (2021) -> PhysicsService:SetPartCollisionGroup,
      // when the value is a single string or name.
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'CollisionGroup' && isSymbol(tokens[i + 2], '=')
        && tokens[i + 3] && (tokens[i + 3].type === 'string' || tokens[i + 3].type === 'name')) {
        const next = tokens[i + 4];
        const continues = next && ((next.type === 'symbol' && !['(', ')', ';', ','].includes(next.value) && next.value !== '}' && next.value !== ']') || (next.type === 'symbol' && next.value === '(')
          || (next.type === 'keyword' && (next.value === 'and' || next.value === 'or')));
        const start = continues ? -1 : prefixStart(tokens, i);
        if (start >= 0) {
          const object = text.slice(tokens[start].start, tokens[i].start);
          const value = text.slice(tokens[i + 3].start, tokens[i + 3].end);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.SetCollisionGroup(${object}, ${value})${text.slice(tokens[i + 3].end)}`;
          helpers.add('SetCollisionGroup');
          changes.add('.CollisionGroup');
          done = false;
          break;
        }
      }
      const colon = tokens[i];
      if (colon.type !== 'symbol' || colon.value !== ':') continue;
      const name = tokens[i + 1];
      const paren = tokens[i + 2];
      if (name.type !== 'name' || !METHODS[name.value] || paren.type !== 'symbol' || paren.value !== '(') continue;
      const close = matchForward(tokens, i + 2);
      if (close < 0) continue;
      const count = argumentCount(tokens, i + 2, close);
      if (!METHODS[name.value].includes(count)) continue;
      const start = prefixStart(tokens, i);
      if (start < 0) continue;
      const object = text.slice(tokens[start].start, colon.start);
      text = `${text.slice(0, tokens[start].start)}__rbx2017.${name.value}(${object}${count > 0 ? ', ' : ''}${text.slice(paren.end)}`;
      helpers.add(name.value);
      changes.add(`:${name.value}`);
      done = false;
      break;
    }
    if (done) break;
  }

  // 2. Library members the 2017 engine lacks -> local stand-ins; 3. fonts.
  const tokens = tokenize(text);
  const needed = {}; // library -> Set(member)
  let random = false;
  const fontEdits = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'name') continue;
    const before = tokens[i - 1];
    if (before && before.type === 'symbol' && (before.value === '.' || before.value === ':')) continue;
    const dot = tokens[i + 1];
    const member = tokens[i + 2];
    if (t.value === 'Enum' && dot && dot.value === '.' && member && member.value === 'Font' && tokens[i + 3] && tokens[i + 3].value === '.') {
      const font = tokens[i + 4];
      if (font && font.type === 'name' && !FONTS_2017.has(font.value)) fontEdits.push([font.start, font.end, fontFor(font.value)]);
      continue;
    }
    if (t.value === 'Random' && dot && dot.value === '.' && member && member.value === 'new') { random = true; continue; }
    if (!LIBRARY[t.value] || !dot || dot.type !== 'symbol' || dot.value !== '.' || !member || member.type !== 'name') continue;
    if (LIBRARY[t.value][member.value] === undefined) continue;
    (needed[t.value] = needed[t.value] || new Set()).add(member.value);
  }
  for (const [start, end, font] of fontEdits.reverse()) {
    text = text.slice(0, start) + font + text.slice(end);
    changes.add('Enum.Font');
  }

  const prelude = [];
  for (const [library, members] of Object.entries(needed)) {
    if (declaresOwn(tokens, library)) continue;
    const fields = [...members].map((member) => {
      changes.add(`${library}.${member}`);
      const value = LIBRARY[library][member];
      if (value.startsWith('HELPER_')) {
        helpers.add(value.slice('HELPER_'.length));
        return `${member} = __rbx2017.${value.slice('HELPER_'.length)}`;
      }
      return `${member} = ${value}`;
    });
    prelude.push(`local ${library} = setmetatable({${fields.join(', ')}}, {__index = ${library}});`);
  }
  if (random && !declaresOwn(tokens, 'Random')) {
    prelude.push(RANDOM);
    changes.add('Random');
  }
  if (helpers.size > 0) {
    prelude.unshift(`local __rbx2017 = {${[...helpers].map((name) => `${name} = ${HELPERS[name]}`).join(', ')}};`);
  }
  if (changes.size === 0) return { text: source, changes: [] };
  return { text: `${MARK} ${prelude.join(' ')} ${text}`, changes: [...changes] };
}

module.exports = { convertSource, tokenize, prefixStart, MARK };
