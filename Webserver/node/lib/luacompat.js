'use strict';

// Makes scripts written for newer Roblox run on the 2017 engine (used by
// lib/placefile.js when a place is converted). The 2017 engine lacks many
// functions newer games call, and its math/table/string/os libraries are
// read-only, so they cannot be added once for every script. Instead each
// script that needs them gets:
//   - its calls rewritten: obj:GetDescendants() -> __rbx2017.GetDescendants(obj),
//     and likewise obj:HasTag/AddTag/RemoveTag/GetTags (CollectionService),
//     MarketplaceService:UserOwnsGamePassAsync (-> PlayerOwnsAsset: passes
//     are owned once bought, lib/ownership.js) and :PromptGamePassPurchase
//     (-> the 2017 PromptPurchase; PromptGamePassPurchaseFinished is then
//     PromptPurchaseFinished), s:split(sep), and
//     button.Activated (newer than 2017 on buttons: MouseButton1Click then);
//   - Enum.InfoType.GamePass -> Enum.InfoType.Asset (the site answers with
//     the game's pass when the place has its universe ID, lib/marketplace.js);
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

const luaulower = require('./luaulower');
const apidump = require('./apidump');

const MARK = '--[[2017]]';

// The API of the engine a script is converted for (lib/apidump.js; 2017
// unless options.engine names another). Member names no class of it has: an
// event no 2017 class has (e.g. MarketplaceService.PromptGamePassPurchaseFinished)
// stops a whole script at :Connect; such connections get a stand-in.
const NEWER_EVENTS = new Set(['PromptGamePassPurchaseFinished', 'PromptBundlePurchaseFinished', 'PromptPremiumPurchaseFinished',
  'PlayerMembershipChanged', 'PromptSubscriptionPurchaseFinished', 'AttributeChanged', 'Destroying', 'PromptShown', 'PromptHidden',
  'Triggered', 'TriggerEnded', 'PlayerChatted', 'LocalToolEquipped', 'LocalToolUnequipped']);
// The API in use (set by convertSource for the script it converts).
let API = null;
function apiFor(options) {
  if (options && options.api !== undefined) return options.api;
  return apidump.get(options && options.engine);
}
function unknownTo2017(name, api = API) {
  return api ? !api.hasMember(name) : NEWER_EVENTS.has(name);
}

// Enums the engine has: enum -> Map(item -> value), or null without a dump.
function enumsOf2017(api = API) {
  return api ? api.enums : null;
}
// Newer items of 2017 enums -> the nearest item it has (others become their name).
const ENUM_NEAREST = new Map([
  ['Material', { Glass: 'SmoothPlastic', ForceField: 'SmoothPlastic', Cardboard: 'Wood', Carpet: 'Fabric', CeramicTiles: 'Tile', ClayRoofTiles: 'Slate',
    RoofShingles: 'Slate', Leather: 'Fabric', Plaster: 'Concrete', Rubber: 'Plastic', Asphalt: 'Concrete', Basalt: 'Slate', Ground: 'Grass', Mud: 'Grass', Salt: 'Sand', Sandstone: 'Slate', Limestone: 'Slate', Pavement: 'Concrete', Rock: 'Slate', Snow: 'Ice', LeafyGrass: 'Grass', Glacier: 'Ice', CrackedLava: 'Slate' }],
  ['EasingStyle', { Cubic: 'Quad', Exponential: 'Quint', Circular: 'Sine' }],
  ['AnimationPriority', { Action2: 'Action', Action3: 'Action', Action4: 'Action' }],
  // GetUserCFrame(Enum.UserCFrame.Floor) (Cube Cavern): a string can't be passed; without VR both give CFrame.new()
  ['UserCFrame', { Floor: 'Head' }],
]);

// Members of PlayerGui (and Instance): x.PlayerGui.<anything else> is a
// child, which the converter waits for (see the step-1 loop).
function playerGuiMember(name, api = API) {
  return api ? Boolean(api.member('PlayerGui', name)) : true;
}

// Classes the engine has (for GetService of newer services).
function classKnownTo2017(name, api = API) {
  return api ? api.hasClass(name) : true;
}

// Newer properties scripts read, and the value they get when the 2017
// engine lacks them.
const NEWER_PROPERTIES = { RobloxLocaleId: '"en-us"', PlaceholderText: '""', Massless: 'false' };
// Newer properties scripts set (x.AutoLocalize = false); on 2017 such a line
// stops the script, so the setting is skipped when the engine lacks it.
// Sound's RollOff distances fall back to their 2017 names (in the Set helper).
// TextBox.PlaceholderText/Color3 are in the 2017 RCC, but the 2017 client
// fails on any use of them ("An error occurred").
const NEWER_SETTABLE = new Set(['AutoLocalize', 'RootLocalizationTable', 'AutomaticSize', 'RichText', 'MaxVisibleGraphemes', 'LineHeight', 'Interactable',
  'RollOffMaxDistance', 'RollOffMinDistance', 'RespawnTime', 'PlaceholderText', 'PlaceholderColor3', 'DisplayName',
  // BasePart.Massless (2019; Jailbreak sets it on characters entering a car
  // and holding an item, which stopped both); Lighting.ClockTime (Set helper
  // falls back to SetMinutesAfterMidnight).
  'Massless', 'ClockTime',
  // BillboardGui.Brightness/LightInfluence (2021); lights keep their own Brightness.
  'Brightness', 'LightInfluence',
  // Motor6D.Transform (the 2017 client lacks it; see SetTransform), and C0,
  // which scripts must see without the stand-in's offset.
  'Transform', 'C0',
  // GuiObject.FontFace (2022; the Font stand-in is a table).
  'FontFace',
  // BasePart.CanTouch/CanQuery (2021), CastShadow (2019): set by most newer games.
  'CanTouch', 'CanQuery', 'CastShadow']);
// More properties newer than 2017 that scripts set on objects they make
// (so they are not in the place file: Cmdr builds its GUI in code). Guarded
// like NEWER_SETTABLE where the 2017 API has no member of that name.
const NEWER_COMMON = ['TextEditable', 'AutomaticCanvasSize', 'TextDirection', 'SelectionGroup', 'SelectionOrder', 'SelectionBehaviorUp',
  'SelectionBehaviorDown', 'SelectionBehaviorLeft', 'SelectionBehaviorRight', 'ScrollingDirection', 'ElasticBehavior', 'ScrollBarImageColor3',
  'ScrollBarImageTransparency', 'VerticalScrollBarInset', 'HorizontalScrollBarInset', 'ZIndexBehavior', 'IgnoreGuiInset', 'ScreenInsets',
  'SafeAreaCompatibility', 'ClipToDeviceSafeArea', 'SizingMode', 'PixelsPerStud', 'ResampleMode', 'SliceScale', 'BorderMode', 'ImageContent',
  'PivotOffset', 'RootPriority', 'EnableFluidForces', 'AudioCanCollide', 'FlipbookLayout', 'FlipbookMode', 'FlipbookFramerate',
  'FlipbookStartRandom', 'FlipbookSizeX', 'FlipbookSizeY', 'Squash', 'ShapeInOut', 'ShapeStyle', 'ShapePartial', 'TimeScale', 'WindAffectsDrag',
  'PlaybackRegion', 'LoopRegion', 'PlaybackRegionsEnabled', 'BreakJointsOnDeath', 'RequiresNeck', 'EvaluateStateMachine', 'UseJumpPower',
  'JumpHeight', 'AutomaticScalingEnabled', 'EnvironmentDiffuseScale', 'EnvironmentSpecularScale', 'ExposureCompensation', 'ShadowSoftness',
  'LevelOfDetail', 'ModelStreamingMode', 'WorldPivot', 'EmissiveStrength', 'EmissiveTint', 'DoubleSided', 'RenderFidelity', 'CollisionFidelity',
  'OpenTypeFeatures', 'TextTruncate', 'MaxBubbles', 'BubbleDuration'];
const newerCommon = new Map(); // engine -> Set
function newerCommonProperty(name, api = API) {
  const key = api ? api.engine : '';
  if (!newerCommon.has(key)) newerCommon.set(key, new Set(NEWER_COMMON.filter((n) => unknownTo2017(n, api))));
  return newerCommon.get(key).has(name);
}

// Newer properties read through a helper of their own: property -> helper.
const READ_HELPERS = { RootPart: 'RootPart', DisplayName: 'DisplayName', ClockTime: 'ClockTime', Transform: 'GetTransform', C0: 'C0', ExtentsSize: 'ExtentsSize', ExtentsCFrame: 'ExtentsCFrame' };
// Setters with a helper of their own; Set for those with a 2017 fallback
// name; the others are guarded inline: do local __o2017, __v2017 = x, v
// pcall(function() __o2017.Name = __v2017 end) end.
const SETTERS = { Transform: 'SetTransform', C0: 'SetC0' };
const ALIASED = new Set(['RollOffMaxDistance', 'RollOffMinDistance', 'ClockTime']);
const GUARD_OBJECT = '__o2017';

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
      // (\z takes the spaces and line breaks after it; \ before CRLF takes both.)
      while (j < n && src[j] !== c && !(c !== '`' && src[j] === '\n')) {
        if (src[j] !== '\\') j++;
        else if (src[j + 1] === 'z') { j += 2; while (j < n && /\s/.test(src[j])) j++; }
        else j += src[j + 1] === '\r' && src[j + 2] === '\n' ? 3 : 2;
      }
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
    // A function argument: the commas in its body are not argument separators.
    if (t.type === 'keyword' && t.value === 'function') {
      for (let depth = 0; i < closeParen; i++) {
        const k = tokens[i];
        if (k.type !== 'keyword') continue;
        if (k.value === 'function' || k.value === 'do' || k.value === 'if' || k.value === 'repeat') depth++;
        else if ((k.value === 'end' || k.value === 'until') && --depth === 0) break;
      }
      continue;
    }
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
  // Attributes (2020) on Value objects (lib/attributes.js); GetChildren
  // leaves their folders out (only in places that have attributes).
  GetAttribute: [1], SetAttribute: [2], GetAttributes: [0], GetAttributeChangedSignal: [1], GetChildren: [0],
  // RBXScriptSignal:Once (2022), workspace:BulkMoveTo (2020).
  Once: [1], BulkMoveTo: [2, 3],
  // Spatial queries (2021); Model:GetScale/ScaleTo (2023); PathfindingService:CreatePath (2018).
  GetPartBoundsInBox: [2, 3], GetPartBoundsInRadius: [2, 3], GetPartsInPart: [1, 2], GetScale: [0], ScaleTo: [1], CreatePath: [0, 1],
  // Color3:ToHSV, Model:GetBoundingBox, AnimationTrack:GetMarkerReachedSignal; Actor messages (2021).
  ToHSV: [0], GetBoundingBox: [0], GetMarkerReachedSignal: [1], GetPlayingAnimationTracks: [0],
  // Enum.X:FromName / FromValue (2023).
  FromName: [1], FromValue: [1],
  // Chat:RegisterChatCallback (2018): 2017's chat has no callbacks.
  RegisterChatCallback: [2],
  // RunService:BindToRenderStep: 2017 calls the function without the frame time.
  BindToRenderStep: [3],
  BindToMessage: [2], BindToMessageParallel: [2], SendMessage: [1, 2, 3, 4, 5, 6, 7, 8],
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
// ContentProvider:PreloadAsync(instances or ids, callback); these also reach
// scripts converted before.)
const NEWER_METHODS = { PivotTo: [1], GetPivot: [0], Raycast: [2, 3], PreloadAsync: [1, 2], UserHasBadgeAsync: [2] };
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
// Does the call ending at token `close` (a ')') give a CFrame: GetPivot,
// ExtentsCFrame, or a function named like one (resolveLinkCFrame)?
function cframeCall(tokens, close) {
  const open = matchBackward(tokens, close);
  const callee = open > 0 ? tokens[open - 1] : null;
  return Boolean(callee && callee.type === 'name' && (/cframe$|cf$|pivot$/i.test(callee.value) || /^(?:ToWorldSpace|ToObjectSpace|toWorldSpace|toObjectSpace|Lerp|lerp|inverse|Inverse|lookAt|fromMatrix|Angles|fromEulerAnglesXYZ|fromEulerAnglesYXZ|fromOrientation|fromAxisAngle)$/.test(callee.value)));
}

// Is the parenthesized expression ending at `close` (not call arguments) one
// that gives a CFrame, as in (cf * CFrame.new(0, 1, 0)).Position: does it
// have CFrame or a value named or used like one in it?
function cframeGroup(tokens, close, names) {
  const open = matchBackward(tokens, close);
  if (open < 0 || endsPrefix(tokens[open - 1])) return false;
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k];
    if (t.type === 'name' && (t.value === 'CFrame' || CFRAME_NAME.test(t.value) || names.has(t.value))) return true;
  }
  return false;
}

// CollectionService:Name(...) with this many arguments -> __rbx2017.CSName(service, ...).
const CS_METHODS = { HasTag: 2, AddTag: 2, RemoveTag: 2, GetTags: 1, GetTagged: 1, GetInstanceAddedSignal: 1, GetInstanceRemovedSignal: 1 };
const CS_PARAMS = { HasTag: 'cs, o, t', AddTag: 'cs, o, t', RemoveTag: 'cs, o, t', GetTags: 'cs, o', GetTagged: 'cs, t', GetInstanceAddedSignal: 'cs, t', GetInstanceRemovedSignal: 'cs, t' };
// Attribute values (lib/attributes.js): Value objects; types with no Value
// class are StringValues "@@2017@@Type@@n1,n2,...". dec(valueObject) -> value;
// the encoder sets c (class) and s (stored value) from x.
const ATTR_DECODE = 'local function dec(v) local x = v.Value if v.ClassName ~= "StringValue" or x:sub(1, 8) ~= "@@2017@@" then return x end '
  + 'local k, d = x:match("^@@2017@@(%w+)@@(.*)$") if not k then return x end local n = {} for p in d:gmatch("[^,]+") do n[#n + 1] = tonumber(p) or p end '
  + 'if k == "UDim2" then return UDim2.new(n[1], n[2], n[3], n[4]) elseif k == "UDim" then return UDim.new(n[1], n[2]) elseif k == "Vector2" then return Vector2.new(n[1], n[2]) '
  + 'elseif k == "NumberRange" then return NumberRange.new(n[1], n[2]) elseif k == "Rect" then return Rect.new(n[1], n[2], n[3], n[4]) '
  + 'elseif k == "NumberSequence" then local kp = {} for i = 1, #n, 3 do kp[#kp + 1] = NumberSequenceKeypoint.new(n[i], n[i + 1], n[i + 2]) end return NumberSequence.new(kp) '
  + 'elseif k == "ColorSequence" then local kp = {} for i = 1, #n, 4 do kp[#kp + 1] = ColorSequenceKeypoint.new(n[i], Color3.new(n[i + 1], n[i + 2], n[i + 3])) end return ColorSequence.new(kp) '
  + 'elseif k == "EnumItem" then local ok, e = pcall(function() return Enum[n[1]][n[2]] end) if ok and e then return e end return n[2] '
  + 'elseif k == "EnumValue" then local ok, e = pcall(function() for _, it in ipairs(Enum[n[1]]:GetEnumItems()) do if it.Value == n[2] then return it end end end) if ok and e then return e end return n[2] end return d end ';
