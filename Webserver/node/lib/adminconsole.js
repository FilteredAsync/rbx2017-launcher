'use strict';

// A server console for admins, added to every game server (lib/hosting.js).
//
// The 2017 developer console (F9) shows its server log and stats only to the
// game's creator, which on this server is the game's original Roblox creator
// (so scripts that check it behave), so nobody here could see them. This
// gives the server's admins, and the game's owner and editors, a window with
// the server's output and a few stats instead: F10, or "/serverconsole" (or
// "/sc") in chat. The server sends its output only to them, and only after
// they open the window.

const accounts = require('./accounts');
const places = require('./places');

// User IDs that may use it: the server's admins, the game's owner and editors.
function allowedUserIds(placeId) {
  const ids = new Set();
  try {
    for (const account of accounts.list()) if (account.admin) ids.add(Number(account.userId));
  } catch (error) { /* no accounts on this PC */ }
  try {
    const place = places.exists() ? places.get(placeId) : null;
    if (place && place.owner) ids.add(Number(place.owner.userId));
    for (const editor of (place && place.editors) || []) ids.add(Number(editor.userId));
  } catch (error) { /* no library on this PC */ }
  return [...ids].filter((id) => Number.isSafeInteger(id) && id > 0);
}

// The window (a LocalScript each allowed player gets).
const CLIENT = String.raw`
local Players = game:GetService("Players")
local UserInputService = game:GetService("UserInputService")
local player = Players.LocalPlayer
local remote = game:GetService("ReplicatedStorage"):WaitForChild("AdminServerConsole")
local playerGui = player:WaitForChild("PlayerGui")
local old = playerGui:FindFirstChild("AdminServerConsoleGui")
if old then old:Destroy() end

local gui = Instance.new("ScreenGui")
gui.Name = "AdminServerConsoleGui"
pcall(function() gui.ResetOnSpawn = false end)
local frame = Instance.new("Frame")
frame.Size = UDim2.new(0.62, 0, 0.6, 0)
frame.Position = UDim2.new(0.19, 0, 0.12, 0)
frame.BackgroundColor3 = Color3.new(0.09, 0.09, 0.11)
frame.BackgroundTransparency = 0.08
frame.BorderSizePixel = 0
frame.Active = true
frame.Draggable = true
frame.Visible = false
frame.Parent = gui
local function label(parent, text, size, position, color)
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.Font = Enum.Font.SourceSans
	l.FontSize = Enum.FontSize.Size14
	l.TextColor3 = color or Color3.new(1, 1, 1)
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextYAlignment = Enum.TextYAlignment.Top
	l.Text = text
	l.Size = size
	l.Position = position
	l.Parent = parent
	return l
end
local title = label(frame, "Server console (F10 or /sc to close)", UDim2.new(0.5, 0, 0, 22), UDim2.new(0, 10, 0, 6))
title.Font = Enum.Font.SourceSansBold
title.FontSize = Enum.FontSize.Size18
local statsLabel = label(frame, "", UDim2.new(0.5, -40, 0, 22), UDim2.new(0.5, 0, 0, 8), Color3.new(0.75, 0.8, 0.9))
statsLabel.TextXAlignment = Enum.TextXAlignment.Right
local close = Instance.new("TextButton")
close.Size = UDim2.new(0, 26, 0, 22)
close.Position = UDim2.new(1, -32, 0, 6)
close.BackgroundColor3 = Color3.new(0.35, 0.12, 0.12)
close.BorderSizePixel = 0
close.TextColor3 = Color3.new(1, 1, 1)
close.Text = "X"
close.Parent = frame
local list = Instance.new("ScrollingFrame")
list.Position = UDim2.new(0, 8, 0, 34)
list.Size = UDim2.new(1, -16, 1, -42)
list.BackgroundColor3 = Color3.new(0, 0, 0)
list.BackgroundTransparency = 0.5
list.BorderSizePixel = 0
list.ScrollBarThickness = 10
list.CanvasSize = UDim2.new(0, 0, 0, 0)
list.Parent = frame
gui.Parent = playerGui

-- Enum.MessageType values: Output, Info, Warning, Error.
local COLORS = {[0] = Color3.new(0.92, 0.92, 0.92), [1] = Color3.new(0.45, 0.7, 1), [2] = Color3.new(1, 0.7, 0.3), [3] = Color3.new(1, 0.4, 0.4)}
local MAX_LINES = 400
local lines = {}
local height = 0
local function lineHeight(text)
	local width = math.max(100, list.AbsoluteSize.X - 24)
	local ok, size = pcall(function()
		return game:GetService("TextService"):GetTextSize(text, 14, Enum.Font.SourceSans, Vector2.new(width, 10000))
	end)
	if ok and size then return math.max(16, size.Y + 2) end
	return 16 * math.max(1, math.ceil(#text * 7 / width))
end
local function addLabel(line)
	local t = tonumber(line[1]) or 0
	local text = string.format("%d:%02d:%02d  %s", math.floor(t / 3600), math.floor(t / 60) % 60, t % 60, tostring(line[3]))
	local h = lineHeight(text)
	local l = label(list, text, UDim2.new(1, -16, 0, h), UDim2.new(0, 4, 0, height), COLORS[line[2]])
	l.TextWrapped = true
	height = height + h
end
local function rebuild()
	list:ClearAllChildren()
	height = 0
	for _, line in ipairs(lines) do addLabel(line) end
	list.CanvasSize = UDim2.new(0, 0, 0, height)
	list.CanvasPosition = Vector2.new(0, math.max(0, height - list.AbsoluteSize.Y))
end
local function add(line)
	table.insert(lines, line)
	if #lines > MAX_LINES then
		for _ = 1, 100 do table.remove(lines, 1) end
		rebuild()
		return
	end
	local atBottom = list.CanvasPosition.Y >= height - list.AbsoluteSize.Y - 30
	addLabel(line)
	list.CanvasSize = UDim2.new(0, 0, 0, height)
	if atBottom then list.CanvasPosition = Vector2.new(0, math.max(0, height - list.AbsoluteSize.Y)) end
end
local function showStats(s)
	local parts = {}
	if s.players then table.insert(parts, s.players .. " players") end
	if s.fps then table.insert(parts, "physics " .. s.fps .. " fps") end
	if s.memory then table.insert(parts, s.memory .. " MB") end
	if s.uptime then table.insert(parts, string.format("up %d:%02d", math.floor(s.uptime / 3600), math.floor(s.uptime / 60) % 60)) end
	statsLabel.Text = table.concat(parts, "  |  ")
end

local open = false
local function setOpen(value)
	open = value
	frame.Visible = value
	remote:FireServer(value and "open" or "close")
end
remote.OnClientEvent:connect(function(kind, a, b)
	if kind == "history" then
		lines = a or {}
		while #lines > MAX_LINES do table.remove(lines, 1) end
		rebuild()
		if b then showStats(b) end
	elseif kind == "line" then
		if open then add(a) end
	elseif kind == "stats" then
		showStats(a)
	elseif kind == "toggle" then
		setOpen(not open)
	end
end)
close.MouseButton1Click:connect(function() setOpen(false) end)
UserInputService.InputBegan:connect(function(input)
	if input.KeyCode == Enum.KeyCode.F10 then setOpen(not open) end
end)
spawn(function()
	while gui.Parent do
		wait(2)
		if open then remote:FireServer("stats") end
	end
end)
`;

