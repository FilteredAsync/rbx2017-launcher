'use strict';

// Instance attributes (2020) for the 2017 engine, which has none. A place's
// attributes (AttributesSerialize) become Value objects in a Configuration
// named __2017Attributes under their instance; lib/luacompat.js gives scripts
// GetAttribute/SetAttribute/GetAttributes/GetAttributeChangedSignal and
// AttributeChanged on those (SetAttribute makes them at run time, and they
// replicate like any instance). Types with no Value class (UDim2, Vector2,
// NumberSequence...) are StringValues holding "@@2017@@Type@@numbers,...".
//
//   decode(base64) -> [{ name, type, value }]   (type: a Roblox type name)
//   items(list, referentPrefix) -> XML of the Configuration and its values

const { ROTATIONS } = require('./rbxbinary');

const FOLDER = '__2017Attributes';
const MARK = '@@2017@@';

function decode(base64) {
  const d = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  let p = 0;
  const need = (n) => { if (p + n > d.length) throw new Error('attributes end early'); };
  const u8 = () => { need(1); return d[p++]; };
  const u16 = () => { need(2); const v = d.readUInt16LE(p); p += 2; return v; };
  const u32 = () => { need(4); const v = d.readUInt32LE(p); p += 4; return v; };
  const i32 = () => { need(4); const v = d.readInt32LE(p); p += 4; return v; };
  const f32 = () => { need(4); const v = d.readFloatLE(p); p += 4; return v; };
  const f64 = () => { need(8); const v = d.readDoubleLE(p); p += 8; return v; };
  const str = () => { const n = u32(); need(n); const v = d.toString('utf8', p, p + n); p += n; return v; };
  const list = [];
  if (d.length < 4) return list;
  const count = u32();
  for (let k = 0; k < count; k++) {
    const name = str();
    const type = u8();
    let entry;
    switch (type) {
      case 0x02: entry = { type: 'string', value: str() }; break;
      case 0x03: entry = { type: 'bool', value: u8() !== 0 }; break;
      case 0x05: entry = { type: 'number', value: f32() }; break;
      case 0x06: entry = { type: 'number', value: f64() }; break;
      case 0x09: entry = { type: 'UDim', value: [f32(), i32()] }; break;
      case 0x0A: entry = { type: 'UDim2', value: [f32(), i32(), f32(), i32()] }; break;
      case 0x0E: entry = { type: 'BrickColor', value: u32() }; break;
      case 0x0F: entry = { type: 'Color3', value: [f32(), f32(), f32()] }; break;
      case 0x10: entry = { type: 'Vector2', value: [f32(), f32()] }; break;
      case 0x11: entry = { type: 'Vector3', value: [f32(), f32(), f32()] }; break;
      case 0x14: {
        const position = [f32(), f32(), f32()];
        const id = u8();
        let rotation;
        if (id === 0) { rotation = []; for (let i = 0; i < 9; i++) rotation.push(f32()); } else rotation = ROTATIONS.get(id) || [1, 0, 0, 0, 1, 0, 0, 0, 1];
        entry = { type: 'CFrame', value: position.concat(rotation) };
        break;
      }
      case 0x15: { const enumType = str(); entry = { type: 'EnumItem', value: [enumType, u32()] }; break; }
      case 0x17: { const n = u32(); const kp = []; for (let i = 0; i < n; i++) { const envelope = f32(); kp.push(f32(), f32(), envelope); } entry = { type: 'NumberSequence', value: kp }; break; }
      case 0x19: { const n = u32(); const kp = []; for (let i = 0; i < n; i++) { f32(); kp.push(f32(), f32(), f32(), f32()); } entry = { type: 'ColorSequence', value: kp }; break; }
      case 0x1B: entry = { type: 'NumberRange', value: [f32(), f32()] }; break;
      case 0x1C: entry = { type: 'Rect', value: [f32(), f32(), f32(), f32()] }; break;
      case 0x21: { const weight = u16(); const style = u8(); const family = str(); str(); entry = { type: 'Font', value: [family, weight, style] }; break; }
      default:
        // An unknown type: its size is unknown too, so the rest is lost.
        return list;
    }
    list.push({ name, ...entry });
  }
  return list;
}

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v) => (Number.isFinite(v) ? String(v) : v > 0 ? 'INF' : v < 0 ? '-INF' : 'NAN');

// Lua reads these back (luacompat AttrDecode): numbers joined by commas.
function encoded(entry) {
  const v = entry.value;
  switch (entry.type) {
    case 'EnumItem': return `${MARK}EnumValue${MARK}${v[0]},${v[1]}`;
    case 'Font': return `${MARK}Font${MARK}${v[0]},${v[1]},${v[2]}`;
    default: return `${MARK}${entry.type}${MARK}${v.map((x) => String(x)).join(',')}`;
  }
}

function valueItem(entry, referent) {
  const name = `<string name="Name">${esc(entry.name)}</string>`;
  const v = entry.value;
  let cls;
  let prop;
  switch (entry.type) {
    case 'string': cls = 'StringValue'; prop = `<string name="Value">${esc(v)}</string>`; break;
    case 'bool': cls = 'BoolValue'; prop = `<bool name="Value">${v}</bool>`; break;
    case 'number': cls = 'NumberValue'; prop = `<double name="Value">${num(v)}</double>`; break;
    case 'BrickColor': cls = 'BrickColorValue'; prop = `<int name="Value">${v}</int>`; break;
    case 'Color3': cls = 'Color3Value'; prop = `<Color3 name="Value"><R>${num(v[0])}</R><G>${num(v[1])}</G><B>${num(v[2])}</B></Color3>`; break;
    case 'Vector3': cls = 'Vector3Value'; prop = `<Vector3 name="Value"><X>${num(v[0])}</X><Y>${num(v[1])}</Y><Z>${num(v[2])}</Z></Vector3>`; break;
    case 'CFrame': {
      cls = 'CFrameValue';
      const tags = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'];
      prop = `<CoordinateFrame name="Value">${tags.map((t, i) => `<${t}>${num(v[i])}</${t}>`).join('')}</CoordinateFrame>`;
      break;
    }
    default: cls = 'StringValue'; prop = `<string name="Value">${esc(encoded(entry))}</string>`;
  }
  return `<Item class="${cls}" referent="${referent}"><Properties>${name}${prop}</Properties></Item>`;
}

let serial = 0;
function items(list) {
  if (list.length === 0) return '';
  const base = `RBX2017ATTR${(++serial).toString(36).toUpperCase()}`;
  const values = list.map((entry, i) => valueItem(entry, `${base}V${i}`)).join('');
  return `<Item class="Configuration" referent="${base}"><Properties><string name="Name">${FOLDER}</string></Properties>${values}</Item>`;
}

module.exports = { decode, items, FOLDER, MARK };
