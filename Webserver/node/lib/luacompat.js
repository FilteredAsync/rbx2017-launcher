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
//   - Enum.Font names the 2017 engine does not have mapped to ones it has;
//   - game:GetService("NewerService") (a service 2017 lacks, e.g.
//     VoiceChatService) -> a stand-in whose members do nothing, and newer
//     properties read with a sensible value (LocalizationService.RobloxLocaleId
//     -> "en-us"). These two also reach scripts converted before (marked).
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

// Classes the 2017 engine has (for GetService of newer services).
let classes2017 = null;
function classKnownTo2017(name) {
  if (classes2017 === null) {
    try {
      classes2017 = new Set();
      for (const m of fs.readFileSync(API_DUMP, 'latin1').matchAll(/^Class (\w+)/gm)) classes2017.add(m[1]);
    } catch (error) {
      classes2017 = false;
    }
  }
  return classes2017 ? classes2017.has(name) : true;
}

// Newer properties scripts read, and the value they get when the 2017
// engine lacks them.
const NEWER_PROPERTIES = { RobloxLocaleId: '"en-us"', PlaceholderText: '""' };
// Newer properties scripts set (x.AutoLocalize = false); on 2017 such a line
// stops the script, so the setting is skipped when the engine lacks it.
// Sound's RollOff distances fall back to their 2017 names (in the Set helper).
// TextBox.PlaceholderText/Color3 are in the 2017 RCC, but the 2017 client
// fails on any use of them ("An error occurred").
const NEWER_SETTABLE = new Set(['AutoLocalize', 'RootLocalizationTable', 'AutomaticSize', 'RichText', 'MaxVisibleGraphemes', 'LineHeight', 'Interactable',
  'RollOffMaxDistance', 'RollOffMinDistance', 'RespawnTime', 'PlaceholderText', 'PlaceholderColor3', 'DisplayName']);

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
// The last token of a simple expression starting at `at`: operands that are
// literals, (...), or names with .field, [key], (args) and :method(args)
// parts, joined by and/or/arithmetic. -1 if it does not start with one.
function simpleExpressionEnd(tokens, at) {
  const OPERATORS = new Set(['+', '-', '*', '/', '%', '^', '..']);
  let i = at;
  for (;;) {
    const t = tokens[i];
    if (!t) return -1;
    if ((t.type === 'keyword' && t.value === 'not') || isSymbol(t, '-')) { i++; continue; }
    const literal = t.type === 'number' || t.type === 'string' || (t.type === 'keyword' && ['true', 'false', 'nil'].includes(t.value));
    if (!literal && t.type !== 'name' && !isSymbol(t, '(')) return -1;
    if (isSymbol(t, '(')) { i = matchForward(tokens, i); if (i < 0) return -1; }
    if (!literal) {
      for (;;) {
        const n = tokens[i + 1];
        if (isSymbol(n, '.') && tokens[i + 2] && tokens[i + 2].type === 'name') i += 2;
        else if (isSymbol(n, '(') || isSymbol(n, '[')) { i = matchForward(tokens, i + 1); if (i < 0) return -1; }
        else if (isSymbol(n, ':') && tokens[i + 2] && tokens[i + 2].type === 'name' && isSymbol(tokens[i + 3], '(')) { i = matchForward(tokens, i + 3); if (i < 0) return -1; }
        else break;
      }
    }
    const next = tokens[i + 1];
    const joined = next && ((next.type === 'keyword' && (next.value === 'and' || next.value === 'or')) || (next.type === 'symbol' && OPERATORS.has(next.value)));
    if (!joined) return i;
    i += 2;
  }
}

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

// Tags on 2017 clients. The 2017 client has no CollectionService tags (the
// server does), so a game whose client scripts look up tagged things
// (Jailbreak: doors, hatches, triggers) stopped there. Every AddTag also
// records the instance in ReplicatedStorage.__2017Tags.<tag> (ObjectValues,
// made by the server, so they reach every client); where the engine's own
// tag functions fail, these helpers read that instead. The real API is
// called as cs.Name(cs, ...), so these helpers never match the rewrites.
const TAG_REGISTRY = 'local function reg(t, make) local rs = game:GetService("ReplicatedStorage") local root = rs:FindFirstChild("__2017Tags") '
  + 'if not root and make then root = Instance.new("Folder") root.Name = "__2017Tags" root.Parent = rs end local f = root and root:FindFirstChild(t) '
  + 'if not f and root and make then f = Instance.new("Folder") f.Name = t f.Parent = root end return f end';
