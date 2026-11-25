'use strict';

// Checks a converted place in a throwaway game server (RCCService) of the
// engine it was converted for: whether every script compiles there, whether
// the place loads, and which errors its scripts raise in the first seconds of
// running. One player joins in the same process, as in Studio's Play Solo
// (Players:CreateLocalPlayer works in all three RCCs), so the game's
// LocalScripts and its PlayerAdded code run too; solo: false runs it with
// nobody. tools/converter-corpus.js runs it for each place of its corpus.
//
//   check({ engine, rccDir, place, scripts, seconds, soapPort, gamePort, solo }) ->
//     { compiled, scripts, scriptsFailed, compileErrors: [{ path, error, byConverter }],
//       loads, loadError, loadMs, player, runErrors: [{ message, path, count }],
//       engineErrors (Roblox's own scripts'), warnings: [{ message, count }],
//       hung, crashed, log: [lines] }
//   Paths are where the script is in the place (a player's PlayerGui script
//   is named by its StarterGui path).
//   place: Buffer of the converted place as the server stores it.
//   scripts: [{ path, className, source }] (scriptsOf in lib/placefile.js).
//
// The RCC must run from its real folder (one reached through a junction
// exits at once); the place is written into <rccDir>/content/convertcheck/
// for the time of the check. RCCs that run only JSON jobs (2018,
// lib/engines.js jsonJobs) run each step as a Thumbnail job script written to
// <rccDir>/internalscripts/thumbnails/, as lib/hosting.js does.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const engines = require('./engines');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const xmlEscape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');

function soap(port, action, inner, timeoutMs) {
  const body = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" '
    + `xmlns:ns1="http://localhost./"><SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`, 'latin1');
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/',
      headers: { SOAPAction: `"http://localhost./RCCServiceSoap/${action}"`, 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': body.length },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    });
    if (timeoutMs) request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

// One RCC process and its job.
class Rcc {
  constructor(engine, rccDir, soapPort) {
    this.engine = engines.get(engine);
    this.dir = rccDir;
    this.port = soapPort;
    this.jobId = `Check${soapPort}`;
    this.written = [];
  }

  async start() {
    // Another RCC on this port would answer for this one.
    const busy = await soap(this.port, 'HelloWorld', '<ns1:HelloWorld/>', 1000).then(() => true, () => false);
    if (busy) throw new Error(`port ${this.port} is in use`);
    this.process = spawn(path.join(this.dir, 'RCCService.exe'), [String(this.port), '-Console', '-Start'], {
      cwd: this.dir, detached: true, stdio: 'ignore', windowsHide: true,
    });
    this.exited = false;
    this.process.on('exit', () => { this.exited = true; });
    this.process.on('error', () => { this.exited = true; });
    for (let i = 0; i < 120 && !this.exited; i++) {
      try {
        await soap(this.port, 'HelloWorld', '<ns1:HelloWorld/>', 1000);
        break;
      } catch (error) {
        await sleep(500);
      }
    }
    if (this.exited) throw new Error('RCC exited at start');
    const open = await soap(this.port, 'OpenJob', `<ns1:OpenJob><ns1:job><ns1:id>${this.jobId}</ns1:id><ns1:expirationInSeconds>36000</ns1:expirationInSeconds>`
      + `<ns1:category>0</ns1:category><ns1:cores>2</ns1:cores></ns1:job><ns1:script><ns1:name>Open</ns1:name><ns1:script>${xmlEscape(this.script('return 1'))}</ns1:script>`
      + '<ns1:arguments /></ns1:script></ns1:OpenJob>', 60000);
    if (/<faultstring>/.test(open)) throw new Error(`RCC refused the job: ${xmlUnescape((/<faultstring>([\s\S]*?)<\/faultstring>/.exec(open) || [])[1] || '')}`);
  }

  // The job script for Lua `source`: itself, or a Thumbnail job running it from a file.
  script(source) {
    if (!this.engine.jsonJobs) return source;
    // Named per RCC too: checks running side by side remove their own files.
    const type = `RB2017CHECK_${this.port}_${crypto.createHash('sha1').update(source, 'latin1').digest('hex').slice(0, 16)}`;
    const file = path.join(this.dir, 'internalscripts', 'thumbnails', `${type}.lua`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source, 'latin1');
      this.written.push(file);
    }
    return JSON.stringify({ Mode: 'Thumbnail', Settings: { Type: type, Arguments: [] } });
  }

  // Runs Lua in the job; its first return value as a string ('FAULT ...' when RCC refused it).
  async run(source, timeoutMs = 120000) {
    const xml = await soap(this.port, 'Execute', `<ns1:Execute><ns1:jobID>${this.jobId}</ns1:jobID><ns1:script><ns1:name>Check</ns1:name>`
      + `<ns1:script>${xmlEscape(this.script(source))}</ns1:script><ns1:arguments /></ns1:script></ns1:Execute>`, timeoutMs);
    const value = /<ns1:value>([\s\S]*?)<\/ns1:value>/.exec(xml);
    if (value) return xmlUnescape(value[1]);
    const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(xml);
    return fault ? `FAULT ${xmlUnescape(fault[1])}` : '';
  }

  stop() {
    if (this.process && !this.exited) spawnSync('taskkill', ['/PID', String(this.process.pid), '/T', '/F'], { windowsHide: true });
    for (const file of this.written) {
      try { fs.unlinkSync(file); } catch (error) { /* gone */ }
    }
    this.written = [];
  }
}