const ATTR_ENCODE = 'local t = typeof(x) local c = ({string = "StringValue", boolean = "BoolValue", number = "NumberValue", Vector3 = "Vector3Value", CFrame = "CFrameValue", '
  + 'Color3 = "Color3Value", BrickColor = "BrickColorValue"})[t] local s = x if not c then c = "StringValue" local p '
  + 'if t == "UDim2" then p = {x.X.Scale, x.X.Offset, x.Y.Scale, x.Y.Offset} elseif t == "UDim" then p = {x.Scale, x.Offset} elseif t == "Vector2" then p = {x.X, x.Y} '
  + 'elseif t == "NumberRange" then p = {x.Min, x.Max} elseif t == "Rect" then p = {x.Min.X, x.Min.Y, x.Max.X, x.Max.Y} '
  + 'elseif t == "NumberSequence" then p = {} for _, k in ipairs(x.Keypoints) do p[#p + 1] = k.Time p[#p + 1] = k.Value p[#p + 1] = k.Envelope end '
  + 'elseif t == "ColorSequence" then p = {} for _, k in ipairs(x.Keypoints) do p[#p + 1] = k.Time p[#p + 1] = k.Value.r p[#p + 1] = k.Value.g p[#p + 1] = k.Value.b end '
  + 'elseif t == "EnumItem" then p = {(tostring(x):match("^Enum%.(%w+)%.")), x.Name} else t = "string" p = {tostring(x)} end '
  + 'for i = 1, #p do p[i] = tostring(p[i]) end s = t == "string" and p[1] or ("@@2017@@" .. t .. "@@" .. table.concat(p, ",")) end';
// Spatial queries (2021) on 2017's Region3 (Workspace) or the parts' bounds
// (any other root: a WorldModel is a Model here). bounds(cf, size) -> the
// world box's min and max; query(root, min, max, overlapParams) -> parts.
const SPATIAL = 'local function flat(x, out) out = out or {} if type(x) == "table" then for _, v in pairs(x) do flat(v, out) end elseif typeof(x) == "Instance" then out[#out + 1] = x end return out end '
  + 'local function bounds(cf, size) local x, y, z, a, b, c, d, e, f, g, h, i = cf:components() local hx, hy, hz = size.X / 2, size.Y / 2, size.Z / 2 '
  + 'local ex = math.abs(a) * hx + math.abs(b) * hy + math.abs(c) * hz local ey = math.abs(d) * hx + math.abs(e) * hy + math.abs(f) * hz '
  + 'local ez = math.abs(g) * hx + math.abs(h) * hy + math.abs(i) * hz return Vector3.new(x - ex, y - ey, z - ez), Vector3.new(x + ex, y + ey, z + ez) end '
  + 'local function inList(p, list) for _, x in ipairs(list) do if p == x or p:IsDescendantOf(x) then return true end end return false end '
  + 'local function query(root, lo, hi, params) local list = flat(params and params.FilterDescendantsInstances) local ft = params and tostring(params.FilterType) or "Exclude" '
  + 'local include = ft:find("Include") ~= nil or ft:find("Whitelist") ~= nil local parts = {} '
  + 'if root == workspace then local region = Region3.new(lo, hi) local ok, r = pcall(function() if include then return workspace:FindPartsInRegion3WithWhiteList(region, list, 2000) end '
  + 'return workspace:FindPartsInRegion3WithIgnoreList(region, list, 2000) end) if ok then parts = r end '
  + 'else local function walk(x) for _, c in ipairs(x:GetChildren()) do if c:IsA("BasePart") then local a, b = bounds(c.CFrame, c.Size) '
  + 'if a.X <= hi.X and b.X >= lo.X and a.Y <= hi.Y and b.Y >= lo.Y and a.Z <= hi.Z and b.Z >= lo.Z and inList(c, list) == include then parts[#parts + 1] = c end end walk(c) end end walk(root) end '
  + 'return parts end ';

// Actor messages: e = the actor's entry {h = handlers by topic, q = messages waiting}.
const ACTOR_ENTRY = 'local R = _G.__rbx2017Actors if not R then R = setmetatable({}, {__mode = "k"}) _G.__rbx2017Actors = R end '
  + 'local e = R[o] if not e then e = {h = {}, q = {}} R[o] = e end';
const ACTOR_BIND = `${ACTOR_ENTRY} e.h[topic] = fn local q = e.q[topic] if q then e.q[topic] = nil for _, args in ipairs(q) do spawn(function() fn(unpack(args, 1, args.n)) end) end end `
  + 'local c = {Connected = true} function c:Disconnect() if e.h[topic] == fn then e.h[topic] = nil end c.Connected = false end c.disconnect = c.Disconnect return c end';

// Once and Wait for a stand-in signal s that has Connect.
const SIGNAL_EXTRAS = 'function s:Once(fn) local c c = s:Connect(function(...) if c then c:Disconnect() end fn(...) end) return c end '
  + 'function s:Wait() local e = Instance.new("BindableEvent") local r local c = s:Connect(function(...) r = {...} e:Fire() end) e.Event:wait() c:Disconnect() e:Destroy() return unpack(r) end '
  + 's.wait = s.Wait s.once = s.Once';

// The TweenService stand-in (2016): Create(o, info, goal) -> a tween that
// moves numbers, Vector3, CFrame, UDim2 and Color3 values on wait().
const TWEEN_SERVICE = 'local styles = {Linear = function(a) return a end, Sine = function(a) return 1 - math.cos(a * math.pi / 2) end, '
  + 'Quad = function(a) return a * a end, Cubic = function(a) return a ^ 3 end, Quart = function(a) return a ^ 4 end, Quint = function(a) return a ^ 5 end, '
  + 'Exponential = function(a) return a == 0 and 0 or 2 ^ (10 * a - 10) end, Circular = function(a) return 1 - math.sqrt(1 - a * a) end, '
  + 'Back = function(a) return a * a * (2.70158 * a - 1.70158) end, Bounce = function(a) a = 1 - a local r if a < 1 / 2.75 then r = 7.5625 * a * a '
  + 'elseif a < 2 / 2.75 then a = a - 1.5 / 2.75 r = 7.5625 * a * a + 0.75 elseif a < 2.5 / 2.75 then a = a - 2.25 / 2.75 r = 7.5625 * a * a + 0.9375 '
  + 'else a = a - 2.625 / 2.75 r = 7.5625 * a * a + 0.984375 end return 1 - r end, '
  + 'Elastic = function(a) if a == 0 or a == 1 then return a end return -(2 ^ (10 * a - 10)) * math.sin((a * 10 - 10.75) * (2 * math.pi) / 3) end} '
  + 'local function name(e, d) return tostring(e or d):match("([%w]+)$") or d end '
  + 'local function ease(info, a) local f = styles[name(info.EasingStyle, "Quad")] or styles.Quad local dir = name(info.EasingDirection, "Out") '
  + 'if dir == "In" then return f(a) elseif dir == "Out" then return 1 - f(1 - a) end if a < 0.5 then return f(a * 2) / 2 end return 1 - f((1 - a) * 2) / 2 end '
  + 'local function mix(x, y, t) if type(x) == "number" then return x + (y - x) * t end if type(x) ~= "userdata" then return t >= 1 and y or x end '
  + 'local ok, r = pcall(function() return x:lerp(y, t) end) if ok then return r end '
  + 'ok, r = pcall(function() return UDim2.new(x.X.Scale + (y.X.Scale - x.X.Scale) * t, x.X.Offset + (y.X.Offset - x.X.Offset) * t, x.Y.Scale + (y.Y.Scale - x.Y.Scale) * t, x.Y.Offset + (y.Y.Offset - x.Y.Offset) * t) end) if ok then return r end '
  + 'ok, r = pcall(function() return Color3.new(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t) end) if ok then return r end return t >= 1 and y or x end '
  + 'local TS = {} function TS:Create(o, info, goal) info = info or {} local done = Instance.new("BindableEvent") local run = 0 '
  + 'local tw = {Instance = o, TweenInfo = info, PlaybackState = "Begin", Completed = done.Event} '
  + 'function tw:Play() run = run + 1 local me = run tw.PlaybackState = "Playing" spawn(function() if (info.DelayTime or 0) > 0 then wait(info.DelayTime) end '
  + 'local from = {} for k in pairs(goal) do from[k] = o[k] end local d, reps, n = info.Time or 1, info.RepeatCount or 0, 0 '
  + 'repeat for pass = 1, info.Reverses and 2 or 1 do local t0 = tick() repeat if run ~= me then return end local a = d > 0 and math.min(1, (tick() - t0) / d) or 1 '
  + 'local e = ease(info, a) if pass == 2 then e = 1 - e end for k, v in pairs(goal) do pcall(function() o[k] = mix(from[k], v, e) end) end if a < 1 then wait() end until a >= 1 end '
  + 'n = n + 1 until reps >= 0 and n > reps tw.PlaybackState = "Completed" done:Fire("Completed") end) end '
  + 'function tw:Cancel() run = run + 1 tw.PlaybackState = "Cancelled" end function tw:Pause() run = run + 1 tw.PlaybackState = "Paused" end '
  + 'function tw:Destroy() run = run + 1 end tw.play = tw.Play tw.cancel = tw.Cancel tw.pause = tw.Pause return tw end '
  + 'function TS:GetValue(a, style, dir) return ease({EasingStyle = style, EasingDirection = dir}, a) end return TS';