const TAG_SIGNAL = (event) => `${TAG_REGISTRY} local s = {} function s:connect(fn) local live = true `
  + `local function hook(f) f.${event}:connect(function(v) if not live then return end local n = 0 while not v.Value and n < 50 do wait(0.1) n = n + 1 end if live and v.Value then fn(v.Value) end end) end `
  + 'local f = reg(t) if f then hook(f) else spawn(function() local g = reg(t) while not g and live do wait(1) g = reg(t) end if g and live then hook(g) end end) end '
  + 'local c = {connected = true} function c:disconnect() live = false c.connected = false end c.Disconnect = c.disconnect return c end s.Connect = s.connect '
  + `function s:wait() local f = reg(t) while not f do wait(1) f = reg(t) end local v = f.${event}:wait() while not v.Value do wait(0.1) end return v.Value end s.Wait = s.wait return s`;
const TAG_BODIES = {
  HasTag: `local ok, r = pcall(function() return cs.HasTag(cs, o, t) end) if ok then return r end ${TAG_REGISTRY} local f = reg(t) `
    + 'if f then for _, v in ipairs(f:GetChildren()) do if v.Value == o then return true end end end return false',
  AddTag: `pcall(function() cs.AddTag(cs, o, t) end) ${TAG_REGISTRY} pcall(function() local f = reg(t, true) for _, v in ipairs(f:GetChildren()) do if v.Value == o then return end end `
    + 'local v = Instance.new("ObjectValue") v.Name = "Tagged" v.Value = o v.Parent = f o.AncestryChanged:connect(function() if not o:IsDescendantOf(game) then v:Destroy() end end) end)',
  RemoveTag: `pcall(function() cs.RemoveTag(cs, o, t) end) ${TAG_REGISTRY} local f = reg(t) if f then for _, v in ipairs(f:GetChildren()) do if v.Value == o then v:Destroy() end end end`,
  GetTags: 'local ok, r = pcall(function() return cs.GetTags(cs, o) end) if ok then return r end local list = {} local root = game:GetService("ReplicatedStorage"):FindFirstChild("__2017Tags") '
    + 'if root then for _, f in ipairs(root:GetChildren()) do for _, v in ipairs(f:GetChildren()) do if v.Value == o then list[#list + 1] = f.Name break end end end end return list',
  GetTagged: `local ok, r = pcall(function() return cs.GetTagged(cs, t) end) if ok then return r end ${TAG_REGISTRY} local list = {} local f = reg(t) `
    + 'if f then for _, v in ipairs(f:GetChildren()) do if v.Value then list[#list + 1] = v.Value end end end return list',
  GetInstanceAddedSignal: `local ok, r = pcall(function() return cs.GetInstanceAddedSignal(cs, t) end) if ok and r then return r end ${TAG_SIGNAL('ChildAdded')}`,
  GetInstanceRemovedSignal: `local ok, r = pcall(function() return cs.GetInstanceRemovedSignal(cs, t) end) if ok and r then return r end ${TAG_SIGNAL('ChildRemoved')}`,
};
// Newer methods with stand-ins: name -> the argument counts they take.
// (Raycast and PreloadAsync: workspace:Raycast(origin, direction, params),
// ContentProvider:PreloadAsync(instances or ids, callback).)
const NEWER_METHODS = { PivotTo: [1], GetPivot: [0], Raycast: [2, 3], PreloadAsync: [1, 2] };
// CFrame methods with capitals (2019); 2017 has them in lower case
// (inverse, toObjectSpace...), GetComponents as components.
const CFRAME_METHODS = new Set(['PointToObjectSpace', 'PointToWorldSpace', 'VectorToObjectSpace', 'VectorToWorldSpace',
  'ToObjectSpace', 'ToWorldSpace', 'Inverse', 'GetComponents', 'ToEulerAnglesXYZ', 'ToEulerAnglesYXZ', 'ToAxisAngle', 'ToOrientation']);
// CFrame members newer than 2017 (it has lookVector and p): read through a
// stand-in. Position and Rotation only where the object is named like a CFrame.
// (2017 has lookVector but not rightVector/upVector either.)
const CFRAME_MEMBERS = new Set(['LookVector', 'RightVector', 'UpVector', 'rightVector', 'upVector', 'XVector', 'YVector', 'ZVector']);
const CFRAME_NAME = /cframe$|cf$/i;
const CFRAME_NAMED_MEMBERS = new Set(['Position', 'Rotation']);