// JSON text with every character past ASCII escaped, inside a Lua long string.
function luaJson(value) {
  const json = JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  let level = '==';
  while (json.includes(`]${level}]`)) level += '=';
  return `[${level}[${json}]${level}]`;
}

// Compiles the scripts in batches of about a megabyte each.
async function compileScripts(rcc, scripts) {
  const errors = [];
  let unsupported = null;
  for (let start = 0; start < scripts.length;) {
    const first = start;
    const batch = [];
    let size = 0;
    while (start < scripts.length && (batch.length === 0 || size < 1000000)) {
      batch.push(scripts[start].source);
      size += scripts[start].source.length;
      start++;
    }
    const lua = `local list = game:GetService("HttpService"):JSONDecode(${luaJson(batch)}) `
      + 'if type(loadstring) ~= "function" then return "NOLOADSTRING" end local bad = {} '
      + 'for i, s in ipairs(list) do local ok, f, e = pcall(loadstring, s) if not ok then return "NOLOADSTRING " .. tostring(f) end '
      + 'if not f then bad[#bad + 1] = i .. "\\t" .. tostring(e) end end return "OK\\n" .. table.concat(bad, "\\n")';
    const result = await rcc.run(lua, 300000);
    if (!result.startsWith('OK')) {
      unsupported = result.slice(0, 300) || 'no answer';
      break;
    }
    for (const line of result.split('\n').slice(1).filter(Boolean)) {
      const tab = line.indexOf('\t');
      const script = scripts[first + Number(line.slice(0, tab)) - 1];
      if (script) errors.push({ path: script.path, className: script.className, error: line.slice(tab + 1).slice(0, 400), script });
    }
  }
  // Scripts that fail with their source before conversion known: did that
  // compile? Then the converter broke it (byConverter).
  const withOriginal = errors.filter((e) => typeof e.script.original === 'string');
  if (!unsupported && withOriginal.length > 0) {
    const again = await compileScripts(rcc, withOriginal.map((e) => ({ path: e.path, className: e.className, source: e.script.original })));
    if (!again.unsupported) {
      const failing = new Set(again.errors.map((e) => e.path));
      for (const e of withOriginal) e.byConverter = !failing.has(e.path);
    }
  }
  for (const e of errors) delete e.script;
  return { errors, unsupported };
}