const HELPERS = {
  GetDescendants: `function(o) ${own('GetDescendants', '')} local r = {} local function w(x) for _, c in ipairs(x:GetChildren()) do if c.Name ~= "__2017Attributes" then r[#r + 1] = c w(c) end end end w(o) return r end`,
  HasTag: `function(o, t) ${own('HasTag', 't')} local cs = game:GetService("CollectionService") ${TAG_BODIES.HasTag} end`,
  AddTag: `function(o, t) ${own('AddTag', 't')} local cs = game:GetService("CollectionService") ${TAG_BODIES.AddTag} end`,
  RemoveTag: `function(o, t) ${own('RemoveTag', 't')} local cs = game:GetService("CollectionService") ${TAG_BODIES.RemoveTag} end`,
  GetTags: `function(o) ${own('GetTags', '')} local cs = game:GetService("CollectionService") ${TAG_BODIES.GetTags} end`,
  ...Object.fromEntries(Object.keys(CS_METHODS).map((name) => [`CS${name}`, `function(${CS_PARAMS[name]}) ${TAG_BODIES[name]} end`])),
  // Game passes are assets to the 2017 engine (the site keeps what each player bought).
  UserOwnsGamePassAsync: `function(o, u, p) ${own('UserOwnsGamePassAsync', 'u, p')} local ok, r = pcall(function() `
    + 'local pl = game:GetService("Players"):GetPlayerByUserId(u) return pl ~= nil and o:PlayerOwnsAsset(pl, p) end) return ok and r == true end',
  PromptGamePassPurchase: `function(o, u, p) ${own('PromptGamePassPurchase', 'u, p')} pcall(function() o:PromptPurchase(u, p) end) end`,
  // BadgeService:UserHasBadgeAsync (2018) is UserHasBadge in 2017 (Jailbreak's garage stopped on it).
  UserHasBadgeAsync: `function(o, u, b) ${own('UserHasBadgeAsync', 'u, b')} local ok, r = pcall(function() return o:UserHasBadge(u, b) end) return ok and r == true end`,
  Activated: 'function(o) local ok, e = pcall(function() return o.Activated end) if ok and e then return e end return o.MouseButton1Click end',
  RegisterCollisionGroup: `function(o, n) ${own('RegisterCollisionGroup', 'n')} pcall(function() o:CreateCollisionGroup(n) end) end`,
  IsCollisionGroupRegistered: `function(o, n) ${own('IsCollisionGroupRegistered', 'n')} return (pcall(function() return o:GetCollisionGroupId(n) end)) end`,
  UnregisterCollisionGroup: `function(o, n) ${own('UnregisterCollisionGroup', 'n')} pcall(function() o:RemoveCollisionGroup(n) end) end`,
  GetRegisteredCollisionGroups: `function(o) ${own('GetRegisteredCollisionGroups', '')} return o:GetCollisionGroups() end`,
  SetCollisionGroup: 'function(p, n) pcall(function() game:GetService("PhysicsService"):SetPartCollisionGroup(p, n) end) end',
  // A newer event: the real one, else the 2017 one it became, else a stand-in that never fires.
  Event: 'function(o, n) local ok, e = pcall(function() return o[n] end) if ok and e ~= nil then return e end '
    + 'local a = ({PromptGamePassPurchaseFinished = "PromptPurchaseFinished", PreRender = "RenderStepped", PostSimulation = "Heartbeat"})[n] if a then ok, e = pcall(function() return o[a] end) if ok and e ~= nil then return e end end '
    + 'local s = {} local c = {connected = false, Connected = false} function c:disconnect() end c.Disconnect = c.disconnect function s:connect() return c end s.Connect = s.connect s.Once = s.connect s.ConnectParallel = s.connect function s:wait() while true do wait(3600) end end s.Wait = s.wait return s end',
  Service: 'function(o, n) local ok, s = pcall(function() return o:GetService(n) end) if ok and s then return s end local x x = setmetatable({}, {__index = function() return x end, __call = function() return nil end}) return x end',
  Prop: 'function(o, n, d) local ok, v = pcall(function() return o[n] end) if ok and v ~= nil then return v end return d end',
  Set: 'function(o, n, v) if pcall(function() o[n] = v end) then return end '
    + 'if n == "ClockTime" then pcall(function() o:SetMinutesAfterMidnight((v % 24) * 60) end) return end '
    + 'local a = ({RollOffMaxDistance = "MaxDistance", RollOffMinDistance = "EmitterSize"})[n] if a then pcall(function() o[a] = v end) end end',
  // Color3.R/G/B (2017 has only r, g, b).
  C3: 'function(x, n) local ok, v = pcall(function() return x[n] end) if ok then return v end return x[n:lower()] end',
  // Motor6D.Transform (2018; the 2017 client has no such property). In newer
  // engines the animator writes each joint's Transform every frame and a
  // script's own Transform replaces it. Here the 2017 animator keeps adding
  // its pose after C0, so setting it puts Transform * (animation pose)^-1
  // into C0, the pose read off the parts' positions (once per frame), and C0
  // goes back once a script stops setting it. Reading gives this frame's
  // value, else that animation pose. Scripts reading
  // or setting such a joint's C0 get and set the C0 without the offset (C0,
  // SetC0): IK code reads C0 to work out the Transform it sets, and seeing
  // its own offset there made arms jump about.
  SetTransform: 'function(o, n, v) if pcall(function() o[n] = v end) then return end local S = _G.__rbx2017Transform '
    + 'if not S then S = {joints = {}, frame = 0} _G.__rbx2017Transform = S game:GetService("RunService").Heartbeat:connect(function() S.frame = S.frame + 1 '
    + 'for m, e in pairs(S.joints) do if e.frame < S.frame - 1 then pcall(function() m.C0 = e.base end) S.joints[m] = nil end end end) end '
    + 'local e = S.joints[o] if not e then e = {base = o.C0, frame = -1} S.joints[o] = e end '
    + 'if e.animFrame ~= S.frame then local a = CFrame.new() pcall(function() a = (o.Part0.CFrame * o.C0):inverse() * o.Part1.CFrame * o.C1 end) e.anim = a e.animFrame = S.frame end '
    + 'e.value = v e.frame = S.frame o.C0 = e.base * v * e.anim:inverse() end',
  GetTransform: 'function(o) local ok, v = pcall(function() return o.Transform end) if ok then return v end local S = _G.__rbx2017Transform '
    + 'local e = S and S.joints[o] if e and e.frame == S.frame then return e.value end if e and e.animFrame == S.frame then return e.anim end '
    + 'local a = CFrame.new() pcall(function() a = (o.Part0.CFrame * o.C0):inverse() * o.Part1.CFrame * o.C1 end) if e then e.anim = a e.animFrame = S.frame end return a end',
  C0: 'function(o) local S = _G.__rbx2017Transform local e = S and S.joints[o] if e then return e.base end return o.C0 end',
  SetC0: 'function(o, n, v) local S = _G.__rbx2017Transform local e = S and S.joints[o] '
    + 'if e then e.base = v if e.frame == S.frame then o.C0 = v * e.value * e.anim:inverse() else o.C0 = v end return end o.C0 = v end',
  // Player.CharacterAppearanceLoaded. RCC never fires it on these servers
  // (its own avatar loading never runs; Server/appearance-hook.lua dresses
  // characters instead and then marks them __2017Dressed, lib/hosting.js).
  // This fires once per character, when it is dressed (or after 6 s; the
  // 2017 engine fires CharacterAdded before the character is in Workspace).
  AppearanceLoaded: 'function(p) local sig = {} local function ready(char) local t = 0 while t < 6 and not (char.Parent and char:FindFirstChild("__2017Dressed")) do t = t + wait(0.1) end end '
    + 'function sig:connect(f) local done = setmetatable({}, {__mode = "k"}) local function go(char) if done[char] then return end done[char] = true ready(char) if char.Parent then f(char) end end '
    + 'local a = p.CharacterAdded:connect(go) local ok, b = pcall(function() return p.CharacterAppearanceLoaded:connect(go) end) '
    + 'local c = {Connected = true} function c:disconnect() a:disconnect() if ok and b then b:disconnect() end c.Connected = false end c.Disconnect = c.disconnect return c end '
    + 'sig.Connect = sig.connect function sig:wait() local char = p.Character or p.CharacterAdded:wait() ready(char) return char end sig.Wait = sig.wait return sig end',
  // Lighting.ClockTime (read) from 2017's minutes after midnight.
  ClockTime: 'function(o) local ok, v = pcall(function() return o.ClockTime end) if ok then return v end return o:GetMinutesAfterMidnight() / 60 end',
  // TweenService:Create(Lighting, info, {ClockTime = ...}): ClockTime is
  // tweened on a stand-in number that sets the minutes after midnight (in
  // Lighting while it runs: 2017 tweens only instances in the game).
  TweenCreate: 'function(s, o, info, props) local ok, t = pcall(function() return s.Create(s, o, info, props) end) if ok then return t end '
    + 'if type(props) ~= "table" or props.ClockTime == nil then error(t, 2) end local rest, more = {}, false '
    + 'for k, v in pairs(props) do if k ~= "ClockTime" then rest[k] = v more = true end end '
    + 'local value = Instance.new("NumberValue") value.Value = o:GetMinutesAfterMidnight() / 60 '
    + 'value.Name = "__2017ClockTime" value.Changed:connect(function(v) o:SetMinutesAfterMidnight((v % 24) * 60) end) value.Parent = o '
    + 'local tween = s.Create(s, value, info, {Value = props.ClockTime}) local other = more and s.Create(s, o, info, rest) or nil '
    + 'tween.Completed:connect(function() value:Destroy() end) local proxy = {Completed = tween.Completed, Instance = o, TweenInfo = info} '
    + 'function proxy:Play() tween:Play() if other then other:Play() end end function proxy:Pause() tween:Pause() if other then other:Pause() end end '
    + 'function proxy:Cancel() tween:Cancel() if other then other:Cancel() end end '
    + 'return setmetatable(proxy, {__index = function(_, k) if k == "PlaybackState" then return tween.PlaybackState end end}) end',
  // CFrame methods with capitals -> the 2017 lower-case ones (tables keep their own).
  CFCall: 'function(x, n, ...) if type(x) == "table" then return x[n](x, ...) end '
    + 'local m = n == "GetComponents" and "components" or n == "ToOrientation" and "toEulerAnglesYXZ" or n:sub(1, 1):lower() .. n:sub(2) return x[m](x, ...) end',
  // Humanoid.RootPart (2018): the character's HumanoidRootPart (or Torso).
  RootPart: 'function(h) local ok, v = pcall(function() return h.RootPart end) if ok then return v end '
    + 'local c = h.Parent return c and (c:FindFirstChild("HumanoidRootPart") or c:FindFirstChild("Torso")) end',
  DisplayName: 'function(p) local ok, v = pcall(function() return p.DisplayName end) if ok then return v end return p.Name end',
  // workspace:Raycast and RaycastParams (2020) on FindPartOnRay. The filter
  // list is flattened and keeps only instances: 2017's ignore lists refuse a
  // table inside the table (Jailbreak's punch passes {blacklist}).
  RaycastParams: 'function() return {FilterDescendantsInstances = {}, FilterType = "Exclude", IgnoreWater = false, CollisionGroup = "Default", RespectCanCollide = false} end',
  Raycast: 'function(w, origin, dir, params) if type(w) == "table" then return w.Raycast(w, origin, dir, params) end local list, include, water = {}, false, false '
    + 'if params then local function add(x) if type(x) == "table" then for _, v in pairs(x) do add(v) end '
    + 'elseif type(x) == "userdata" and pcall(function() return x:IsA("Instance") end) then list[#list + 1] = x end end '
    + 'add(params.FilterDescendantsInstances) include = params.FilterType == "Include" or params.FilterType == "Whitelist" water = params.IgnoreWater and true or false end '
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
  // Generalized iteration (for k, v in t do, lib/luaulower.js): a table is
  // walked with next (or its __iter / __call); iterator functions pass through.
  Iter: 'function(t, ...) if type(t) ~= "table" then return t, ... end local m = getmetatable(t) '
    + 'if type(m) == "table" then if m.__iter then return m.__iter(t) end if m.__call then return t, ... end end return next, t end',
  // Attributes: Value objects in a __2017Attributes Configuration (lib/attributes.js).
  GetAttribute: `(function() ${ATTR_DECODE} return function(o, n) if type(o) == "table" and o.GetAttribute then return o:GetAttribute(n) end `
    + 'local f = o:FindFirstChild("__2017Attributes") local v = f and f:FindFirstChild(n) if not v then return nil end return dec(v) end end)()',
  GetAttributes: `(function() ${ATTR_DECODE} return function(o) if type(o) == "table" and o.GetAttributes then return o:GetAttributes() end `
    + 'local r = {} local f = o:FindFirstChild("__2017Attributes") if f then for _, v in ipairs(f:GetChildren()) do if v.Name:sub(1, 6) ~= "__2017" then r[v.Name] = dec(v) end end end return r end end)()',
  SetAttribute: `function(o, n, x) if type(o) == "table" and o.SetAttribute then return o:SetAttribute(n, x) end `
    + 'local f = o:FindFirstChild("__2017Attributes") local v = f and f:FindFirstChild(n) if x == nil then if v then v:Destroy() end return end '
    + `${ATTR_ENCODE} if v and v.ClassName ~= c then v:Destroy() v = nil end if v then v.Value = s return end `
    + 'v = Instance.new(c) v.Name = n v.Value = s if f then v.Parent = f else f = Instance.new("Configuration") f.Name = "__2017Attributes" v.Parent = f f.Parent = o end end',
  GetAttributeChangedSignal: `function(o, n) if type(o) == "table" and o.GetAttributeChangedSignal then return o:GetAttributeChangedSignal(n) end local s = {} `
    + 'function s:Connect(fn) local live, cv, cf, ca, cr = true '
    + 'local function watch(v) if cv then cv:disconnect() end cv = v.Changed:connect(function() if live then fn() end end) end '
    + 'local function folder(f) local v = f:FindFirstChild(n) if v then watch(v) end '
    + 'ca = f.ChildAdded:connect(function(c) if c.Name == n then watch(c) if live then fn() end end end) '
    + 'cr = f.ChildRemoved:connect(function(c) if c.Name == n and not f:FindFirstChild(n) then if cv then cv:disconnect() cv = nil end if live then fn() end end end) end '
    + 'local f = o:FindFirstChild("__2017Attributes") if f then folder(f) else cf = o.ChildAdded:connect(function(c) '
    + 'if c.Name == "__2017Attributes" and not ca then if cf then cf:disconnect() end folder(c) if c:FindFirstChild(n) and live then fn() end end end) end '
    + 'local c = {Connected = true} function c:Disconnect() live = false c.Connected = false '
    + 'if cv then cv:disconnect() end if cf then cf:disconnect() end if ca then ca:disconnect() end if cr then cr:disconnect() end end c.disconnect = c.Disconnect return c end '
    + `s.connect = s.Connect ${SIGNAL_EXTRAS} return s end`,
  AttributeChanged: 'function(o) if type(o) == "table" then return o.AttributeChanged end local s = {} '
    + 'function s:Connect(fn) local live, conns, cf, ca, cr = true, {} '
    + 'local function watch(v) if conns[v] then return end conns[v] = v.Changed:connect(function() if live then fn(v.Name) end end) end '
    + 'local function folder(f) for _, v in ipairs(f:GetChildren()) do watch(v) end '
    + 'ca = f.ChildAdded:connect(function(v) watch(v) if live then fn(v.Name) end end) '
    + 'cr = f.ChildRemoved:connect(function(v) if conns[v] then conns[v]:disconnect() conns[v] = nil end if live then fn(v.Name) end end) end '
    + 'local f = o:FindFirstChild("__2017Attributes") if f then folder(f) else cf = o.ChildAdded:connect(function(c) '
    + 'if c.Name == "__2017Attributes" and not ca then if cf then cf:disconnect() end folder(c) for _, v in ipairs(c:GetChildren()) do if live then fn(v.Name) end end end end) end '
    + 'local c = {Connected = true} function c:Disconnect() live = false c.Connected = false for _, x in pairs(conns) do x:disconnect() end '
    + 'if cf then cf:disconnect() end if ca then ca:disconnect() end if cr then cr:disconnect() end end c.disconnect = c.Disconnect return c end '
    + `s.connect = s.Connect ${SIGNAL_EXTRAS} return s end`,
  GetChildren: `function(o) ${own('GetChildren', '')} local r = o:GetChildren() for i = #r, 1, -1 do if r[i].Name == "__2017Attributes" then table.remove(r, i) end end return r end`,
  Once: `function(o, f) ${own('Once', 'f')} local c c = o:connect(function(...) if c then c:disconnect() end f(...) end) return c end`,
  BulkMoveTo: `function(o, parts, cfs, mode) ${own('BulkMoveTo', 'parts, cfs, mode')} for i, p in ipairs(parts) do p.CFrame = cfs[i] end end`,
  // Buffers are byte arrays (the buffer stand-in) and come through remotes as plain ones.
  IsBuffer: 'function(x) if type(x) ~= "table" then return false end local n = #x for i = 1, n do local v = x[i] '
    + 'if type(v) ~= "number" or v < 0 or v > 255 or v % 1 ~= 0 then return false end end return next(x, n > 0 and n or nil) == nil end',
  // spawn(f, a, ...) / delay(t, f, a, ...): 2017's drop a, ... and pass f the elapsed time.
  Spawn: 'function(f, ...) local n, a = select("#", ...), {...} spawn(function() f(unpack(a, 1, n)) end) end',
  Delay: 'function(t, f, ...) local n, a = select("#", ...), {...} delay(t, function() f(unpack(a, 1, n)) end) end',
  // Instance.new of a class 2017 lacks.
  New:'function(c, p) local ok, o = pcall(Instance.new, c) if not ok then o = nil local m = ({UnreliableRemoteEvent = "RemoteEvent", WorldModel = "Model", Actor = "Model"})[c] if m then o = Instance.new(m) end end '
    + 'if not o then local fields = {ClassName = c, Name = c} o = setmetatable({}, {__index = function(_, k) local v = fields[k] if v ~= nil then return v end '
    + 'if k == "IsA" then return function(_, x) return x == c or x == "Instance" end end return function() end end, '
    + '__newindex = function(_, k, v) fields[k] = v end, __tostring = function() return tostring(fields.Name) end}) end if p then o.Parent = p end return o end',
  Stub: 'function() local x x = setmetatable({}, {__index = function() return x end, __call = function() return x end}) return x end',
  GetPartBoundsInBox: `(function() ${SPATIAL} return function(o, cf, size, params) ${own('GetPartBoundsInBox', 'cf, size, params')} local lo, hi = bounds(cf, size) return query(o, lo, hi, params) end end)()`,
  GetPartBoundsInRadius: `(function() ${SPATIAL} return function(o, pos, r, params) ${own('GetPartBoundsInRadius', 'pos, r, params')} `
    + 'local out = {} for _, p in ipairs(query(o, pos - Vector3.new(r, r, r), pos + Vector3.new(r, r, r), params)) do local a, b = bounds(p.CFrame, p.Size) '
    + 'local q = Vector3.new(math.max(a.X, math.min(pos.X, b.X)), math.max(a.Y, math.min(pos.Y, b.Y)), math.max(a.Z, math.min(pos.Z, b.Z))) if (q - pos).magnitude <= r then out[#out + 1] = p end end return out end end)()',
  GetPartsInPart: `(function() ${SPATIAL} return function(o, part, params) ${own('GetPartsInPart', 'part, params')} local lo, hi = bounds(part.CFrame, part.Size) `
    + 'local out = {} for _, p in ipairs(query(o, lo, hi, params)) do if p ~= part then out[#out + 1] = p end end return out end end)()',
  // Model:GetScale/ScaleTo (2023). The scale is kept in _G (and a model's
  // scale from the file in its __2017Scale attribute, lib/placefile.js).
  GetScale: `function(o) ${own('GetScale', '')} local S = _G.__rbx2017Scales if S and S[o] then return S[o] end `
    + 'local f = o:FindFirstChild("__2017Attributes") local v = f and f:FindFirstChild("__2017Scale") return v and v.Value or 1 end',
  ScaleTo: `function(o, s) ${own('ScaleTo', 's')} local S = _G.__rbx2017Scales if not S then S = setmetatable({}, {__mode = "k"}) _G.__rbx2017Scales = S end `
    + 'local f = o:FindFirstChild("__2017Attributes") local fv = f and f:FindFirstChild("__2017Scale") local k = s / (S[o] or (fv and fv.Value) or 1) S[o] = s if fv then fv.Value = s end '
    + 'if k == 1 then return end local pivot = o.PrimaryPart and o.PrimaryPart.CFrame or o:GetModelCFrame() local parts = {} '
    + 'local function walk(x) for _, c in ipairs(x:GetChildren()) do pcall(function() '
    + 'if c:IsA("BasePart") then parts[#parts + 1] = {c, pivot:toObjectSpace(c.CFrame)} elseif c:IsA("JointInstance") then c.C0 = c.C0 - c.C0.p + c.C0.p * k c.C1 = c.C1 - c.C1.p + c.C1.p * k '
    + 'elseif c:IsA("Attachment") then c.Position = c.Position * k elseif c:IsA("SpecialMesh") then c.Scale = c.Scale * k c.Offset = c.Offset * k '
    + 'elseif c:IsA("Humanoid") then c.HipHeight = c.HipHeight * k end end) walk(c) end end walk(o) '
    + 'for _, e in ipairs(parts) do pcall(function() local p, rel = e[1], e[2] p.Size = p.Size * k p.CFrame = pivot * CFrame.new(rel.p * k) * (rel - rel.p) end) end end',
  ToHSV: `function(o) ${own('ToHSV', '')} return Color3.toHSV(o) end`,
  RegisterChatCallback: `function(o, t, f) ${own('RegisterChatCallback', 't, f')} pcall(function() o:RegisterChatCallback(t, f) end) end`,
  BindToRenderStep: `function(o, name, p, f) ${own('BindToRenderStep', 'name, p, f')} local last = tick() `
    + 'return o:BindToRenderStep(name, p, function(dt) local now = tick() if type(dt) ~= "number" then dt = now - last end last = now return f(dt) end) end',
  GetBoundingBox: `function(o) ${own('GetBoundingBox', '')} return o:GetModelCFrame(), o:GetExtentsSize() end`,
  // Keyframe markers (2018) are named keyframes to 2017's KeyframeReached.
  GetMarkerReachedSignal: `function(o, n) ${own('GetMarkerReachedSignal', 'n')} local s = {} `
    + 'function s:Connect(fn) local k = o.KeyframeReached:connect(function(name) if name == n then fn() end end) '
    + 'local c = {Connected = true} function c:Disconnect() k:disconnect() c.Connected = false end c.disconnect = c.Disconnect return c end '
    + `s.connect = s.Connect ${SIGNAL_EXTRAS} return s end`,
  // Actor:BindToMessage/SendMessage (an Actor is a Model here): handlers in
  // _G (scripts on one machine share it), messages sent early wait for one.
  BindToMessage: `function(o, topic, fn) ${own('BindToMessage', 'topic, fn')} ${ACTOR_BIND}`,
  BindToMessageParallel: `function(o, topic, fn) ${own('BindToMessageParallel', 'topic, fn')} ${ACTOR_BIND}`,
  SendMessage: `function(o, topic, ...) ${own('SendMessage', 'topic, ...')} ${ACTOR_ENTRY} local fn = e.h[topic] local args = {n = select("#", ...), ...} `
    + 'if fn then spawn(function() fn(unpack(args, 1, args.n)) end) else e.q[topic] = e.q[topic] or {} table.insert(e.q[topic], args) end end',
  SetAlignCF: 'function(a, cf) if pcall(function() a.CFrame = cf end) then return end local t = a.Attachment1 '
    + 'if not t or t.Name ~= "__2017AlignTarget" then t = Instance.new("Attachment") t.Name = "__2017AlignTarget" t.Parent = workspace.Terrain a.Attachment1 = t '
    + 'local c c = a.AncestryChanged:connect(function() if not a.Parent then c:disconnect() t:Destroy() end end) end t.CFrame = cf - cf.p end',
  // PathfindingService:CreatePath (2018) on 2017's ComputeSmoothPathAsync.
  CreatePath: `function(o, params) ${own('CreatePath', 'params')} local p = {Status = Enum.PathStatus.FailStartNotEmpty, _pts = {}} `
    + 'local function never() local s = {} local c = {Connected = false} function c:Disconnect() end c.disconnect = c.Disconnect '
    + 'function s:Connect() return c end s.connect = s.Connect s.Once = s.Connect function s:Wait() while true do wait(3600) end end s.wait = s.Wait return s end '
    + 'p.Blocked = never() p.Unblocked = never() '
    + 'function p:ComputeAsync(a, b) local ok, raw = pcall(function() return o:ComputeSmoothPathAsync(a, b, 512) end) '
    + 'if ok and raw then self.Status = raw.Status self._pts = raw.Status == Enum.PathStatus.Success and raw:GetPointCoordinates() or {} else self.Status = Enum.PathStatus.FailStartNotEmpty self._pts = {} end end '
    + 'function p:GetWaypoints() local w = {} for i, pt in ipairs(self._pts) do w[i] = {Position = pt, Action = "Walk", Label = ""} end return w end '
    + 'function p:CheckOcclusionAsync() return -1 end function p:Destroy() end return p end',
  // BasePart.ExtentsSize/ExtentsCFrame (newer): a part's own size and CFrame.
  ExtentsSize: 'function(p) local ok, v = pcall(function() return p.ExtentsSize end) if ok then return v end return p.Size end',
  ExtentsCFrame: 'function(p) local ok, v = pcall(function() return p.ExtentsCFrame end) if ok then return v end return p.CFrame end',
  // Animator:GetPlayingAnimationTracks (2019): the Humanoid's or AnimationController's.
  GetPlayingAnimationTracks: `function(o) ${own('GetPlayingAnimationTracks', '')} local ok, r = pcall(function() return o:GetPlayingAnimationTracks() end) if ok then return r end `
    + 'local p = o.Parent if p and (p:IsA("Humanoid") or p:IsA("AnimationController")) then return p:GetPlayingAnimationTracks() end return {} end',
  // RunService.Stepped passing only the frame time (PreSimulation, PreAnimation).
  SteppedDt: 'function(rs) local s = {} function s:connect(f) return rs.Stepped:connect(function(_, dt) f(dt) end) end s.Connect = s.connect '
    + 'function s:wait() local _, dt = rs.Stepped:wait() return dt end s.Wait = s.wait '
    + 'function s:Once(f) local c c = rs.Stepped:connect(function(_, dt) c:disconnect() f(dt) end) return c end return s end',
  // Enum.X:FromName(name) / FromValue(value) (2023).
  FromName: `function(e, n) ${own('FromName', 'n')} local ok, v = pcall(function() return e[n] end) if ok then return v end return nil end`,
  FromValue: `function(e, v) ${own('FromValue', 'v')} for _, item in ipairs(e:GetEnumItems()) do if item.Value == v then return item end end return nil end`,
  // 2016: signals have connect/wait/disconnect only (a game's own signal object keeps its own).
  Connect: 'function(s, f) if type(s) == "table" then return s:Connect(f) end return s:connect(f) end',
  Wait: 'function(s) if type(s) == "table" then return s:Wait() end return s:wait() end',
  Disconnect: 'function(c) if type(c) == "table" then return c:Disconnect() end return c:disconnect() end',
  FindFirstChildOfClass: `function(o, c) ${own('FindFirstChildOfClass', 'c')} for _, x in ipairs(o:GetChildren()) do if x.ClassName == c then return x end end return nil end`,
  FindFirstChildWhichIsA: `function(o, c, r) ${own('FindFirstChildWhichIsA', 'c, r')} local function w(p) for _, x in ipairs(p:GetChildren()) do if x:IsA(c) then return x end end `
    + 'if r then for _, x in ipairs(p:GetChildren()) do local f = w(x) if f then return f end end end return nil end return w(o) end',
  FindFirstAncestor: `function(o, n) ${own('FindFirstAncestor', 'n')} local p = o.Parent while p do if p.Name == n then return p end p = p.Parent end return nil end`,
  FindFirstAncestorOfClass: `function(o, c) ${own('FindFirstAncestorOfClass', 'c')} local p = o.Parent while p do if p.ClassName == c then return p end p = p.Parent end return nil end`,
  FindFirstAncestorWhichIsA: `function(o, c) ${own('FindFirstAncestorWhichIsA', 'c')} local p = o.Parent while p do if p:IsA(c) then return p end p = p.Parent end return nil end`,
  GetPropertyChangedSignal: `function(o, n) ${own('GetPropertyChangedSignal', 'n')} local s = {} function s:connect(f) return o.Changed:connect(function(p) if p == n then f() end end) end `
    + 'function s:wait() repeat local p = o.Changed:wait() until p == n end s.Connect = s.connect s.Wait = s.wait return s end',
  // x:Lerp(goal, a): 2016 has CFrame/Vector3 lerp only (Color3's is switched off).
  Lerp: `function(o, g, a) ${own('Lerp', 'g, a')} local ok, r = pcall(function() return o:lerp(g, a) end) if ok then return r end `
    + 'ok, r = pcall(function() return UDim2.new(o.X.Scale + (g.X.Scale - o.X.Scale) * a, o.X.Offset + (g.X.Offset - o.X.Offset) * a, o.Y.Scale + (g.Y.Scale - o.Y.Scale) * a, o.Y.Offset + (g.Y.Offset - o.Y.Offset) * a) end) if ok then return r end '
    + 'return Color3.new(o.r + (g.r - o.r) * a, o.g + (g.g - o.g) * a, o.b + (g.b - o.b) * a) end',
  // TweenService on 2016 (it has the service, no Create): tweens run on wait().
  TweenService: `function(game) local ok, s = pcall(function() return game:GetService("TweenService") end) if ok and s and pcall(function() return s.Create end) then return s end ${TWEEN_SERVICE} end`,
  // TextSize (2016 has FontSize): the nearest size.
  SetTextSize: 'function(o, n, v) if pcall(function() o.TextSize = v end) then return end local best, d = "Size14", math.huge '
    + 'for _, x in ipairs({8, 9, 10, 11, 12, 14, 18, 24, 28, 32, 36, 42, 48, 60, 96}) do if math.abs(x - v) < d then best, d = "Size" .. x, math.abs(x - v) end end pcall(function() o.FontSize = Enum.FontSize[best] end) end',
  TextSize: 'function(o) local ok, v = pcall(function() return o.TextSize end) if ok then return v end local ok2, f = pcall(function() return o.FontSize end) '
    + 'if ok2 and f then return tonumber(tostring(f):match("Size(%d+)")) or 14 end return 14 end',
  // typeof (2016 has only type): Instances and the usual value types.
  typeof: 'function(v) local t = type(v) if t ~= "userdata" then return t end if pcall(function() return v.ClassName end) then return "Instance" end '
    + 'local function has(k) return (pcall(function() return v[k] end)) end '
    + 'if has("lookVector") then return "CFrame" elseif has("Origin") and has("Direction") then return "Ray" elseif has("Scale") and has("Offset") then return "UDim" '
    + 'elseif has("X") and has("Y") then if has("Z") then return "Vector3" end local ok, x = pcall(function() return v.X.Scale end) if ok and x then return "UDim2" end return "Vector2" '
    + 'elseif has("Number") and has("Color") then return "BrickColor" elseif has("r") and has("g") then return "Color3" elseif has("Min") and has("Max") then return "NumberRange" '
    + 'elseif has("Keypoints") then return "ColorSequence" elseif has("connect") then return "RBXScriptSignal" elseif has("disconnect") then return "RBXScriptConnection" end return "userdata" end',
  // Enum types 2017 lacks: items are their names.
  EnumType: 'function(n) return setmetatable({}, {__index = function(_, k) if k == "GetEnumItems" then return function() return {} end end return k end, __tostring = function() return n end}) end',
};

