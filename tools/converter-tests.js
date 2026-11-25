#!/usr/bin/env node
'use strict';

// Quick checks of the place converter (no game server needed; the corpus
// runner, tools/converter-corpus.js, checks real places in one).
//
//   node tools/converter-tests.js [--api-dumps <dir with api2016.txt, api2017.txt, api2018.txt>]
//
// Checks that need an engine's API dump are skipped without it (the dumps
// are Roblox's own lists and stay out of the repo).

const assert = require('assert');
const path = require('path');

const args = process.argv.slice(2);
const dumpsAt = args.indexOf('--api-dumps');
if (dumpsAt >= 0) process.env.RBX_API_DUMPS = path.resolve(args[dumpsAt + 1]);

const lib = path.join(__dirname, '..', 'Webserver', 'node', 'lib');
const apidump = require(path.join(lib, 'apidump'));
const luacompat = require(path.join(lib, 'luacompat'));
const luaulower = require(path.join(lib, 'luaulower'));
const placefile = require(path.join(lib, 'placefile'));
const attributes = require(path.join(lib, 'attributes'));
const rbxbinary = require(path.join(lib, 'rbxbinary'));
const convertreport = require(path.join(lib, 'convertreport'));

const has = { 2016: Boolean(apidump.get('2016') && !apidump.get('2016').fallback), 2017: Boolean(apidump.get('2017')), 2018: Boolean(apidump.get('2018') && !apidump.get('2018').fallback) };
let passed = 0;
let skipped = 0;
const failures = [];
function test(name, needs, fn) {
  if (needs.some((year) => !has[year])) { skipped++; return; }
  try {
    fn();
    passed++;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}
const convert = (source, engine = '2017') => luacompat.convertSource(source, { engine }).text;
const lines = (text) => text.split('\n').length;

test('a script\'s own Enum table keeps its fields', ['2017'], () => {
  const out = convert('local Enum = {}\nEnum.enums = {}\nreturn Enum.enums');
  assert.ok(!out.includes('EnumType'), out);
});

test('newer Enum items still become the nearest item', ['2017'], () => {
  assert.ok(convert('local m = Enum.Material.Glass').includes('Enum.Material.SmoothPlastic'));
});

test('local Random = Random.new() gets the Random stand-in', ['2017'], () => {
  assert.ok(convert('local Random = Random.new()\nreturn Random').includes('local Random = {new = '));
});

test('local math = math still gets math.clamp', ['2017'], () => {
  assert.ok(convert('local math = math\nreturn math.clamp(5, 1, 3)').includes('clamp = function'));
});

test('\\z line continuations are lowered and keep the line count', [], () => {
  const source = 'warn("\\z\n\t\tabc \\z\n\t\tdef")\nlocal x = 1\n';
  const out = luaulower.lower(source).text;
  assert.ok(out.startsWith('warn("abc def"'), JSON.stringify(out));
  assert.strictEqual(lines(out), lines(source));
});

test('CFrame.fromMatrix and Animator:GetPlayingAnimationTracks get stand-ins', ['2017'], () => {
  const out = convert('local c = CFrame.fromMatrix(p, x, y)\nlocal t = animator:GetPlayingAnimationTracks()');
  assert.ok(out.includes('fromMatrix = function'), out);
  assert.ok(out.includes('__rbx2017.GetPlayingAnimationTracks(animator)'), out);
});

test('2016: signals, typeof, Color3.fromRGB, TweenService, TextSize', ['2016'], () => {
  const out = convert('local c = x.Changed:Connect(f) c:Disconnect() print(typeof(x)) local k = Color3.fromRGB(1, 2, 3) '
    + 'local t = game:GetService("TweenService") label.TextSize = 20 local f = model:FindFirstChildOfClass("Part")', '2016');
  for (const part of ['__rbx2017.Connect(x.Changed, f)', '__rbx2017.Disconnect(c)', 'local typeof = typeof or function', 'fromRGB = function',
    '__rbx2017.TweenService(game)', '__rbx2017.SetTextSize(label, "TextSize", 20)', '__rbx2017.FindFirstChildOfClass(model, "Part")']) {
    assert.ok(out.includes(part), `missing ${part}`);
  }
});

test('2017 and 2018 keep Connect, typeof, fromRGB and TweenService', ['2017', '2018'], () => {
  const source = 'local c = x.Changed:Connect(f) print(typeof(x)) local k = Color3.fromRGB(1, 2, 3) local t = game:GetService("TweenService")';
  for (const engine of ['2017', '2018']) assert.strictEqual(convert(source, engine), source);
});

test('2016 place file: TextSize -> FontSize, AnchorPoint folded into Position, fonts past 6 mapped', ['2016'], () => {
  const xml = Buffer.from('<roblox version="4"><Item class="TextLabel" referent="A"><Properties><string name="Name">L</string>'
    + '<Vector2 name="AnchorPoint"><X>0.5</X><Y>1</Y></Vector2><UDim2 name="Position"><XS>0.5</XS><XO>0</XO><YS>1</YS><YO>0</YO></UDim2>'
    + '<UDim2 name="Size"><XS>0.2</XS><XO>100</XO><YS>0</YS><YO>50</YO></UDim2><float name="TextSize">24</float><token name="Font">10</token>'
    + '</Properties></Item></roblox>', 'latin1');
  const out = placefile.convertPlace(xml, { engine: '2016' }).output.toString('latin1');
  assert.ok(out.includes('<token name="FontSize">7</token>'), out);
  assert.ok(out.includes('<XS>0.4</XS><XO>-50</XO><YS>1</YS><YO>-50</YO>'), out);
  assert.ok(!out.includes('AnchorPoint') && !out.includes('TextSize'), out);
  assert.ok(out.includes('<token name="Font">3</token>'), out);
  const same = placefile.convertPlace(xml, { engine: '2017' }).output.toString('latin1');
  assert.ok(same.includes('AnchorPoint') && same.includes('TextSize'), same);
});

test('attributes holding binary data stay valid XML', [], () => {
  const name = Buffer.from('Bench', 'latin1');
  const value = Buffer.from([0x00, 0x07, 0x3c, 0x26, 0xff, 0xfe, 0x41]);
  const parts = [Buffer.alloc(4), Buffer.alloc(4), name, Buffer.from([0x02]), Buffer.alloc(4), value];
  parts[0].writeUInt32LE(1);
  parts[1].writeUInt32LE(name.length);
  parts[4].writeUInt32LE(value.length);
  const list = attributes.decode(Buffer.concat(parts).toString('base64'));
  assert.strictEqual(list[0].value, value.toString('latin1'));
  const xml = Buffer.from(`<roblox version="4">${attributes.items(list)}</roblox>`, 'latin1');
  const stored = rbxbinary.placeToStore(xml);
  assert.strictEqual(stored.bytes.subarray(0, 8).toString('latin1'), '<roblox!', stored.notes.join(' '));
});

test('terrain shoreline cells become cells the old engines read', [], () => {
  // chunks of 2x2x2: 3 grass, 1 shoreline (ground 9 + water 255), 4 air
  const grid = Buffer.from([1, 1, ...new Array(12).fill(0), 0x80 | 2, 2, 0x80 | 0x40 | 14, 9, 0, 255, 0x80, 3]);
  const xml = Buffer.from(`<roblox version="4"><Item class="Terrain" referent="T"><Properties><string name="Name">Terrain</string>`
    + `<BinaryString name="SmoothGrid">${grid.toString('base64')}</BinaryString></Properties></Item></roblox>`, 'latin1');
  const out = placefile.convertPlace(xml, { engine: '2017' }).output.toString('latin1');
  const data = Buffer.from(/<BinaryString name="SmoothGrid">([^<]*)</.exec(out)[1], 'base64');
  assert.deepStrictEqual([...data], [1, 1, ...new Array(12).fill(0), 0x80 | 2, 2, 1, 0x80, 3]);
});

test('require by string loads the instance', ['2017'], () => {
  const out = convert('local a = require("@self/system") local b = require("./util") local c = require("@rbx/Pkg")');
  assert.ok(out.includes('require(script:WaitForChild("system"))'), out);
  assert.ok(out.includes('require(script.Parent:WaitForChild("util"))'), out);
  assert.ok(out.includes('__rbx2017.Stub()'), out);
});

test('RunService.PreRender and Enum.X:FromName', ['2017'], () => {
  const out = convert('rs.PreRender:Connect(f) rs.PreSimulation:Connect(f) local k = Enum.KeyCode:FromName("E")');
  for (const part of ['rs.RenderStepped:Connect(f)', '__rbx2017.SteppedDt(rs):Connect(f)', '__rbx2017.FromName(Enum.KeyCode, "E")']) assert.ok(out.includes(part), `missing ${part}`);
});

test('type declarations keep their lines', ['2017'], () => {
  const source = 'export type T =\n\t| A\n\t| B\nlocal x: {\n\ta: number,\n} = {}\nreturn x\n';
  const out = convert(source);
  assert.ok(!/\btype\b|number/.test(out.replace(/^--\[\[2017\]\]/, '')), out);
  assert.strictEqual(lines(out), lines(source));
});

test('scriptsOf gives full names', [], () => {
  const xml = Buffer.from('<roblox><Item class="Workspace" referent="A"><Properties><string name="Name">Workspace</string></Properties>'
    + '<Item class="Model" referent="B"><Properties><string name="Name">M</string></Properties><Item class="Script" referent="C"><Properties>'
    + '<string name="Name">S</string><ProtectedString name="Source"><![CDATA[print(1)]]></ProtectedString></Properties></Item></Item></Item></roblox>', 'latin1');
  assert.deepStrictEqual(placefile.scriptsOf(xml).map((s) => [s.path, s.source]), [['Workspace.M.S', 'print(1)']]);
});

test('reports list check results and conversion notes', [], () => {
  const report = convertreport.build({
    placeId: 2001, engine: '2016', counts: { engine: '2016', unknownClasses: new Map([['Beam', 2]]), luauScripts: ['Workspace.S: continue'] },
    check: { loads: true, scripts: 3, scriptsFailed: 1, compileErrors: [{ path: 'Workspace.S', error: 'x' }], runErrors: [{ message: 'boom', path: 'Workspace.T', count: 2 }] },
  });
  assert.deepStrictEqual(report.checks, { loads: true, scripts: 3, scriptsFailed: 1, runErrors: 1 });
  assert.deepStrictEqual(report.issues.map((i) => i.kind), ['compile', 'runtime', 'luau', 'class']);
  assert.strictEqual(report.engine, '2016');
});

console.log(`${passed} passed, ${failures.length} failed, ${skipped} skipped${skipped ? ' (no API dumps: --api-dumps <dir>)' : ''}`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