const SETUP = (file, gamePort, solo) => `_G.RB2017CHECK = {state = "loading", errors = {}, order = {}}
local S = _G.RB2017CHECK
pcall(function()
  game:GetService("ScriptContext").Error:connect(function(message, trace, script)
    local where = ""
    pcall(function() where = script and script:GetFullName() or "" end)
    local key = where .. "\\0" .. tostring(message)
    local e = S.errors[key]
    if e then e.count = e.count + 1 return end
    if #S.order >= 400 then return end
    e = {message = tostring(message):sub(1, 400), path = where, trace = tostring(trace or ""):sub(1, 400), count = 1}
    S.errors[key] = e
    S.order[#S.order + 1] = e
  end)
end)
spawn(function()
  local t = tick()
  pcall(function() game:GetService("ScriptContext"):SetTimeout(10) end)
  local ok, e = pcall(function() game:Load("rbxasset://convertcheck/${file}") end)
  S.loadMs = math.floor((tick() - t) * 1000)
  if not ok then S.loadError = tostring(e) S.state = "failed" return end
  if not ${solo ? 'true' : 'false'} then pcall(function() game:GetService("NetworkServer"):Start(${gamePort}) end) end
  local ran, why = pcall(function() game:GetService("RunService"):Run() end)
  if not ran then S.runError = tostring(why) end
  S.state = "running"
  if ${solo ? 'true' : 'false'} then
    -- One player joins (as in Studio's Play Solo), once the server scripts
    -- have started: their PlayerAdded code, the StarterGui, StarterPack and
    -- StarterPlayer scripts and the character's run too.
    wait(1)
    local made, p = pcall(function() return game:GetService("Players"):CreateLocalPlayer(0) end)
    if made and p then
      S.player = p.Name
      pcall(function() p:LoadCharacter() end)
    else
      S.soloError = tostring(p)
    end
  end
end)
return "started"`;

const STATE = 'local S = _G.RB2017CHECK if not S then return "none" end return S.state';

const COLLECT = `local S = _G.RB2017CHECK
local H = game:GetService("HttpService")
local warnings, seen = {}, {}
pcall(function()
  for _, e in ipairs(game:GetService("LogService"):GetLogHistory()) do
    if e.messageType == Enum.MessageType.MessageWarning then
      local m = tostring(e.message):sub(1, 300)
      if seen[m] then seen[m].count = seen[m].count + 1 elseif #warnings < 200 then seen[m] = {message = m, count = 1} warnings[#warnings + 1] = seen[m] end
    end
  end
end)
local errors = {}
for i, e in ipairs(S and S.order or {}) do errors[i] = {message = e.message, path = e.path, trace = e.trace, count = e.count} end
return H:JSONEncode({state = S and S.state, loadMs = S and S.loadMs, loadError = S and S.loadError, runError = S and S.runError, errors = errors, warnings = warnings,
  player = S and S.player, soloError = S and S.soloError})`;

// Where a script running for the player came from in the place
// (Players.Player1.PlayerGui.Main.X -> StarterGui.Main.X), so errors name
// the script in the file.
function placePath(where, player) {
  if (!player || !where) return where;
  const prefixes = [
    [`Players.${player}.PlayerGui.`, 'StarterGui.'],
    [`Players.${player}.PlayerScripts.`, 'StarterPlayer.StarterPlayerScripts.'],
    [`Players.${player}.Backpack.`, 'StarterPack.'],
    [`Players.${player}.StarterGear.`, 'StarterPack.'],
    [`Workspace.${player}.`, 'StarterPlayer.StarterCharacterScripts.'],
  ];
  for (const [from, to] of prefixes) if (where.startsWith(from)) return to + where.slice(from.length);
  return where;
}