// Helpers a script converted before may have in an older form that is now
// wrong (game passes were always owned, their prompt did nothing and
// PromptGamePassPurchaseFinished never fired; Raycast failed on nested
// filter lists): name -> [change, text the script must also have]. Where the
// script has the helper but not its current text, the current one is added
// again (a later field wins).
const REFRESHED = {
  Raycast: [':Raycast', ''],
  UserOwnsGamePassAsync: [':UserOwnsGamePassAsync', ''],
  PromptGamePassPurchase: [':PromptGamePassPurchase', ''],
  Event: ['.PromptGamePassPurchaseFinished', '"PromptGamePassPurchaseFinished"'],
};

// Pieces of the stand-ins below.
const CANCEL = 'local C = _G.__rbx2017Cancelled if not C then C = setmetatable({}, {__mode = "k"}) _G.__rbx2017Cancelled = C end C[co] = true';
const RESUME_LATER = 'local C = _G.__rbx2017Cancelled if (C and C[co]) or coroutine.status(co) ~= "suspended" then return end '
  + 'local ok, e = coroutine.resume(co, unpack(a, 1, n)) if not ok then error(e, 0) end';
const OUT_OF_BOUNDS = 'error("buffer access out of bounds", 2)';
const bounds = (size) => `if o < 0 or o + ${size} > #b or o % 1 ~= 0 then ${OUT_OF_BOUNDS} end`;
const WRITE32 = 'v = math.floor(v) % 4294967296 b[o + 1] = v % 256 b[o + 2] = math.floor(v / 256) % 256 b[o + 3] = math.floor(v / 65536) % 256 b[o + 4] = math.floor(v / 16777216)';
// A bit32 function over any number of arguments: start value, and when a bit
// of the result is set (s, t: the bits of the result so far and of the next).
const bitop = (start, rule) => `function(...) local r = ${start} for i = 1, select("#", ...) do local a, b, x, p = r, math.floor((select(i, ...))) % 4294967296, 0, 1 `
  + `for _ = 1, 32 do local s, t = a % 2, b % 2 if ${rule} then x = x + p end a = (a - s) / 2 b = (b - t) / 2 p = p * 2 end r = x end return r end`;