// CollectionService:Name(...) with this many arguments -> __rbx2017.CSName(service, ...).
const CS_METHODS = { HasTag: 2, AddTag: 2, RemoveTag: 2, GetTags: 1, GetTagged: 1, GetInstanceAddedSignal: 1, GetInstanceRemovedSignal: 1 };
const CS_PARAMS = { HasTag: 'cs, o, t', AddTag: 'cs, o, t', RemoveTag: 'cs, o, t', GetTags: 'cs, o', GetTagged: 'cs, t', GetInstanceAddedSignal: 'cs, t', GetInstanceRemovedSignal: 'cs, t' };
const HELPERS = {
  GetDescendants: `function(o) ${own('GetDescendants', '')} local r = {} local function w(x) for _, c in ipairs(x:GetChildren()) do r[#r + 1] = c w(c) end end w(o) return r end`,
  HasTag: `function(o, t) ${own('HasTag', 't')} local cs = game:GetService("CollectionService") ${TAG_BODIES.HasTag} end`,
  AddTag: `function(o, t) ${own('AddTag', 't')} local cs = game:GetService("CollectionService") ${TAG_BODIES.AddTag} end`,
  RemoveTag: `function(o, t) ${own('RemoveTag', 't')} local cs = game:GetService("CollectionService") ${TAG_BODIES.RemoveTag} end`,
  GetTags: `function(o) ${own('GetTags', '')} local cs = game:GetService("CollectionService") ${TAG_BODIES.GetTags} end`,
  ...Object.fromEntries(Object.keys(CS_METHODS).map((name) => [`CS${name}`, `function(${CS_PARAMS[name]}) ${TAG_BODIES[name]} end`])),
  UserOwnsGamePassAsync: `function(o, u, p) ${own('UserOwnsGamePassAsync', 'u, p')} return true end`,
  PromptGamePassPurchase: `function(o, u, p) ${own('PromptGamePassPurchase', 'u, p')} end`,
  Activated: 'function(o) local ok, e = pcall(function() return o.Activated end) if ok and e then return e end return o.MouseButton1Click end',
  RegisterCollisionGroup: `function(o, n) ${own('RegisterCollisionGroup', 'n')} pcall(function() o:CreateCollisionGroup(n) end) end`,
  IsCollisionGroupRegistered: `function(o, n) ${own('IsCollisionGroupRegistered', 'n')} return (pcall(function() return o:GetCollisionGroupId(n) end)) end`,
  UnregisterCollisionGroup: `function(o, n) ${own('UnregisterCollisionGroup', 'n')} pcall(function() o:RemoveCollisionGroup(n) end) end`,
  GetRegisteredCollisionGroups: `function(o) ${own('GetRegisteredCollisionGroups', '')} return o:GetCollisionGroups() end`,
  SetCollisionGroup: 'function(p, n) pcall(function() game:GetService("PhysicsService"):SetPartCollisionGroup(p, n) end) end',
  Event: 'function(o, n) local ok, e = pcall(function() return o[n] end) if ok and e ~= nil then return e end local s = {} local c = {connected = false, Connected = false} function c:disconnect() end c.Disconnect = c.disconnect function s:connect() return c end s.Connect = s.connect s.Once = s.connect s.ConnectParallel = s.connect function s:wait() while true do wait(3600) end end s.Wait = s.wait return s end',
  Service: 'function(o, n) local ok, s = pcall(function() return o:GetService(n) end) if ok and s then return s end local x x = setmetatable({}, {__index = function() return x end, __call = function() return nil end}) return x end',
  Prop: 'function(o, n, d) local ok, v = pcall(function() return o[n] end) if ok and v ~= nil then return v end return d end',
  Set: 'function(o, n, v) if pcall(function() o[n] = v end) then return end '
    + 'local a = ({RollOffMaxDistance = "MaxDistance", RollOffMinDistance = "EmitterSize"})[n] if a then pcall(function() o[a] = v end) end end',
  // CFrame methods with capitals -> the 2017 lower-case ones (tables keep their own).
  CFCall: 'function(x, n, ...) if type(x) == "table" then return x[n](x, ...) end '
    + 'local m = n == "GetComponents" and "components" or n == "ToOrientation" and "toEulerAnglesYXZ" or n:sub(1, 1):lower() .. n:sub(2) return x[m](x, ...) end',
  // Humanoid.RootPart (2018): the character's HumanoidRootPart (or Torso).
  RootPart: 'function(h) local ok, v = pcall(function() return h.RootPart end) if ok then return v end '
    + 'local c = h.Parent return c and (c:FindFirstChild("HumanoidRootPart") or c:FindFirstChild("Torso")) end',
  DisplayName: 'function(p) local ok, v = pcall(function() return p.DisplayName end) if ok then return v end return p.Name end',
  // workspace:Raycast and RaycastParams (2020) on FindPartOnRay.
  RaycastParams: 'function() return {FilterDescendantsInstances = {}, FilterType = "Exclude", IgnoreWater = false, CollisionGroup = "Default", RespectCanCollide = false} end',
  Raycast: 'function(w, origin, dir, params) if type(w) == "table" then return w.Raycast(w, origin, dir, params) end local list, include, water = {}, false, false '
    + 'if params then list = params.FilterDescendantsInstances or {} include = params.FilterType == "Include" or params.FilterType == "Whitelist" water = params.IgnoreWater and true or false end '
    + 'local ray, part, pos, normal, material = Ray.new(origin, dir) '
    + 'if include then part, pos, normal, material = w:FindPartOnRayWithWhitelist(ray, list, water) else part, pos, normal, material = w:FindPartOnRayWithIgnoreList(ray, list, false, water) end '
    + 'if part then return {Instance = part, Position = pos, Normal = normal, Material = material, Distance = (pos - origin).magnitude} end return nil end',
  // ContentProvider:PreloadAsync with instances (2017 takes only content ids).
  PreloadAsync: 'function(cp, list, cb) if type(cp) == "table" then return cp.PreloadAsync(cp, list, cb) end local ids = {} '
    + 'local P = {Sound = "SoundId", Decal = "Texture", Texture = "Texture", ImageLabel = "Image", ImageButton = "Image", Animation = "AnimationId", MeshPart = "MeshId", '
    + 'SpecialMesh = "MeshId", Shirt = "ShirtTemplate", Pants = "PantsTemplate", ParticleEmitter = "Texture"} '
    + 'local function add(x) if type(x) == "string" then ids[#ids + 1] = x return end local ok, c = pcall(function() return x.ClassName end) if not ok then return end '
    + 'local v = P[c] and x[P[c]] if type(v) == "string" and v ~= "" then ids[#ids + 1] = v end for _, k in ipairs(x:GetChildren()) do add(k) end end '
    + 'for _, x in ipairs(list) do add(x) end if #ids > 0 then pcall(function() cp.PreloadAsync(cp, ids) end) end if cb then for _, id in ipairs(ids) do pcall(cb, id) end end end',
  // Model/BasePart:PivotTo and :GetPivot (2021).
  PivotTo: 'function(o, cf) if pcall(function() o.PivotTo(o, cf) end) then return end if o:IsA("BasePart") then o.CFrame = cf return end '
    + 'if o.PrimaryPart then o:SetPrimaryPartCFrame(cf) return end local d = cf * o:GetModelCFrame():inverse() '
    + 'local function w(x) for _, c in ipairs(x:GetChildren()) do if c:IsA("BasePart") then c.CFrame = d * c.CFrame end w(c) end end w(o) end',
  GetPivot: 'function(o) local ok, v = pcall(function() return o.GetPivot(o) end) if ok and v then return v end if o:IsA("BasePart") then return o.CFrame end '
    + 'if o.PrimaryPart then return o.PrimaryPart.CFrame end return o:GetModelCFrame() end',
  CFMember: 'function(x, n) local ok, v = pcall(function() return x[n] end) if ok then return v end '
    + 'if n == "Position" then return x.p end if n == "Rotation" then return x - x.p end if n == "LookVector" then return x.lookVector end '
    + 'if n == "ZVector" then return -x.lookVector end '
    + 'if n == "RightVector" or n == "rightVector" or n == "XVector" then return x:vectorToWorldSpace(Vector3.new(1, 0, 0)) end '
    + 'if n == "UpVector" or n == "upVector" or n == "YVector" then return x:vectorToWorldSpace(Vector3.new(0, 1, 0)) end error(v, 2) end',
  // Attachment.WorldCFrame (newer): from the attachment's CFrame on its part.
  WorldCF: 'function(a) local ok, v = pcall(function() return a["WorldCFrame"] end) if ok and v then return v end local p = a.Parent if p and p:IsA("BasePart") then return p.CFrame * a.CFrame end return CFrame.new(a.WorldPosition) end',
  SetWorldCF: 'function(a, cf) if pcall(function() a["WorldCFrame"] = cf end) then return end local p = a.Parent if p and p:IsA("BasePart") then a.CFrame = p.CFrame:inverse() * cf end end',
  GetTranslator: 'function(f, n, l) local ok, t = pcall(f) if ok and t then local ok2, tr = pcall(function() return t.GetTranslator(t, l) end) if ok2 and tr then return tr end end '
    + 'local strings = {} local folder = game:GetService("ReplicatedStorage"):FindFirstChild("LocalizationTables (2017)") local m = folder and n and folder:FindFirstChild(n) '
    + 'if m then local ok3, r = pcall(require, m) if ok3 and type(r) == "table" then strings = r end end local tr = {LocaleId = l or "en-us"} '
    + 'function tr:FormatByKey(key, args) local s = strings[key] if s == nil then error("Translator: no text for key " .. tostring(key), 2) end '
    + 'if type(args) == "table" then s = s:gsub("{([%w_]+)}", function(k) local v = args[k] if v == nil then v = args[tonumber(k)] end if v ~= nil then return tostring(v) end end) end return s end '
    + 'function tr:Translate(context, text) return text end tr.formatByKey = tr.FormatByKey return tr end',
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
function declaresOwn(tokens, name, from = 0) {
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'name' || t.value !== name) continue;
    if (isSymbol(tokens[i + 1], '.') || isSymbol(tokens[i + 1], ':')) continue; // math.floor: a use
    let j = i - 1;
    // Back over "a, b," of a name list (local a, math = ... / for k, math in / function(a, math)).
    while (j > 0 && isSymbol(tokens[j], ',') && tokens[j - 1].type === 'name') j -= 2;
    const before = tokens[j];
    if (!before) continue;
    if (before.type === 'keyword' && (before.value === 'local' || before.value === 'for' || (before.value === 'function' && j === i - 1))) return true;
    if (isSymbol(before, '(')) {
      // function(math) / function a.b:c(math)
      let k = j - 1;
      while (k > 0 && tokens[k].type === 'name' && (isSymbol(tokens[k - 1], '.') || isSymbol(tokens[k - 1], ':'))) k -= 2;
      if (tokens[k] && tokens[k].type === 'name') k--;
      if (tokens[k] && tokens[k].type === 'keyword' && tokens[k].value === 'function') return true;
    }
  }
  return false;
}