// The game server's part (run after the place has loaded).
function script(placeId) {
  const ids = allowedUserIds(placeId);
  if (ids.length === 0) return '';
  if (CLIENT.includes(']==]')) throw new Error('admin console source would end the Lua string early');
  return `pcall(function()
local ALLOWED = {${ids.map((id) => `[${id}] = true`).join(', ')}}
local Players = game:GetService("Players")
local remote = Instance.new("RemoteEvent")
remote.Name = "AdminServerConsole"
remote.Parent = game:GetService("ReplicatedStorage")
local started = tick()
local lines, watching = {}, {}
local function stats()
	local s = {players = #Players:GetPlayers(), uptime = math.floor(tick() - started)}
	pcall(function() s.fps = math.floor(workspace:GetRealPhysicsFPS() + 0.5) end)
	pcall(function() s.memory = math.floor(game:GetService("Stats"):GetTotalMemoryUsageMb() + 0.5) end)
	return s
end
game:GetService("LogService").MessageOut:connect(function(message, kind)
	local line = {math.floor(tick() - started), kind.Value, message} -- seconds since the server started
	table.insert(lines, line)
	if #lines > 400 then table.remove(lines, 1) end
	for watcher in pairs(watching) do
		if watcher.Parent then remote:FireClient(watcher, "line", line) else watching[watcher] = nil end
	end
end)
remote.OnServerEvent:connect(function(player, action)
	if not ALLOWED[player.UserId] then return end
	if action == "open" then
		watching[player] = true
		remote:FireClient(player, "history", lines, stats())
	elseif action == "close" then
		watching[player] = nil
	elseif action == "stats" then
		remote:FireClient(player, "stats", stats())
	end
end)
local SOURCE = [==[${CLIENT}]==]
local function give(player)
	local playerGui = player:WaitForChild("PlayerGui")
	if playerGui:FindFirstChild("AdminServerConsole") then return end
	local s = Instance.new("LocalScript")
	s.Name = "AdminServerConsole"
	s.Source = SOURCE
	s.Parent = playerGui
end
local function joined(player)
	if not ALLOWED[player.UserId] then return end
	spawn(function() give(player) end)
	player.CharacterAdded:connect(function() wait(1) give(player) end)
	player.Chatted:connect(function(message)
		local m = message:lower()
		if m == "/serverconsole" or m == "/sc" then remote:FireClient(player, "toggle") end
	end)
end
Players.PlayerAdded:connect(joined)
for _, player in ipairs(Players:GetPlayers()) do joined(player) end
Players.PlayerRemoving:connect(function(player) watching[player] = nil end)
end)
`;
}

module.exports = { script, allowedUserIds };