// A DateTime stand-in from Unix milliseconds.
const DATETIME = 'function(ms) local d = {UnixTimestampMillis = ms, UnixTimestamp = math.floor(ms / 1000)} '
  + 'local function parts(f) local t = os.date(f, d.UnixTimestamp) return {Year = t.year, Month = t.month, Day = t.day, Hour = t.hour, Minute = t.min, Second = t.sec, Millisecond = ms % 1000} end '
  + 'function d:ToUniversalTime() return parts("!*t") end function d:ToLocalTime() return parts("*t") end '
  + 'function d:ToIsoDate() return os.date("!%Y-%m-%dT%H:%M:%SZ", d.UnixTimestamp) end '
  + 'function d:FormatUniversalTime() return os.date("!%c", d.UnixTimestamp) end function d:FormatLocalTime() return os.date("%c", d.UnixTimestamp) end return d end';

// string.pack/unpack's shared parts: INT sizes, item(fmt, i) -> option,
// next index, count; order(bytes, little) -> string; float(v, single) ->
// little-endian bytes; unfloat(little-endian bytes) -> number.
const PACK_COMMON = 'local INT = {b = 1, B = 1, h = 2, H = 2, i = 4, I = 4, l = 8, L = 8, j = 8, J = 8, T = 8} '
  + 'local function item(fmt, i) local c = fmt:sub(i, i) i = i + 1 local d = fmt:match("^%d+", i) if d then i = i + #d end return c, i, tonumber(d) end '
  + 'local function order(b, little) if not little then local t = {} for k = 1, #b do t[k] = b[#b + 1 - k] end b = t end return string.char(unpack(b)) end '
  + 'local function float(v, single) local eb, mb, bias = single and 8 or 11, single and 23 or 52, single and 127 or 1023 local s, e, m = 0, 0, 0 '
  + 'if v ~= v then e, m = 2 ^ eb - 1, 2 ^ (mb - 1) else if v < 0 or (v == 0 and 1 / v < 0) then s = 1 v = -v end '
  + 'if v == math.huge then e = 2 ^ eb - 1 elseif v ~= 0 then local f, x = math.frexp(v) x = x + bias - 1 '
  + 'if x <= 0 then m = math.floor(v / 2 ^ (1 - bias - mb) + 0.5) else e = x m = math.floor((f * 2 - 1) * 2 ^ mb + 0.5) if m >= 2 ^ mb then m = 0 e = e + 1 end end end end '
  + 'local b = {} local n = single and 3 or 7 for k = 1, n - 1 do b[k] = m % 256 m = math.floor(m / 256) end '
  + 'local low = single and 128 or 16 b[n] = m + e % (single and 2 or 16) * low b[n + 1] = s * 128 + math.floor(e / (single and 2 or 16)) return b end '
  + 'local function unfloat(b) local single = #b == 4 local mb, bias, n = single and 23 or 52, single and 127 or 1023, single and 3 or 7 '
  + 'local low = single and 128 or 16 local m = 0 for k = n - 1, 1, -1 do m = m * 256 + b[k] end m = m + b[n] % low * 2 ^ (8 * (n - 1)) '
  + 'local e = b[n + 1] % 128 * (single and 2 or 16) + math.floor(b[n] / low) local s = b[n + 1] >= 128 and -1 or 1 local top = single and 255 or 2047 '
  + 'if e == 0 then return s * m * 2 ^ (1 - bias - mb) end if e == top then if m == 0 then return s * math.huge end return 0 / 0 end return s * (1 + m / 2 ^ mb) * 2 ^ (e - bias) end ';

// Library members the 2017 engine lacks: library -> member -> Lua value.
const LIBRARY = {
  math: {
    clamp: 'function(x, a, b) if x < a then return a elseif x > b then return b end return x end',
    sign: 'function(x) if x > 0 then return 1 elseif x < 0 then return -1 end return 0 end',
    round: 'function(x) if x >= 0 then return math.floor(x + 0.5) end return math.ceil(x - 0.5) end',
    // 2017's math.log ignores a base.
    log: 'function(x, b) if b then return math.log(x) / math.log(b) end return math.log(x) end',
  },
  table: {
    find: 'function(t, v, init) for i = init or 1, #t do if t[i] == v then return i end end return nil end',
    clear: 'function(t) for k in pairs(t) do t[k] = nil end end',
    unpack: 'unpack',
    pack: 'function(...) return {n = select("#", ...), ...} end',
    create: 'function(n, v) local t = {} for i = 1, n do t[i] = v end return t end',
    freeze: 'function(t) return t end',
    isfrozen: 'function(t) return false end',
    clone: 'function(t) local r = {} for k, v in pairs(t) do r[k] = v end local m = getmetatable(t) if type(m) == "table" then setmetatable(r, m) end return r end',
    move: 'function(a, f, e, t, b) b = b or a if e >= f then if t > f and t <= e and a == b then for i = e - f, 0, -1 do b[t + i] = a[f + i] end else for i = 0, e - f do b[t + i] = a[f + i] end end end return b end',
  },
  string: {
    split: 'HELPER_split',
    // string.pack/unpack (Lua 5.3, Luau): integers (b B h H i[n] I[n] l L j J),
    // f d n, s[n], z, x, and < > = byte order.
    pack: `(function() ${PACK_COMMON} return function(fmt, ...) local args, ai, out, little, i = {...}, 1, {}, true, 1 `
      + 'while i <= #fmt do local c, n c, i, n = item(fmt, i) '
      + 'if c == "<" or c == "=" then little = true elseif c == ">" then little = false elseif c == "x" then out[#out + 1] = "\\0" '
      + 'elseif INT[c] then local size = n or INT[c] local v = math.floor(args[ai]) ai = ai + 1 if v < 0 then v = v + 2 ^ (8 * size) end '
      + 'local b = {} for k = 1, size do b[k] = v % 256 v = math.floor(v / 256) end out[#out + 1] = order(b, little) '
      + 'elseif c == "f" or c == "d" or c == "n" then out[#out + 1] = order(float(args[ai], c == "f"), little) ai = ai + 1 '
      + 'elseif c == "s" then local s = tostring(args[ai]) ai = ai + 1 local size, v, b = n or 8, #s, {} for k = 1, n or 8 do b[k] = v % 256 v = math.floor(v / 256) end out[#out + 1] = order(b, little) .. s '
      + 'elseif c == "z" then out[#out + 1] = tostring(args[ai]) .. "\\0" ai = ai + 1 end end return table.concat(out) end end)()',
    unpack: `(function() ${PACK_COMMON} return function(fmt, s, pos) local r, little, i, p = {}, true, 1, pos or 1 `
      + 'local function bytes(size) local b = {s:byte(p, p + size - 1)} p = p + size if not little then local t = {} for k = 1, #b do t[k] = b[#b + 1 - k] end b = t end return b end '
      + 'while i <= #fmt do local c, n c, i, n = item(fmt, i) '
      + 'if c == "<" or c == "=" then little = true elseif c == ">" then little = false elseif c == "x" then p = p + 1 '
      + 'elseif INT[c] then local size = n or INT[c] local b, v = bytes(size), 0 for k = size, 1, -1 do v = v * 256 + (b[k] or 0) end '
      + 'if c:lower() == c and v >= 2 ^ (8 * size - 1) then v = v - 2 ^ (8 * size) end r[#r + 1] = v '
      + 'elseif c == "f" or c == "d" or c == "n" then r[#r + 1] = unfloat(bytes(c == "f" and 4 or 8)) '
      + 'elseif c == "s" then local b, v = bytes(n or 8), 0 for k = #b, 1, -1 do v = v * 256 + b[k] end r[#r + 1] = s:sub(p, p + v - 1) p = p + v '
      + 'elseif c == "z" then local e = s:find("\\0", p, true) or (#s + 1) r[#r + 1] = s:sub(p, e - 1) p = e + 1 end end r[#r + 1] = p return unpack(r) end end)()',
  },
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
  CFrame: {
    lookAt: 'function(a, b) return CFrame.new(a, b) end',
    // CFrame.fromMatrix (2019): the columns of the rotation are x, y, z.
    fromMatrix: 'function(p, x, y, z) z = z or x:Cross(y).unit return CFrame.new(p.X, p.Y, p.Z, x.X, y.X, z.X, x.Y, y.Y, z.Y, x.Z, y.Z, z.Z) end',
  },
  Color3: {
    fromHex: 'function(h) h = tostring(h):gsub("#", "") return Color3.new(tonumber(h:sub(1, 2), 16) / 255, tonumber(h:sub(3, 4), 16) / 255, tonumber(h:sub(5, 6), 16) / 255) end',
  },
  coroutine: {
    close: `function(co) ${CANCEL} return true end`,
    isyieldable: 'function() return true end',
  },
  // task (2021). 2017's spawn and delay pass no arguments and return no
  // thread; these run threads as coroutines (2017 resumes a coroutine that
  // waits). A cancelled thread stops at its next task.wait.
  task: {
    spawn: 'function(f, ...) local co = type(f) == "thread" and f or coroutine.create(f) local ok, e = coroutine.resume(co, ...) if not ok then spawn(function() error(e, 0) end) end return co end',
    defer: `function(f, ...) local co = type(f) == "thread" and f or coroutine.create(f) local n, a = select("#", ...), {...} spawn(function() ${RESUME_LATER} end) return co end`,
    delay: `function(t, f, ...) local co = type(f) == "thread" and f or coroutine.create(f) local n, a = select("#", ...), {...} delay(t or 0, function() ${RESUME_LATER} end) return co end`,
    wait: 'function(t) local co = coroutine.running() local r = wait(t) local C = _G.__rbx2017Cancelled if C and C[co] then Instance.new("BindableEvent").Event:wait() end return r end',
    cancel: `function(co) ${CANCEL} end`,
    synchronize: 'function() end',
    desynchronize: 'function() end',
  },
  // bit32 (Lua 5.2, in Roblox since 2018), on 32-bit unsigned numbers.
  bit32: {
    band: bitop('4294967295', 's == 1 and t == 1'),
    bor: bitop('0', 's == 1 or t == 1'),
    bxor: bitop('0', 's ~= t'),
    btest: `function(...) return (${bitop('4294967295', 's == 1 and t == 1')})(...) ~= 0 end`,
    bnot: 'function(x) return 4294967295 - math.floor(x) % 4294967296 end',
    lshift: 'function(x, n) x = math.floor(x) % 4294967296 if n < 0 then return math.floor(x / 2 ^ -n) end if n >= 32 then return 0 end return x * 2 ^ n % 4294967296 end',
    rshift: 'function(x, n) x = math.floor(x) % 4294967296 if n < 0 then return x * 2 ^ -n % 4294967296 end if n >= 32 then return 0 end return math.floor(x / 2 ^ n) end',
    arshift: 'function(x, n) x = math.floor(x) % 4294967296 if n <= 0 then return x * 2 ^ -n % 4294967296 end if n >= 32 then return x >= 2147483648 and 4294967295 or 0 end '
      + 'local r = math.floor(x / 2 ^ n) if x >= 2147483648 then r = r + 4294967296 - 2 ^ (32 - n) end return r end',
    extract: 'function(x, f, w) w = w or 1 return math.floor((math.floor(x) % 4294967296) / 2 ^ f) % 2 ^ w end',
    replace: 'function(x, v, f, w) w = w or 1 local m = 2 ^ w x = math.floor(x) % 4294967296 local old = math.floor(x / 2 ^ f) % m return x - old * 2 ^ f + (math.floor(v) % m) * 2 ^ f end',
    lrotate: 'function(x, n) x = math.floor(x) % 4294967296 n = n % 32 return x * 2 ^ n % 4294967296 + math.floor(x / 2 ^ (32 - n)) end',
    rrotate: 'function(x, n) x = math.floor(x) % 4294967296 n = n % 32 return math.floor(x / 2 ^ n) + x * 2 ^ (32 - n) % 4294967296 end',
    countlz: 'function(x) x = math.floor(x) % 4294967296 if x == 0 then return 32 end local n = 0 while x < 2147483648 do x = x * 2 n = n + 1 end return n end',
    countrz: 'function(x) x = math.floor(x) % 4294967296 if x == 0 then return 32 end local n = 0 while x % 2 == 0 do x = x / 2 n = n + 1 end return n end',
    byteswap: 'function(x) x = math.floor(x) % 4294967296 return x % 256 * 16777216 + math.floor(x / 256) % 256 * 65536 + math.floor(x / 65536) % 256 * 256 + math.floor(x / 16777216) end',
  },
  // buffer (2023): an array of bytes (b[1] is offset 0), so it also goes
  // through remotes (as a plain array; typeof(x) == "buffer" -> IsBuffer).
  buffer: {
    create: 'function(n) local b = {} for i = 1, n do b[i] = 0 end return b end',
    len: 'function(b) return #b end',
    fromstring: 'function(s) local b = {} for i = 1, #s, 4096 do local t = {s:byte(i, math.min(#s, i + 4095))} for k = 1, #t do b[i + k - 1] = t[k] end end return b end',
    tostring: 'function(b) local p = {} for i = 1, #b, 4096 do p[#p + 1] = string.char(unpack(b, i, math.min(#b, i + 4095))) end return table.concat(p) end',
    copy: `function(t, to, s, so, n) so = so or 0 n = n or (#s - so) if to < 0 or so < 0 or n < 0 or to + n > #t or so + n > #s then ${OUT_OF_BOUNDS} end `
      + 'if t == s and to > so then for i = n, 1, -1 do t[to + i] = s[so + i] end else for i = 1, n do t[to + i] = s[so + i] end end end',
    fill: `function(b, o, v, n) n = n or (#b - o) if o < 0 or n < 0 or o + n > #b then ${OUT_OF_BOUNDS} end v = math.floor(v) % 256 for i = o + 1, o + n do b[i] = v end end`,
    readu8: `function(b, o) ${bounds(1)} return b[o + 1] end`,
    readi8: `function(b, o) ${bounds(1)} local v = b[o + 1] if v >= 128 then return v - 256 end return v end`,
    readu16: `function(b, o) ${bounds(2)} return b[o + 1] + b[o + 2] * 256 end`,
    readi16: `function(b, o) ${bounds(2)} local v = b[o + 1] + b[o + 2] * 256 if v >= 32768 then return v - 65536 end return v end`,
    readu32: `function(b, o) ${bounds(4)} return b[o + 1] + b[o + 2] * 256 + b[o + 3] * 65536 + b[o + 4] * 16777216 end`,
    readi32: `function(b, o) ${bounds(4)} local v = b[o + 1] + b[o + 2] * 256 + b[o + 3] * 65536 + b[o + 4] * 16777216 if v >= 2147483648 then return v - 4294967296 end return v end`,
    writeu8: `function(b, o, v) ${bounds(1)} b[o + 1] = math.floor(v) % 256 end`,
    writei8: `function(b, o, v) ${bounds(1)} b[o + 1] = math.floor(v) % 256 end`,
    writeu16: `function(b, o, v) ${bounds(2)} v = math.floor(v) % 65536 b[o + 1] = v % 256 b[o + 2] = math.floor(v / 256) end`,
    writei16: `function(b, o, v) ${bounds(2)} v = math.floor(v) % 65536 b[o + 1] = v % 256 b[o + 2] = math.floor(v / 256) end`,
    writeu32: `function(b, o, v) ${bounds(4)} ${WRITE32} end`,
    writei32: `function(b, o, v) ${bounds(4)} ${WRITE32} end`,
    readstring: `function(b, o, n) if o < 0 or n < 0 or o + n > #b then ${OUT_OF_BOUNDS} end local p = {} `
      + 'for i = o + 1, o + n, 4096 do p[#p + 1] = string.char(unpack(b, i, math.min(o + n, i + 4095))) end return table.concat(p) end',
    writestring: `function(b, o, s, n) n = n or #s if n > #s or o < 0 or o + n > #b then ${OUT_OF_BOUNDS} end for i = 1, n do b[o + i] = s:byte(i) end end`,
    writef32: `function(b, o, v) ${bounds(4)} local s, e, m = 0, 0, 0 if v ~= v then e, m = 255, 4194304 else `
      + 'if v < 0 or (v == 0 and 1 / v < 0) then s = 128 v = -v end if v == math.huge then e = 255 elseif v ~= 0 then local f, x = math.frexp(v) x = x + 126 '
      + 'if x <= 0 then m = math.floor(v / 2 ^ -149 + 0.5) if m >= 8388608 then e, m = 1, m - 8388608 end '
      + 'else e = x m = math.floor((f * 2 - 1) * 8388608 + 0.5) if m >= 8388608 then m = 0 e = e + 1 end if e >= 255 then e, m = 255, 0 end end end end '
      + 'b[o + 1] = m % 256 b[o + 2] = math.floor(m / 256) % 256 b[o + 3] = math.floor(m / 65536) + e % 2 * 128 b[o + 4] = s + math.floor(e / 2) end',
    readf32: `function(b, o) ${bounds(4)} local b3, b4 = b[o + 3], b[o + 4] local s = b4 >= 128 and -1 or 1 local e = b4 % 128 * 2 + math.floor(b3 / 128) `
      + 'local m = b3 % 128 * 65536 + b[o + 2] * 256 + b[o + 1] if e == 0 then return s * math.ldexp(m, -149) elseif e == 255 then if m == 0 then return s * math.huge end return 0 / 0 end '
      + 'return s * math.ldexp(1 + m / 8388608, e - 127) end',
    writef64: `function(b, o, v) ${bounds(8)} local s, e, m = 0, 0, 0 if v ~= v then e, m = 2047, 2 ^ 51 else `
      + 'if v < 0 or (v == 0 and 1 / v < 0) then s = 128 v = -v end if v == math.huge then e = 2047 elseif v ~= 0 then local f, x = math.frexp(v) x = x + 1022 '
      + 'if x <= 0 then m = v / 2 ^ -1074 else e = x m = (f * 2 - 1) * 2 ^ 52 end end end '
      + 'for i = 1, 6 do b[o + i] = m % 256 m = math.floor(m / 256) end b[o + 7] = m + e % 16 * 16 b[o + 8] = s + math.floor(e / 16) end',
    readf64: `function(b, o) ${bounds(8)} local m = 0 for i = 6, 1, -1 do m = m * 256 + b[o + i] end local b7, b8 = b[o + 7], b[o + 8] m = m + b7 % 16 * 2 ^ 48 `
      + 'local e = b8 % 128 * 16 + math.floor(b7 / 16) local s = b8 >= 128 and -1 or 1 if e == 0 then return s * math.ldexp(m, -1074) '
      + 'elseif e == 2047 then if m == 0 then return s * math.huge end return 0 / 0 end return s * math.ldexp(1 + m / 2 ^ 52, e - 1023) end',
  },
  // Luau's vector library (2024) on Vector3.
  vector: {
    create: 'function(x, y, z) return Vector3.new(x, y, z or 0) end',
    magnitude: 'function(v) return v.magnitude end',
    normalize: 'function(v) return v.unit end',
    dot: 'function(a, b) return a:Dot(b) end',
    cross: 'function(a, b) return a:Cross(b) end',
    zero: 'Vector3.new(0, 0, 0)',
    one: 'Vector3.new(1, 1, 1)',
    abs: 'function(v) return Vector3.new(math.abs(v.X), math.abs(v.Y), math.abs(v.Z)) end',
    floor: 'function(v) return Vector3.new(math.floor(v.X), math.floor(v.Y), math.floor(v.Z)) end',
    ceil: 'function(v) return Vector3.new(math.ceil(v.X), math.ceil(v.Y), math.ceil(v.Z)) end',
    max: 'function(a, b) return Vector3.new(math.max(a.X, b.X), math.max(a.Y, b.Y), math.max(a.Z, b.Z)) end',
    min: 'function(a, b) return Vector3.new(math.min(a.X, b.X), math.min(a.Y, b.Y), math.min(a.Z, b.Z)) end',
  },
  // OverlapParams (2021), for the spatial query stand-ins.
  OverlapParams: {
    new: 'function() local p = {FilterDescendantsInstances = {}, FilterType = "Exclude", MaxParts = 0, CollisionGroup = "Default", RespectCanCollide = false, BruteForceAllSlow = false} '
      + 'function p:AddToFilter(x) local t = self.FilterDescendantsInstances t[#t + 1] = x end return p end',
  },
  // debug's newer members: memory categories do nothing; info gives
  // placeholders (2017 cannot look at other functions' sources).
  debug: {
    setmemorycategory: 'function() return "" end',
    resetmemorycategory: 'function() end',
    info: 'function(a, b, c) local o = c or b if type(o) ~= "string" then return nil end local r, n = {}, 0 for ch in o:gmatch(".") do '
      + 'if ch == "s" then n = n + 1 r[n] = "?" elseif ch == "l" then n = n + 1 r[n] = -1 elseif ch == "n" then n = n + 1 r[n] = "" '
      + 'elseif ch == "a" then r[n + 1] = 0 r[n + 2] = false n = n + 2 elseif ch == "f" then n = n + 1 r[n] = type(a) == "function" and a or nil end end return unpack(r, 1, n) end',
  },
  // DateTime (2020) on os.time/tick.
  DateTime: {
    now: `function() return (${DATETIME})(os.time() * 1000 + math.floor(tick() % 1 * 1000)) end`,
    fromUnixTimestamp: `function(s) return (${DATETIME})(math.floor(s * 1000)) end`,
    fromUnixTimestampMillis: `function(ms) return (${DATETIME})(math.floor(ms)) end`,
  },
  // Font (2022): FontFace is newer too (its setting is skipped), so a table does.
  Font: {
    new: 'function(f, w, s) return {Family = f, Weight = w, Style = s} end',
    fromEnum: 'function(e) return {Family = tostring(e)} end',
    fromName: 'function(n, w, s) return {Family = n, Weight = w, Style = s} end',
    fromId: 'function(i, w, s) return {Family = i, Weight = w, Style = s} end',
  },
};