// Where the stand-ins at the top of a script converted before end (the
// token index of its own first token): the helper table, library tables and
// the Random stand-in.
function preludeEnd(tokens) {
  let k = 0;
  for (;;) {
    const t = tokens[k];
    if (!t || t.type !== 'keyword' || t.value !== 'local' || !tokens[k + 1] || tokens[k + 1].type !== 'name' || !isSymbol(tokens[k + 2], '=')) return k;
    const name = tokens[k + 1].value;
    let close = -1;
    if ((name === '__rbx2017' || name === 'Random') && isSymbol(tokens[k + 3], '{')) close = matchForward(tokens, k + 3);
    else if (LIBRARY[name] && tokens[k + 3] && tokens[k + 3].value === 'setmetatable' && isSymbol(tokens[k + 4], '(')) close = matchForward(tokens, k + 4);
    if (close < 0) return k;
    k = close + 1;
    if (isSymbol(tokens[k], ';')) k++;
  }
}

// Does the prelude text already give library.member a stand-in?
function hasStandIn(prelude, library, member) {
  const head = `local ${library} = setmetatable({`;
  const tail = `}, {__index = ${library}});`;
  for (let at = prelude.indexOf(head); at >= 0; at = prelude.indexOf(head, at + 1)) {
    const end = prelude.indexOf(tail, at);
    const fields = prelude.slice(at + head.length, end < 0 ? prelude.length : end);
    if (new RegExp(String.raw`(^|[{,]\s*)${member} = `).test(fields)) return true;
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
  if (typeof source !== 'string') return { text: source, changes: [] };
  // A script converted before gets only the rewrites added since (newer
  // services and properties); everything else was done then.
  const marked = source.startsWith(MARK);
  let text = source;
  const changes = new Set();
  const helpers = new Set();

  // 0. Luau type annotations.
  const untyped = marked ? text : stripTypes(text);
  if (untyped !== text) {
    text = untyped;
    changes.add('type annotations');
  }
  // attachment.WorldCFrame = expression (a whole line) -> __rbx2017.SetWorldCF(attachment, expression).
  text = text.split('\n').map((line) => {
    const m = /^(\s*)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^[\]\n]+\])*)\.WorldCFrame\s*=\s*([^=].*?)\s*(\r?)$/.exec(line);
    if (!m || m[3].includes('--') || m[3].includes(';') || /\b(?:then|do|end|local)\b/.test(m[3])) return line;
    helpers.add('SetWorldCF');
    changes.add('.WorldCFrame =');
    return `${m[1]}__rbx2017.SetWorldCF(${m[2]}, ${m[3]})${m[4]}`;
  }).join('\n');

  // 1. object:Method(...) -> __rbx2017.Method(object, ...), one at a time
  //    (each rewrite moves text, so the tokens are read again).
  for (let guard = 0; guard < 5000; guard++) {
    const tokens = tokenize(text);
    // An end marker, so the patterns see the last tokens of the script too.
    tokens.push({ type: 'eof', value: '', start: text.length, end: text.length });
    // A script converted before: its helper table is left as it is.
    let helpersEnd = 0;
    if (marked && tokens[0] && tokens[0].value === 'local' && tokens[1] && tokens[1].value === '__rbx2017' && isSymbol(tokens[2], '=') && isSymbol(tokens[3], '{')) {
      const close = matchForward(tokens, 3);
      if (close >= 0) helpersEnd = tokens[close].end;
    }
    let done = true;
    for (let i = 1; i + 2 < tokens.length; i++) {
      if (tokens[i].start < helpersEnd) continue;
      // CollectionService:HasTag(o, t) etc. -> __rbx2017.CSHasTag(service, o, t): tags on 2017 clients.
      if (isSymbol(tokens[i], ':') && tokens[i + 1].type === 'name' && CS_METHODS[tokens[i + 1].value] !== undefined && isSymbol(tokens[i + 2], '(')) {
        const close = matchForward(tokens, i + 2);
        const start = close >= 0 && argumentCount(tokens, i + 2, close) === CS_METHODS[tokens[i + 1].value] ? prefixStart(tokens, i) : -1;
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          const name = tokens[i + 1].value;
          text = `${text.slice(0, tokens[start].start)}__rbx2017.CS${name}(${object}, ${text.slice(tokens[i + 2].end)}`;
          helpers.add(`CS${name}`);
          changes.add(`CollectionService:${name}`);
          done = false;
          break;
        }
      }
      // x:GetService("NewerService") -> __rbx2017.Service(x, "NewerService").
      if (isSymbol(tokens[i], ':') && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'GetService' && isSymbol(tokens[i + 2], '(')
        && tokens[i + 3] && tokens[i + 3].type === 'string' && isSymbol(tokens[i + 4], ')')) {
        const literal = /^(["'])(\w+)\1$/.exec(text.slice(tokens[i + 3].start, tokens[i + 3].end));
        const start = literal && !classKnownTo2017(literal[2]) ? prefixStart(tokens, i) : -1;
        if (start >= 0) {
          const object = text.slice(tokens[start].start, tokens[i].start);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.Service(${object}, "${literal[2]}")${text.slice(tokens[i + 4].end)}`;
          helpers.add('Service');
          changes.add(`GetService("${literal[2]}")`);
          done = false;
          break;
        }
      }
      // x.NewerProperty (read) -> __rbx2017.Prop(x, "NewerProperty", value).
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && NEWER_PROPERTIES[tokens[i + 1].value] !== undefined && !isSymbol(tokens[i + 2], '=')) {
        const start = prefixStart(tokens, i);
        if (start >= 0) {
          const object = text.slice(tokens[start].start, tokens[i].start);
          const name = tokens[i + 1].value;
          text = `${text.slice(0, tokens[start].start)}__rbx2017.Prop(${object}, "${name}", ${NEWER_PROPERTIES[name]})${text.slice(tokens[i + 1].end)}`;
          helpers.add('Prop');
          changes.add(`.${name}`);
          done = false;
          break;
        }
      }
      // model:PivotTo(cf) / model:GetPivot() -> __rbx2017.PivotTo(model, cf) / __rbx2017.GetPivot(model).
      if (isSymbol(tokens[i], ':') && tokens[i + 1].type === 'name' && NEWER_METHODS[tokens[i + 1].value] !== undefined && isSymbol(tokens[i + 2], '(')) {
        const close = matchForward(tokens, i + 2);
        const count = close >= 0 ? argumentCount(tokens, i + 2, close) : -1;
        const start = NEWER_METHODS[tokens[i + 1].value].includes(count) ? prefixStart(tokens, i) : -1;
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          const name = tokens[i + 1].value;
          text = `${text.slice(0, tokens[start].start)}__rbx2017.${name}(${object}${count > 0 ? ', ' : ''}${text.slice(tokens[i + 2].end)}`;
          helpers.add(name);
          changes.add(`:${name}`);
          done = false;
          break;
        }
      }
      // cf:Inverse() / cf:PointToObjectSpace(v) -> __rbx2017.CFCall(cf, "Inverse") / (cf, "PointToObjectSpace", v).
      if (isSymbol(tokens[i], ':') && tokens[i + 1].type === 'name' && CFRAME_METHODS.has(tokens[i + 1].value) && isSymbol(tokens[i + 2], '(')) {
        const start = prefixStart(tokens, i);
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          const name = tokens[i + 1].value;
          text = `${text.slice(0, tokens[start].start)}__rbx2017.CFCall(${object}, "${name}"${isSymbol(tokens[i + 3], ')') ? '' : ', '}${text.slice(tokens[i + 2].end)}`;
          helpers.add('CFCall');
          changes.add(`CFrame:${name}`);
          done = false;
          break;
        }
      }
      // humanoid.RootPart (read; 2018) -> __rbx2017.RootPart(humanoid); player.DisplayName (2020; on
      // 2017 only Roblox's own scripts may read it) -> __rbx2017.DisplayName(player): the name.
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && (tokens[i + 1].value === 'RootPart' || tokens[i + 1].value === 'DisplayName') && !isSymbol(tokens[i + 2], '=') && !isSymbol(tokens[i + 2], '(')) {
        const start = prefixStart(tokens, i);
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          const name = tokens[i + 1].value;
          text = `${text.slice(0, tokens[start].start)}__rbx2017.${name}(${object})${text.slice(tokens[i + 1].end)}`;
          helpers.add(name);
          changes.add(name === 'RootPart' ? 'Humanoid.RootPart' : '.DisplayName');
          done = false;
          break;
        }
      }
      // RaycastParams.new() -> __rbx2017.RaycastParams(); Enum.RaycastFilterType.Exclude -> "Exclude".
      if (tokens[i].type === 'name' && tokens[i].value === 'RaycastParams' && !isSymbol(tokens[i - 1], '.') && !isSymbol(tokens[i - 1], ':')
        && isSymbol(tokens[i + 1], '.') && tokens[i + 2].value === 'new' && isSymbol(tokens[i + 3], '(') && isSymbol(tokens[i + 4], ')')) {
        text = `${text.slice(0, tokens[i].start)}__rbx2017.RaycastParams()${text.slice(tokens[i + 4].end)}`;
        helpers.add('RaycastParams');
        changes.add('RaycastParams.new');
        done = false;
        break;
      }
      if (tokens[i].type === 'name' && tokens[i].value === 'Enum' && !isSymbol(tokens[i - 1], '.') && isSymbol(tokens[i + 1], '.') && tokens[i + 2].value === 'RaycastFilterType'
        && isSymbol(tokens[i + 3], '.') && tokens[i + 4] && tokens[i + 4].type === 'name') {
        text = `${text.slice(0, tokens[i].start)}"${tokens[i + 4].value}"${text.slice(tokens[i + 4].end)}`;
        changes.add('Enum.RaycastFilterType');
        done = false;
        break;
      }
      // cf.LookVector / someCFrame.Position (read) -> __rbx2017.CFMember(cf, "LookVector").
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && !isSymbol(tokens[i + 2], '=') && !isSymbol(tokens[i + 2], '(') && !isSymbol(tokens[i + 2], ':')
        && (CFRAME_MEMBERS.has(tokens[i + 1].value) || (CFRAME_NAMED_MEMBERS.has(tokens[i + 1].value) && tokens[i - 1] && tokens[i - 1].type === 'name' && CFRAME_NAME.test(tokens[i - 1].value)))) {
        const start = prefixStart(tokens, i);
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.CFMember(${object}, "${tokens[i + 1].value}")${text.slice(tokens[i + 1].end)}`;
          helpers.add('CFMember');
          changes.add(`CFrame.${tokens[i + 1].value}`);
          done = false;
          break;
        }
      }
      // attachment.WorldCFrame (read) -> __rbx2017.WorldCF(attachment).
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'WorldCFrame' && !isSymbol(tokens[i + 2], '=')) {
        const start = prefixStart(tokens, i);
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.WorldCF(${object})${text.slice(tokens[i + 1].end)}`;
          helpers.add('WorldCF');
          changes.add('.WorldCFrame');
          done = false;
          break;
        }
      }
      // x.NewerProperty = value (one token) -> __rbx2017.Set(x, "NewerProperty", value).
      // The value may be simple operands (literals, a.b.c) joined by and/or/arithmetic.
      const valueEnd = isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && NEWER_SETTABLE.has(tokens[i + 1].value) && isSymbol(tokens[i + 2], '=')
        ? simpleExpressionEnd(tokens, i + 3) : -1;
      if (valueEnd > 0) {
        const next = tokens[valueEnd + 1];
        const ends = !next || next.type === 'eof' || (next.type === 'keyword' && next.value !== 'and' && next.value !== 'or') || next.type === 'name' || isSymbol(next, ';');
        const start = ends ? prefixStart(tokens, i) : -1;
        if (start >= 0) {
          const object = text.slice(tokens[start].start, tokens[i].start);
          const value = text.slice(tokens[i + 3].start, tokens[valueEnd].end);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.Set(${object}, "${tokens[i + 1].value}", ${value})${text.slice(tokens[valueEnd].end)}`;
          helpers.add('Set');
          changes.add(`.${tokens[i + 1].value} =`);
          done = false;
          break;
        }
      }
      // table:GetTranslator(locale) (2018) -> __rbx2017.GetTranslator(function() return table end,
      // "TableName", locale): the real translator when there is one, else one
      // reading the table's text from ReplicatedStorage (lib/placefile.js).
      if (isSymbol(tokens[i], ':') && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'GetTranslator' && isSymbol(tokens[i + 2], '(')) {
        const close = matchForward(tokens, i + 2);
        const start = close >= 0 ? prefixStart(tokens, i) : -1;
        if (start >= 0) {
          let name = 'nil';
          const last = tokens[i - 1];
          if (isSymbol(last, ']') && tokens[i - 2] && tokens[i - 2].type === 'string' && isSymbol(tokens[i - 3], '[')) name = text.slice(tokens[i - 2].start, tokens[i - 2].end);
          else if (last && last.type === 'name' && isSymbol(tokens[i - 2], '.')) name = `"${last.value}"`;
          const object = text.slice(tokens[start].start, tokens[i].start);
          const args = text.slice(tokens[i + 2].end, tokens[close].start).trim();
          text = `${text.slice(0, tokens[start].start)}__rbx2017.GetTranslator(function() return ${object} end, ${name}, ${args || 'nil'})${text.slice(tokens[close].end)}`;
          helpers.add('GetTranslator');
          changes.add(':GetTranslator');
          done = false;
          break;
        }
      }
      if (marked) continue;
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
  // A script converted before gets the ones it still lacks (newer ones, or
  // ones an older converter missed), after the stand-ins it has.
  const tokens = tokenize(text);
  const from = marked ? preludeEnd(tokens) : 0;
  const existing = marked ? text.slice(0, tokens[from] ? tokens[from].start : text.length) : '';
  const needed = {}; // library -> Set(member)
  let random = false;
  const fontEdits = [];
  for (let i = from; i < tokens.length; i++) {
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
  for (const [library, all] of Object.entries(needed)) {
    if (declaresOwn(tokens, library, from)) continue;
    const members = [...all].filter((member) => !hasStandIn(existing, library, member));
    if (members.length === 0) continue;
    const fields = members.map((member) => {
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
  if (random && !declaresOwn(tokens, 'Random', from) && !existing.includes('local Random = {new = ')) {
    prelude.push(RANDOM);
    changes.add('Random');
  }
  if (marked) {
    if (changes.size === 0) return { text: source, changes: [] };
    // New helpers go at the end of the script's helper table (a later field
    // of the same name wins), or into a new table after the mark; new
    // library stand-ins after that table.
    const fields = [...helpers].map((name) => `${name} = ${HELPERS[name]}`).join(', ');
    const head = tokenize(existing);
    const hasTable = head[0] && head[0].value === 'local' && head[1] && head[1].value === '__rbx2017' && isSymbol(head[2], '=') && isSymbol(head[3], '{');
    const close = hasTable ? matchForward(head, 3) : -1;
    if (close >= 0) {
      const brace = head[close].start;
      const empty = head[close - 1] === head[3];
      const tableEnd = isSymbol(head[close + 1], ';') ? head[close + 1].end : head[close].end;
      const libraries = prelude.length > 0 ? ` ${prelude.join(' ')}` : '';
      text = fields
        ? `${text.slice(0, brace)}${empty ? '' : ', '}${fields}${text.slice(brace, tableEnd)}${libraries}${text.slice(tableEnd)}`
        : `${text.slice(0, tableEnd)}${libraries}${text.slice(tableEnd)}`;
    } else {
      const parts = [...(fields ? [`local __rbx2017 = {${fields}};`] : []), ...prelude];
      text = `${MARK} ${parts.join(' ')} ${text.slice(MARK.length).replace(/^ /, '')}`;
    }
    return { text, changes: [...changes] };
  }
  if (helpers.size > 0) {
    prelude.unshift(`local __rbx2017 = {${[...helpers].map((name) => `${name} = ${HELPERS[name]}`).join(', ')}};`);
  }
  if (changes.size === 0) return { text: source, changes: [] };
  return { text: `${MARK} ${prelude.join(' ')} ${text}`, changes: [...changes] };
}

module.exports = { convertSource, tokenize, prefixStart, MARK };