// An error of a script the place does not have: Roblox's own (CoreGui, the
// default chat, camera, control and character scripts).
// (2016's CoreScripts fail on the RCC without naming a script.)
const ENGINE_MESSAGES = [/is not a valid member of GlobalSettings$/, /^Requested module experienced an error while loading$/];
function engineScript(where, known, message) {
  if (!where) return ENGINE_MESSAGES.some((pattern) => pattern.test(message));
  if (/^CoreGui\b/.test(where)) return true;
  for (let p = where; p; p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') if (known.has(p)) return false;
  return true;
}

async function check(options) {
  const { engine, rccDir, place, scripts = [], seconds = 20, soapPort, gamePort } = options;
  const result = {
    engine: engines.get(engine).id, compiled: null, scripts: scripts.length, scriptsFailed: null, compileErrors: [],
    loads: null, loadError: null, loadMs: null, runErrors: [], warnings: [], hung: false, crashed: false, log: [],
  };
  const token = `p${soapPort}-${crypto.randomBytes(4).toString('hex')}`;
  const ext = place.subarray(0, 8).toString('latin1') === '<roblox!' ? 'rbxl' : 'rbxlx';
  const dir = path.join(rccDir, 'content', 'convertcheck');
  const file = path.join(dir, `${token}.${ext}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, place);
  // Scripts compile in an RCC of their own, before any place is loaded: the
  // 2018 RCC turns loadstring off once a game runs.
  const step = async (name, work) => {
    const rcc = new Rcc(engine, rccDir, soapPort);
    try {
      await rcc.start();
      return await work(rcc);
    } catch (error) {
      result.log.push(`${name}: ${error.message}`);
      if (rcc.exited) result.crashed = true;
      else if (/timeout/.test(error.message)) result.hung = true;
      return null;
    } finally {
      rcc.stop();
    }
  };
  try {
    if (scripts.length > 0) {
      await step('compile', async (rcc) => {
        const compiled = await compileScripts(rcc, scripts);
        if (compiled.unsupported) {
          result.log.push(`compile: ${compiled.unsupported}`);
          return;
        }
        result.compiled = true;
        result.compileErrors = compiled.errors;
        result.scriptsFailed = compiled.errors.length;
      });
    } else {
      result.compiled = true;
      result.scriptsFailed = 0;
    }
    await step('run', async (rcc) => {
      const started = await rcc.run(SETUP(`${token}.${ext}`, gamePort, options.solo !== false), 60000);
      if (started !== 'started') throw new Error(`setup: ${started.slice(0, 300)}`);
      let state = 'loading';
      const loadLimit = Date.now() + (options.loadSeconds || 600) * 1000;
      while (state === 'loading' && Date.now() < loadLimit) {
        await sleep(1000);
        if (rcc.exited) throw new Error('RCC exited while loading');
        state = await rcc.run(STATE, 30000);
      }
      if (state === 'loading') {
        result.hung = true;
        result.loads = false;
        result.loadError = `still loading after ${options.loadSeconds || 600} s`;
        return;
      }
      if (state === 'running') await sleep(seconds * 1000);
      if (rcc.exited) throw new Error('RCC exited while running');
      const collected = JSON.parse(await rcc.run(COLLECT, 60000));
      result.loads = collected.state === 'running';
      result.loadError = collected.loadError || null;
      result.loadMs = collected.loadMs == null ? null : collected.loadMs;
      if (collected.runError) result.log.push(`Run: ${collected.runError}`);
      if (collected.soloError) result.log.push(`player: ${collected.soloError}`);
      result.player = Boolean(collected.player);
      // The game's own scripts' errors; Roblox's own scripts' apart.
      const known = new Set(scripts.map((s) => s.path));
      const all = (collected.errors || []).map((e) => {
        const where = placePath(e.path || '', collected.player);
        return { message: e.message.split(e.path || '\u0000').join(where), path: where, trace: e.trace || '', count: e.count, engine: engineScript(where, known, e.message) };
      });
      result.runErrors = all.filter((e) => !e.engine).map(({ engine: x, ...e }) => e);
      result.engineErrors = all.filter((e) => e.engine).map(({ engine: x, ...e }) => e);
      result.warnings = collected.warnings || [];
    });
  } finally {
    try { fs.unlinkSync(file); } catch (error) { /* gone */ }
  }
  return result;
}

module.exports = { check, soap, Rcc };