// What the 2016 engine lacks that 2017 has (each checked in the 2016 RCC with
// tools/converter-corpus.js probe), given to scripts converted for an engine
// older than 2017: library members, methods (-> helpers), properties scripts
// set that it lacks (guarded), and globals.
const LIBRARY_2016 = {
  // Color3.fromRGB/fromHSV are there but switched off ("not yet enabled").
  Color3: {
    fromRGB: 'function(r, g, b) return Color3.new((r or 0) / 255, (g or 0) / 255, (b or 0) / 255) end',
    fromHSV: 'function(h, s, v) local i = math.floor(h * 6) local f = h * 6 - i local p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s) i = i % 6 '
      + 'if i == 0 then return Color3.new(v, t, p) elseif i == 1 then return Color3.new(q, v, p) elseif i == 2 then return Color3.new(p, v, t) '
      + 'elseif i == 3 then return Color3.new(p, q, v) elseif i == 4 then return Color3.new(t, p, v) end return Color3.new(v, p, q) end',
    toHSV: 'function(c) local r, g, b = c.r, c.g, c.b local mx, mn = math.max(r, g, b), math.min(r, g, b) local d = mx - mn local h = 0 '
      + 'if d > 0 then if mx == r then h = ((g - b) / d) % 6 elseif mx == g then h = (b - r) / d + 2 else h = (r - g) / d + 4 end h = h / 6 end '
      + 'return h, mx > 0 and d / mx or 0, mx end',
  },
  CFrame: {
    fromOrientation: 'function(x, y, z) return CFrame.Angles(0, y, 0) * CFrame.Angles(x, 0, 0) * CFrame.Angles(0, 0, z) end',
    fromEulerAnglesYXZ: 'function(x, y, z) return CFrame.Angles(0, y, 0) * CFrame.Angles(x, 0, 0) * CFrame.Angles(0, 0, z) end',
    fromEulerAnglesXYZ: 'function(x, y, z) return CFrame.Angles(x, y, z) end',
  },
  TweenInfo: {
    new: 'function(t, s, d, r, rev, delay) return {Time = t or 1, EasingStyle = s or Enum.EasingStyle.Quad, EasingDirection = d or Enum.EasingDirection.Out, '
      + 'RepeatCount = r or 0, Reverses = rev or false, DelayTime = delay or 0} end',
  },
};
const METHODS_2016 = {
  Connect: [1], Wait: [0], Disconnect: [0], FindFirstChildOfClass: [1], FindFirstChildWhichIsA: [1, 2], FindFirstAncestor: [1],
  FindFirstAncestorOfClass: [1], FindFirstAncestorWhichIsA: [1], GetPropertyChangedSignal: [1], Lerp: [2],
};
const SETTABLE_2016 = new Set(['AnchorPoint', 'Enabled', 'ResetOnSpawn', 'LayoutOrder', 'DisplayOrder', 'ZIndexBehavior', 'Orientation', 'PlaybackSpeed']);

// An engine older than 2017 (2016), which lacks the *_2016 things above.
function olderThan2017(api = API) {
  return Boolean(api) && Number(api.engine) < 2017;
}

// Names from scripts index these tables: with no prototype, a Lua name such
// as constructor or toString finds nothing instead of Object's own.
for (const table of [NEWER_PROPERTIES, READ_HELPERS, SETTERS, OPEN, CLOSE, METHODS, TAG_BODIES, NEWER_METHODS, CS_METHODS, CS_PARAMS,
  HELPERS, REFRESHED, LIBRARY, ...Object.values(LIBRARY), LIBRARY_2016, ...Object.values(LIBRARY_2016), METHODS_2016]) Object.setPrototypeOf(table, null);

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
function fontFor(name, fonts = FONTS_2017) {
  const pick = (wanted) => (fonts.has(wanted) ? wanted : null);
  if (/Black|Bold|Heavy|Semibold|SemiBold|Medium/.test(name)) return 'SourceSansBold';
  if (/Light|Thin/.test(name)) return 'SourceSansLight';
  if (/Italic/.test(name)) return 'SourceSansItalic';
  if (/Fredoka|Bangers|Luckiest|Cartoon|Creepster/.test(name)) return pick('Cartoon') || 'SourceSansBold';
  if (/Mono|Code|Roboto ?Mono|Ubuntu ?Mono/.test(name)) return pick('Code') || 'SourceSans';
  if (/Arcade|PressStart|Pixel/.test(name)) return pick('Arcade') || 'SourceSansBold';
  // 2017's fonts on an engine without them (2016 has 0-6).
  if (/^(?:Highway|SciFi|Fantasy)$/.test(name)) return 'SourceSansBold';
  return 'SourceSans';
}

// Enum.Font names the engine has.
function fontsOf(api) {
  const fonts = api && api.enum('Font');
  return fonts ? new Set(fonts.keys()) : FONTS_2017;
}

