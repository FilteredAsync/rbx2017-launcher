'use strict';

// The Roblox API of each engine (lib/engines.js): its classes, their members
// and its enums, from that engine's API dump (the text its client writes with
// RobloxPlayerBeta.exe --API <file>). The converter (lib/placefile.js,
// lib/luacompat.js) changes what a game uses that its engine lacks.
//
// Where the dump of engine <year> is read from, first found:
//   <folder named by RBX_API_DUMPS>/api<year>.txt   (tests: tools/converter-corpus.js)
//   <the engine's server folder>/apidump.txt        (Server2016/, Server2018/)
//   <the engine's client folder>/apidump.txt        (Client/apidump.txt for 2017)
// Without its own dump an engine is converted for with 2017's (api.fallback).
//
//   get(engine) -> api or null (no dump at all)
//   api.engine, api.file, api.fallback
//   api.hasClass(name), api.isA(className, base), api.parentOf(name)
//   api.member(className, name) -> { kind, type, tags } or null (inherited too)
//   api.hasMember(name)  some class has a member of that name
//   api.enum(name) -> Map(item -> value) or null
//   api.classes: Map(name -> { parent, tags: Set, members: Map(name -> member) })

const fs = require('fs');
const path = require('path');
const core = require('./core');
const engines = require('./engines');

const DEFAULT = '2017';
const cache = new Map();

function dumpFile(engine) {
  const id = engines.known(engine) || DEFAULT;
  const info = engines.ENGINES[id];
  const candidates = [];
  if (process.env.RBX_API_DUMPS) candidates.push(path.join(process.env.RBX_API_DUMPS, `api${id}.txt`));
  candidates.push(core.rootPath(info.server, 'apidump.txt'), core.rootPath(info.client, 'apidump.txt'));
  return candidates.find((file) => core.isFile(file)) || null;
}

function parse(text) {
  const classes = new Map();
  const enums = new Map();
  const memberNames = new Set();
  let current = null;
  let currentEnum = null;
  for (const line of text.split(/\r?\n/)) {
    let m = /^Class (\w+)(?: : (\w+))?(.*)$/.exec(line);
    if (m) {
      current = { name: m[1], parent: m[2] || null, tags: new Set((m[3].match(/\[[^\]]+\]/g) || []).map((t) => t.slice(1, -1))), members: new Map() };
      classes.set(m[1], current);
      currentEnum = null;
      continue;
    }
    m = /^Enum (\w+)/.exec(line);
    if (m) {
      currentEnum = new Map();
      enums.set(m[1], currentEnum);
      current = null;
      continue;
    }
    m = /^\tEnumItem \w+\.(\w+) : (-?\d+)/.exec(line);
    if (m && currentEnum) {
      currentEnum.set(m[1], Number(m[2]));
      continue;
    }
    m = /^\t(Property|Function|YieldFunction|Event|Callback) (.*?)\b(\w+)[.:](\w+)(.*)$/.exec(line);
    if (m && current) {
      const tags = new Set((m[5].match(/\[[^\]]+\]/g) || []).map((t) => t.slice(1, -1)));
      current.members.set(m[4], { kind: m[1], type: m[2].trim(), tags });
      memberNames.add(m[4]);
    }
  }
  return { classes, enums, memberNames };
}

function make(engine, file, fallback) {
  const { classes, enums, memberNames } = parse(fs.readFileSync(file, 'latin1'));
  const api = {
    engine, file, fallback, classes, enums,
    hasClass: (name) => classes.has(name),
    parentOf: (name) => (classes.get(name) || {}).parent || null,
    isA(className, base) {
      for (let c = className, guard = 0; c && guard < 64; guard++) {
        if (c === base) return true;
        c = api.parentOf(c);
      }
      return false;
    },
    member(className, name) {
      for (let c = className, guard = 0; c && guard < 64; guard++) {
        const cls = classes.get(c);
        if (!cls) return null;
        if (cls.members.has(name)) return cls.members.get(name);
        c = cls.parent;
      }
      return null;
    },
    hasMember: (name) => memberNames.has(name),
    enum: (name) => enums.get(name) || null,
  };
  return api;
}

function get(engine) {
  const id = engines.known(engine) || DEFAULT;
  if (cache.has(id)) return cache.get(id);
  let api = null;
  const own = dumpFile(id);
  try {
    if (own) api = make(id, own, false);
    else if (id !== DEFAULT && dumpFile(DEFAULT)) api = make(id, dumpFile(DEFAULT), true);
  } catch (error) {
    api = null;
  }
  cache.set(id, api);
  return api;
}

module.exports = { get, dumpFile, DEFAULT };