// A require-by-string path -> the Lua expression of that instance, or null.
// "./X" is a sibling of the script, "../X" one level up, "@self/X" the
// script's own child, "@game/Service/X" from a service; ".lua(u)" endings
// and a last "init" are dropped.
function requireTarget(spec) {
  const parts = spec.split('/').filter((p) => p !== '');
  const first = parts.shift();
  let base;
  if (first === '@self') base = 'script';
  else if (first === '.') base = 'script.Parent';
  else if (first === '..') base = 'script.Parent.Parent';
  else if (first === '@game' && parts.length > 0) base = `game:GetService(${JSON.stringify(parts.shift())})`;
  else return null;
  while (parts[0] === '..') { parts.shift(); base += '.Parent'; }
  const names = parts.filter((p) => p !== '.').map((p) => p.replace(/\.luau?$/i, ''));
  if (names.length > 0 && names[names.length - 1] === 'init') names.pop();
  if (names.some((n) => n === '..')) return null;
  return base + names.map((n) => `:WaitForChild(${JSON.stringify(n)})`).join('');
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
    // local Random = Random.new() / local math = math: the value is still the
    // library (it needs its stand-in first).
    if (before.type === 'keyword' && before.value === 'local' && j === i - 1 && isSymbol(tokens[i + 1], '=')
      && tokens[i + 2] && tokens[i + 2].type === 'name' && tokens[i + 2].value === name) continue;
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
  // A union or intersection may start with its operator (type T =\n | A\n | B).
  if (isSymbol(tokens[i], '|') || isSymbol(tokens[i], '&')) i++;
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
  } else if (isSymbol(t, '<')) {
    // a generic function type: <T>(a: T) -> T
    let depth = 0;
    for (; i < tokens.length; i++) {
      if (isSymbol(tokens[i], '<')) depth++;
      else if (isSymbol(tokens[i], '>') && --depth === 0) break;
    }
    return isSymbol(tokens[i + 1], '(') ? skipType(tokens, i + 1) : -1;
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
      // a generic type pack: T...
      if (isSymbol(tokens[i], '...')) i++;
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
  // The line breaks of a cut stay, so error line numbers match the source.
  for (const [start, end] of cuts) out = out.slice(0, start) + out.slice(start, end).replace(/[^\n]/g, '') + out.slice(end);
  return out;
}

// options: attributes (the place has attributes: GetChildren leaves out their
// folders), newerProperties (a Set of property names the place's file has that
// 2017 lacks: setting them is guarded like NEWER_SETTABLE).
function convertSource(source, options = {}) {
  if (typeof source !== 'string') return { text: source, changes: [] };
  const previous = API;
  API = apiFor(options);
  try {
    return convertWith(source, options);
  } finally {
    API = previous;
  }
}

function convertWith(source, options) {
  // What the engine lacks beyond 2017's gaps (2016: the *_2016 tables).
  const older = olderThan2017();
  const methods = older ? Object.assign(Object.create(null), METHODS, METHODS_2016) : METHODS;
  const readHelpers = older ? Object.assign(Object.create(null), READ_HELPERS, { TextSize: 'TextSize' }) : READ_HELPERS;
  const library = older ? Object.create(null) : LIBRARY;
  if (older) {
    for (const name of new Set([...Object.keys(LIBRARY), ...Object.keys(LIBRARY_2016)])) {
      library[name] = Object.assign(Object.create(null), LIBRARY[name] || {}, LIBRARY_2016[name] || {});
    }
  }
  const settable = (name) => NEWER_SETTABLE.has(name) || newerCommonProperty(name) || (older && (SETTABLE_2016.has(name) || name === 'TextSize'));
  const newerProperties = options.newerProperties || null;
  // A script converted before gets only the rewrites added since (newer
  // services and properties); everything else was done then.
  const marked = source.startsWith(MARK);
  // C0 needs its stand-in (C0/SetC0) only where Transform is used; elsewhere
  // the extra helper reference could push a big function past Lua 5.1's 60
  // upvalues (Phantom Forces' Framework).
  const usesTransform = /\.Transform\b/.test(source);
  // Plain variables the script uses as CFrames (x.CFrame = pos, local pos =
  // CFrame.new(...) / part.CFrame / model:GetPivot()): pos.Position then goes
  // through the CFrame stand-in too (Bloxburg's build teleport).
  const cframeNames = new Set();
  for (const m of source.matchAll(/\.CFrame\s*=\s*([A-Za-z_]\w*)\s*(?:$|[\r\n;]|--)/gm)) cframeNames.add(m[1]);
  for (const m of source.matchAll(/\blocal\s+([A-Za-z_]\w*)\s*=\s*(?:CFrame\.\w+\s*\(|[\w.:[\]"]*(?:\.CFrame|:GetPivot\(\)|:GetModelCFrame\(\)|:GetPrimaryPartCFrame\(\)|:\w*CFrame\([^()\r\n]*\))\s*(?:$|[\r\n;*]|--))/gm)) cframeNames.add(m[1]);
  // (also local x = VRService:GetUserCFrame(...), Cube Cavern's VR hands)
  for (const name of ['self', 'script', 'game', 'workspace', 'Workspace']) cframeNames.delete(name);
  let text = source;
  const changes = new Set();
  const helpers = new Set();

  // 0. Luau type annotations.
  const untyped = marked ? text : stripTypes(text);
  if (untyped !== text) {
    text = untyped;
    changes.add('type annotations');
  }
  // Luau-only syntax (continue, if-expressions, `strings`, //...) in Lua 5.1
  // (lib/luaulower.js); scripts converted before may still have it.
  const lowered = luaulower.lower(text);
  if (lowered.text !== text) {
    text = lowered.text;
    for (const change of lowered.changes) changes.add(change);
    for (const helper of lowered.helpers) helpers.add(helper);
  }
  // a.Locked, a.CastShadow = true, false: newer properties among several targets.
  const split = luaulower.guardMultipleAssignments(text, (name) => settable(name) || (newerProperties !== null && newerProperties.has(name)));
  if (split.count > 0) {
    text = split.text;
    changes.add('newer properties set with others');
  }
  // GetUserCFrame(("Floor")) from earlier conversions (a string can't be passed
  // for an enum): Head, as Enum.UserCFrame.Floor now becomes (see ENUM_NEAREST).
  text = text.replace(/(:GetUserCFrame(?:Enabled)?\(\s*)\(\s*"Floor"\s*\)(\s*\))/g, (match, open, close) => {
    changes.add('newer Enum items');
    return `${open}Enum.UserCFrame.Head${close}`;
  });
  // BasePart.AssemblyLinearVelocity/AssemblyAngularVelocity (2020) are the
  // part's Velocity/RotVelocity in 2017.
  text = text.replace(/\.Assembly(Linear|Angular)Velocity\b/g, (match, kind) => {
    changes.add(`.Assembly${kind}Velocity`);
    return kind === 'Linear' ? '.Velocity' : '.RotVelocity';
  });
  // RunService.PreRender / PostSimulation (2023) -> RenderStepped / Heartbeat
  // (both pass the frame time, as these do).
  if (unknownTo2017('PreRender')) {
    text = text.replace(/\.(PreRender|PostSimulation)\b(?!\s*=(?!=))/g, (match, name) => {
      changes.add(`RunService.${name}`);
      return name === 'PreRender' ? '.RenderStepped' : '.Heartbeat';
    });
  }
  // alignOrientation.CFrame = x (OneAttachment mode, 2022): 2017's
  // AlignOrientation turns Attachment0 to Attachment1, so one is made to hold x.
  text = text.split('\n').map((line) => {
    const m = /^(\s*)([A-Za-z_][\w.]*[Aa]lign\w*|[A-Za-z_][\w.]*\.AlignOrientation)\.CFrame\s*=\s*([^=].*?)\s*(\r?)$/.exec(line);
    if (!m || m[3].includes('--') || m[3].includes(';') || /\b(?:then|do|end|local)\b/.test(m[3])) return line;
    helpers.add('SetAlignCF');
    changes.add('AlignOrientation.CFrame =');
    return `${m[1]}__rbx2017.SetAlignCF(${m[2]}, ${m[3]})${m[4]}`;
  }).join('\n');
  // attachment.WorldCFrame = expression (a whole line) -> __rbx2017.SetWorldCF(attachment, expression).
  text = text.split('\n').map((line) => {
    const m = /^(\s*)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^[\]\n]+\])*)\.WorldCFrame\s*=\s*([^=].*?)\s*(\r?)$/.exec(line);
    if (!m || m[3].includes('--') || m[3].includes(';') || /\b(?:then|do|end|local)\b/.test(m[3])) return line;
    helpers.add('SetWorldCF');
    changes.add('.WorldCFrame =');
    return `${m[1]}__rbx2017.SetWorldCF(${m[2]}, ${m[3]})${m[4]}`;
  }).join('\n');
  // typeof(x) == "buffer": buffers are byte arrays here (the buffer stand-in),
  // and arrive as plain arrays through remotes.
  text = text.replace(/\btypeof\s*\(\s*([A-Za-z_][\w.:[\]"']*)\s*\)\s*(==|~=)\s*(["'])buffer\3/g, (match, value, op) => {
    helpers.add('IsBuffer');
    changes.add('typeof buffer');
    return `${op === '~=' ? 'not ' : ''}__rbx2017.IsBuffer(${value})`;
  });
  // require("./Module"), require("@self/Module"), require("@game/Service/X")
  // (Luau's require by string, 2024) -> require of that instance; another
  // alias such as require("@rbx/Package") (Roblox's own packages) -> a
  // stand-in that takes any call. Before, every "@..." became the stand-in,
  // so packages that load their own parts this way (charm's @self/system)
  // silently did nothing.
  text = text.replace(/\brequire\s*\(\s*(["'])((?:\.{1,2}|@[\w-]+)(?:\/[^"'\\/\r\n]+)*)\1\s*\)/g, (match, quote, spec) => {
    const target = requireTarget(spec);
    if (target) {
      changes.add('require("./...")');
      return `require(${target})`;
    }
    if (!spec.startsWith('@')) return match;
    helpers.add('Stub');
    changes.add('require("@rbx/...")');
    return '__rbx2017.Stub()';
  });
  // "UnreliableRemoteEvent" (2023) anywhere (Instance.new(if u then "UnreliableRemoteEvent"
  // else "RemoteEvent"), IsA...) -> "RemoteEvent".
  text = text.replace(/(["'])UnreliableRemoteEvent\1/g, (match, quote) => {
    changes.add('UnreliableRemoteEvent');
    return `${quote}RemoteEvent${quote}`;
  });
  // Instance.new("NewerClass") -> a stand-in (UnreliableRemoteEvent -> RemoteEvent;
  // others take any property and method and do nothing).
  text = text.replace(/\bInstance\.new\s*\(\s*(["'])(\w+)\1/g, (match, quote, className) => {
    if (classKnownTo2017(className)) return match;
    helpers.add('New');
    changes.add(`Instance.new("${className}")`);
    return `__rbx2017.New(${quote}${className}${quote}`;
  });

  // 1. object:Method(...) -> __rbx2017.Method(object, ...), one at a time
  //    (each rewrite moves text, so the tokens are read again).
  for (let guard = 0; guard < 5000; guard++) {
    const tokens = tokenize(text);
    // An end marker, so the patterns see the last tokens of the script too.
    tokens.push({ type: 'eof', value: '', start: text.length, end: text.length });
    // A script converted before: its helper table and library stand-ins are
    // left as they are (every rule below leaves code it rewrote unmatched,
    // so the rest of such a script gets the rules it is missing).
    let helpersEnd = 0;
    if (marked) {
      const end = preludeEnd(tokens);
      helpersEnd = end > 0 ? tokens[end - 1].end : 0;
    }
    let done = true;
    for (let i = 1; i + 2 < tokens.length; i++) {
      if (tokens[i].start < helpersEnd) continue;
      // spawn(f, a, ...) / delay(t, f, a, ...) -> __rbx2017.Spawn / __rbx2017.Delay
      // (2017's give f the elapsed time instead of a, ...).
      if (tokens[i].type === 'name' && (tokens[i].value === 'spawn' || tokens[i].value === 'delay') && isSymbol(tokens[i + 1], '(')
        && !isSymbol(tokens[i - 1], '.') && !isSymbol(tokens[i - 1], ':') && !(tokens[i - 1].type === 'keyword' && tokens[i - 1].value === 'function')
        && !new RegExp(`\\b(local|function)\\s+(function\\s+)?${tokens[i].value}\\b`).test(text)) {
        const close = matchForward(tokens, i + 1);
        if (close >= 0 && argumentCount(tokens, i + 1, close) >= (tokens[i].value === 'spawn' ? 2 : 3)) {
          const name = tokens[i].value === 'spawn' ? 'Spawn' : 'Delay';
          text = `${text.slice(0, tokens[i].start)}__rbx2017.${name}${text.slice(tokens[i].end)}`;
          helpers.add(name);
          changes.add(`${tokens[i].value}(f, ...)`);
          done = false;
          break;
        }
      }
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
        // 2016 has a TweenService without Create: a working stand-in.
        if (literal && literal[2] === 'TweenService' && older && API && !API.member('TweenService', 'Create')) {
          const at = prefixStart(tokens, i);
          if (at >= 0) {
            text = `${text.slice(0, tokens[at].start)}__rbx2017.TweenService(${text.slice(tokens[at].start, tokens[i].start)})${text.slice(tokens[i + 4].end)}`;
            helpers.add('TweenService');
            changes.add('TweenService (2016)');
            done = false;
            break;
          }
        }
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
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && readHelpers[tokens[i + 1].value] !== undefined && !isSymbol(tokens[i + 2], '=') && !isSymbol(tokens[i + 2], '(')
        && (tokens[i + 1].value !== 'C0' || usesTransform)) {
        const start = prefixStart(tokens, i);
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          const name = tokens[i + 1].value;
          text = `${text.slice(0, tokens[start].start)}__rbx2017.${readHelpers[name]}(${object})${text.slice(tokens[i + 1].end)}`;
          helpers.add(readHelpers[name]);
          changes.add(name === 'RootPart' ? 'Humanoid.RootPart' : `.${name}`);
          done = false;
          break;
        }
      }
      // x:Create(obj, info, {ClockTime = ...}) -> __rbx2017.TweenCreate(x, obj, info, {...}).
      if (isSymbol(tokens[i], ':') && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'Create' && isSymbol(tokens[i + 2], '(')) {
        const close = matchForward(tokens, i + 2);
        const args = close >= 0 ? text.slice(tokens[i + 2].end, tokens[close].start) : '';
        const start = close >= 0 && argumentCount(tokens, i + 2, close) === 3 && /\bClockTime\s*=/.test(args) ? prefixStart(tokens, i) : -1;
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.TweenCreate(${object}, ${text.slice(tokens[i + 2].end)}`;
          helpers.add('TweenCreate');
          changes.add('TweenService:Create ClockTime');
          done = false;
          break;
        }
      }
      // color.R / .G / .B (read) -> __rbx2017.C3(color, "R"); not on Enum items (Enum.KeyCode.R).
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && /^[RGB]$/.test(tokens[i + 1].value) && !isSymbol(tokens[i + 2], '=') && !isSymbol(tokens[i + 2], '(')
        && !isSymbol(tokens[i + 2], '.') && !isSymbol(tokens[i + 2], ':') && !isSymbol(tokens[i + 2], '[')) {
        const start = prefixStart(tokens, i);
        const object = start >= 0 ? text.slice(tokens[start].start, tokens[i].start) : '';
        if (start >= 0 && object !== '__rbx2017' && !/^Enum\b/.test(object)) {
          text = `${text.slice(0, tokens[start].start)}__rbx2017.C3(${object}, "${tokens[i + 1].value}")${text.slice(tokens[i + 1].end)}`;
          helpers.add('C3');
          changes.add('Color3.R/G/B');
          done = false;
          break;
        }
      }
      // player.CharacterAppearanceLoaded:Connect(...) -> __rbx2017.AppearanceLoaded(player):Connect(...).
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'CharacterAppearanceLoaded' && isSymbol(tokens[i + 2], ':')) {
        const start = prefixStart(tokens, i);
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.AppearanceLoaded(${object})${text.slice(tokens[i + 1].end)}`;
          helpers.add('AppearanceLoaded');
          changes.add('.CharacterAppearanceLoaded');
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
      // Enum.InfoType.GamePass (2017 has Asset and Product) -> Enum.InfoType.Asset.
      if (tokens[i].type === 'name' && tokens[i].value === 'Enum' && !isSymbol(tokens[i - 1], '.') && isSymbol(tokens[i + 1], '.') && tokens[i + 2].value === 'InfoType'
        && isSymbol(tokens[i + 3], '.') && tokens[i + 4] && tokens[i + 4].value === 'GamePass') {
        text = `${text.slice(0, tokens[i + 4].start)}Asset${text.slice(tokens[i + 4].end)}`;
        changes.add('Enum.InfoType.GamePass');
        done = false;
        break;
      }
      // cf.LookVector / someCFrame.Position (read) -> __rbx2017.CFMember(cf, "LookVector").
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && !isSymbol(tokens[i + 2], '=') && !isSymbol(tokens[i + 2], '(')
        && (CFRAME_MEMBERS.has(tokens[i + 1].value) || (CFRAME_NAMED_MEMBERS.has(tokens[i + 1].value) && tokens[i - 1] && tokens[i - 1].type === 'name' && CFRAME_NAME.test(tokens[i - 1].value))
          // x:GetPivot().Position, resolveLinkCFrame().Position: calls that give a CFrame
          || (CFRAME_NAMED_MEMBERS.has(tokens[i + 1].value) && isSymbol(tokens[i - 1], ')') && cframeCall(tokens, i - 1))
          // (cf * CFrame.new(0, 1, 0)).Position
          || (CFRAME_NAMED_MEMBERS.has(tokens[i + 1].value) && isSymbol(tokens[i - 1], ')') && cframeGroup(tokens, i - 1, cframeNames))
          // pos.Position where pos is a plain variable the script uses as a CFrame
          || (CFRAME_NAMED_MEMBERS.has(tokens[i + 1].value) && tokens[i - 1] && tokens[i - 1].type === 'name' && cframeNames.has(tokens[i - 1].value)
            && !isSymbol(tokens[i - 2], '.') && !isSymbol(tokens[i - 2], ':')))) {
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
      const valueEnd = isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && isSymbol(tokens[i + 2], '=')
        && (settable(tokens[i + 1].value) || (newerProperties !== null && newerProperties.has(tokens[i + 1].value)))
        && (tokens[i + 1].value !== 'C0' || usesTransform)
        ? simpleExpressionEnd(tokens, i + 3) : -1;
      if (valueEnd > 0) {
        const next = tokens[valueEnd + 1];
        const ends = !next || next.type === 'eof' || (next.type === 'keyword' && next.value !== 'and' && next.value !== 'or') || next.type === 'name' || isSymbol(next, ';');
        const start = ends ? prefixStart(tokens, i) : -1;
        const object = start >= 0 ? text.slice(tokens[start].start, tokens[i].start) : '';
        if (start >= 0 && object !== GUARD_OBJECT) {
          const value = text.slice(tokens[i + 3].start, tokens[valueEnd].end);
          const name = tokens[i + 1].value;
          const setter = SETTERS[name] || (ALIASED.has(name) ? 'Set' : null) || (older && name === 'TextSize' ? 'SetTextSize' : null);
          if (setter) {
            text = `${text.slice(0, tokens[start].start)}__rbx2017.${setter}(${object}, "${name}", ${value})${text.slice(tokens[valueEnd].end)}`;
            helpers.add(setter);
          } else {
            // Inline, so the enclosing function gains no upvalue (Lua 5.1
            // allows 60; Phantom Forces' Framework has a function at the limit).
            text = `${text.slice(0, tokens[start].start)}do local ${GUARD_OBJECT}, __v2017 = ${object}, ${value} pcall(function() ${GUARD_OBJECT}.${name} = __v2017 end) end${text.slice(tokens[valueEnd].end)}`;
          }
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
      // player.PlayerGui.Child -> player.PlayerGui:WaitForChild("Child"): the 2017
      // client copies StarterGui into PlayerGui later than newer Roblox, so
      // scripts that read it at once failed (Bloxburg: "Modules is not a
      // valid member of PlayerGui", and every module that required them).
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'PlayerGui' && isSymbol(tokens[i + 2], '.')
        && tokens[i + 3] && tokens[i + 3].type === 'name' && !playerGuiMember(tokens[i + 3].value)
        && !isSymbol(tokens[i + 4], '=') && !isSymbol(tokens[i + 4], '(')) {
        text = `${text.slice(0, tokens[i + 2].start)}:WaitForChild("${tokens[i + 3].value}")${text.slice(tokens[i + 3].end)}`;
        changes.add('PlayerGui children waited for');
        done = false;
        break;
      }
      // player.PlayerGui -> player:WaitForChild("PlayerGui"): 2017 makes PlayerGui when the
      // character first spawns, after game:IsLoaded() (Flee the Facility's loading script).
      // Only on names that are clearly a player; it yields only where the old read errored.
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'PlayerGui'
        && tokens[i - 1] && tokens[i - 1].type === 'name' && /(?:player|plr)$|^lp$/i.test(tokens[i - 1].value)
        && !isSymbol(tokens[i + 2], '=') && !isSymbol(tokens[i + 2], '(')) {
        text = `${text.slice(0, tokens[i].start)}:WaitForChild("PlayerGui")${text.slice(tokens[i + 1].end)}`;
        changes.add('PlayerGui waited for');
        done = false;
        break;
      }
      // RunService.PreSimulation / PreAnimation (2023) -> Stepped without its first argument (the time).
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && (tokens[i + 1].value === 'PreSimulation' || tokens[i + 1].value === 'PreAnimation')
        && unknownTo2017(tokens[i + 1].value) && !isSymbol(tokens[i + 2], '=') && !isSymbol(tokens[i + 2], '(')) {
        const start = prefixStart(tokens, i);
        if (start >= 0 && text.slice(tokens[start].start, tokens[i].start) !== '__rbx2017') {
          const object = text.slice(tokens[start].start, tokens[i].start);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.SteppedDt(${object})${text.slice(tokens[i + 1].end)}`;
          helpers.add('SteppedDt');
          changes.add(`RunService.${tokens[i + 1].value}`);
          done = false;
          break;
        }
      }
      // object.AttributeChanged -> __rbx2017.AttributeChanged(object) (attributes are Value objects here).
      if (isSymbol(tokens[i], '.') && tokens[i + 1].type === 'name' && tokens[i + 1].value === 'AttributeChanged' && !isSymbol(tokens[i + 2], '=')
        && !isSymbol(tokens[i + 2], '(') && tokens[i - 1].value !== '__rbx2017') {
        const start = prefixStart(tokens, i);
        if (start >= 0) {
          const object = text.slice(tokens[start].start, tokens[i].start);
          text = `${text.slice(0, tokens[start].start)}__rbx2017.AttributeChanged(${object})${text.slice(tokens[i + 1].end)}`;
          helpers.add('AttributeChanged');
          changes.add('.AttributeChanged');
          done = false;
          break;
        }
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
      if (name.type !== 'name' || !methods[name.value] || paren.type !== 'symbol' || paren.value !== '(') continue;
      if (name.value === 'GetChildren' && !options.attributes) continue;
      const close = matchForward(tokens, i + 2);
      if (close < 0) continue;
      const count = argumentCount(tokens, i + 2, close);
      if (!methods[name.value].includes(count)) continue;
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
  // A script with its own Enum table (local Enum = {}) keeps its Enum.x.
  const ownEnum = declaresOwn(tokens, 'Enum', from);
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'name') continue;
    const before = tokens[i - 1];
    if (before && before.type === 'symbol' && (before.value === '.' || before.value === ':')) continue;
    const dot = tokens[i + 1];
    const member = tokens[i + 2];
    if (t.value === 'Enum' && (ownEnum || isSymbol(tokens[i + 3], '=') || isSymbol(tokens[i + 5], '='))) continue;
    if (t.value === 'Enum' && dot && dot.value === '.' && member && member.value === 'Font' && tokens[i + 3] && tokens[i + 3].value === '.') {
      const font = tokens[i + 4];
      if (font && font.type === 'name' && !fontsOf(API).has(font.value)) fontEdits.push([font.start, font.end, fontFor(font.value, fontsOf(API))]);
      continue;
    }
    // Enum.Newer.Item / Enum.Type.NewerItem (2017 errors on both): the nearest
    // item, else the item's name; Enum.Newer alone: a stand-in.
    const enums = t.value === 'Enum' && isSymbol(dot, '.') && member && member.type === 'name' && member.value !== 'Font' ? enumsOf2017() : null;
    if (enums) {
      const items = enums.get(member.value);
      const item = isSymbol(tokens[i + 3], '.') && tokens[i + 4] && tokens[i + 4].type === 'name' ? tokens[i + 4] : null;
      if (!items && item) {
        fontEdits.push([t.start, item.end, `("${item.value}")`]);
      } else if (!items) {
        fontEdits.push([t.start, member.end, `__rbx2017.EnumType("${member.value}")`]);
        helpers.add('EnumType');
      } else if (items && item && !items.has(item.value)) {
        const near = ENUM_NEAREST.has(member.value) ? ENUM_NEAREST.get(member.value)[item.value] : undefined;
        fontEdits.push([t.start, item.end, near ? `Enum.${member.value}.${near}` : `("${item.value}")`]);
      }
      continue;
    }
    if (t.value === 'Random' && dot && dot.value === '.' && member && member.value === 'new') { random = true; continue; }
    if (!library[t.value] || !dot || dot.type !== 'symbol' || dot.value !== '.' || !member || member.type !== 'name') continue;
    if (library[t.value][member.value] === undefined) continue;
    (needed[t.value] = needed[t.value] || new Set()).add(member.value);
  }
  for (const [start, end, font] of fontEdits.reverse()) {
    text = text.slice(0, start) + font + text.slice(end);
    changes.add(/^[(_]|^Enum\./.test(font) ? 'newer Enum items' : 'Enum.Font');
  }

  const prelude = [];
  const libraryTables = library;
  for (const [library, all] of Object.entries(needed)) {
    if (declaresOwn(tokens, library, from)) continue;
    const members = [...all].filter((member) => !hasStandIn(existing, library, member));
    if (members.length === 0) continue;
    const fields = members.map((member) => {
      changes.add(`${library}.${member}`);
      const value = libraryTables[library][member];
      if (value.startsWith('HELPER_')) {
        helpers.add(value.slice('HELPER_'.length));
        return `${member} = __rbx2017.${value.slice('HELPER_'.length)}`;
      }
      return `${member} = ${value}`;
    });
    prelude.push(`local ${library} = setmetatable({${fields.join(', ')}}, {__index = ${library}});`);
    // A script copying the library (for k, v in pairs(table): PartCache's
    // Table module) must see all of it, not only the stand-ins.
    if (new RegExp(String.raw`\bpairs\s*\(\s*${library}\s*\)`).test(text)) {
      prelude.push(`for k, v in pairs(getmetatable(${library}).__index or {}) do if rawget(${library}, k) == nil then rawset(${library}, k, v) end end;`);
    }
  }
  // typeof (2016 has only type).
  if (older && /\btypeof\s*\(/.test(text) && !declaresOwn(tokens, 'typeof', from) && !existing.includes('local typeof = ')) {
    helpers.add('typeof');
    prelude.push('local typeof = __rbx2017.typeof;');
    changes.add('typeof (2016)');
  }
  if (random && !declaresOwn(tokens, 'Random', from) && !existing.includes('local Random = {new = ')) {
    prelude.push(RANDOM);
    changes.add('Random');
  }
  if (marked) {
    for (const [name, [change, uses]] of Object.entries(REFRESHED)) {
      if (new RegExp(`[{,] ?${name} = function`).test(existing) && !existing.includes(`${name} = ${HELPERS[name]}`) && text.includes(uses)) {
        helpers.add(name);
        changes.add(change);
      }
    }
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

// Property names a place file has that 2017 lacks (convertSource's
// newerProperties), from the names in its XML. Names that games also use for
// their own table fields are left out (guarding those only costs time).
const COMMON_FIELD_NAMES = new Set(['Type', 'State', 'Mode', 'Content', 'Tags', 'Selector', 'Sink', 'Wind', 'Materials', 'Technology',
  'Decoration', 'Pants', 'Shirt', 'Wraps', 'shape', 'AssetId', 'Health_XML', 'Retargeting', 'AttributesSerialize']);
function newerPropertyNames(xmlText, into = new Set(), options = {}) {
  const api = apiFor(options);
  for (const m of xmlText.matchAll(/<(?:bool|int|int64|float|double|string|token|Vector3|Vector2|Color3|Color3uint8|CoordinateFrame|UDim|UDim2|NumberRange|NumberSequence|ColorSequence|Rect2D|Content|Ref|Font|Faces|Axes|PhysicalProperties)\s+name="(\w+)"/g)) {
    if (!into.has(m[1]) && !COMMON_FIELD_NAMES.has(m[1]) && unknownTo2017(m[1], api)) into.add(m[1]);
  }
  return into;
}

module.exports = { convertSource, newerPropertyNames, tokenize, prefixStart, MARK };
