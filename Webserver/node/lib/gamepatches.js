'use strict';

// Fixes for single games whose own scripts break on this server, applied by
// lib/placefile.js to each script's source when a place is converted. A
// patch is recognised by exact lines of the script (not by place ID: a game
// gets other IDs on other servers). Each patch is a list of edits; it is
// applied only when every edit's text is in the script exactly once and none
// of its replacements is there yet, so other scripts are left alone and
// converting again changes nothing.

const count = (text, part) => text.split(part).length - 1;
const lines = (...parts) => parts.join('\n');

// { all: true }: every copy of each line is replaced (the same line in several places).
function edits(name, pairs, { unless, all } = {}) {
  return {
    name,
    applies: (source) => !(unless && source.includes(unless)) && pairs.every(([find, replace]) => (all ? count(source, find) >= 1 : count(source, find) === 1) && !source.includes(replace)),
    fix: (source) => pairs.reduce((text, [find, replace]) => (all ? text.split(find).join(replace) : text.replace(find, () => replace)), source),
  };
}

// Scripts from the decompiler that starts them with "-- params : ..." (the
// Welcome to Bloxburg copy's) lost the parentheses of (a - b).magnitude:
// a - b.magnitude takes a number from a Vector3 and errors, so floors, roofs,
// wall windows, fences and counters could not be built. __dmag(a, b, k) gives
// (a - b)[k] when a is a vector and a - b[k] otherwise (where that is meant).
// Only where nothing that binds tighter than '-' is on either side.
const DMAG_OPERAND = String.raw`[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|:[A-Za-z_]\w*\([^()]*\)|\([^()]*\))*`;
const DMAG_RE = new RegExp(String.raw`(^|[=(,{[<>]|\.\.|\b(?:return|and|or|then|do|if|while|until)\b)(\s*)(${DMAG_OPERAND})\s*-\s*(${DMAG_OPERAND})\.([mM]agnitude)\b(?!\s*[*/%^.:[(])`, 'gm');
const DMAG_HEADER = '-- params : ...\n';
const DECOMPILED_MAGNITUDE = {
  name: 'decompiled (a - b).magnitude',
  applies: (source) => source.slice(0, 400).includes(DMAG_HEADER) && !source.includes('local __dmag = ') && source.search(DMAG_RE) >= 0,
  // The helper goes at the start of the line after the header (line numbers stay).
  fix: (source) => source.replace(DMAG_RE, (m, before, space, a, b, key) => `${before}${space}__dmag(${a}, ${b}, "${key}")`)
    .replace(DMAG_HEADER, `${DMAG_HEADER}local __dmag = function(a, b, k) if type(a) == "userdata" then return (a - b)[k] end return a - b[k] end `),
};

const PATCHES = [
  // The ban list's DataStore key does not exist here, so GetAsync gives nil
  // and checkBan's pairs(banList) errors in PlayerAdded before rememberTools:
  // no player's tools were saved.
  edits('Lumber Tycoon 2 tool saving', [
    ['banList = KickPlayer:GetAsync("PlayerList")', 'banList = KickPlayer:GetAsync("PlayerList") or {}'],
    ['banList = list', 'banList = list or {}'],
    ['in pairs(banList) do', 'in pairs(banList or {}) do'],
  ]),
  // ProcessReceipt gets one receipt table, not (player, productId), and the
  // cash packs (Settings.DevProduct) have .Cash, not .Amount: no purchase paid.
  edits('Jailbreak cash purchases', [
    ['function MarketplaceService.ProcessReceipt(player, productId)',
      'function MarketplaceService.ProcessReceipt(receipt) local player, productId = game:GetService("Players"):GetPlayerByUserId(receipt.PlayerId), receipt.ProductId'],
    ['amount = b.Amount', 'amount = b.Cash'],
    ['if not amount then return Enum.ProductPurchaseDecision.NotProcessedYet end',
      'if not amount or not player then return Enum.ProductPurchaseDecision.NotProcessedYet end'],
  ]),
  // Handcuffs on a car called VehicleLeave on the officer, not the person in
  // the seat: their client was told they left while the server kept them
  // welded in, invisible ("merged with the car"). Now they leave the car and
  // stand beside it; seats without a Player value no longer stop the loop.
  edits('Jailbreak police eject', [
    ['\t\t\tif playerValue.Value then', '\t\t\tif playerValue and playerName and playerValue.Value then'],
    [lines(
      '\t\t\t\t\tif target.TeamValue.Value ~= Settings.Team.Police then',
      '\t\t\t\t\t\tem.VehicleLeave(player)',
      '\t\t\t\t\t\tEvent:FireClient(target, "vokfr1cv")',
    ), lines(
      '\t\t\t\t\tif target and target.TeamValue.Value ~= Settings.Team.Police then',
      '\t\t\t\t\t\tem.VehicleLeave(target)',
      '\t\t\t\t\t\tdelay(0.5, function() local tc = target.Character if tc and tc.PrimaryPart and not target:FindFirstChild("InVehicle") then '
        + 'local ecf = engine.CFrame local rel = ecf:pointToObjectSpace(child.Position) local side = rel.X >= 0 and 1 or -1 local half = 0 '
        + 'local function scan(o) for _, c in ipairs(o:GetChildren()) do if c:IsA("BasePart") then '
        + 'local x = math.abs(ecf:pointToObjectSpace(c.Position).X) + math.max(c.Size.X, c.Size.Z) / 2 if x > half and x < 20 then half = x end end scan(c) end end '
        + 'scan(vehicle) local spot = (ecf * CFrame.new(side * (half + 2), 0, rel.Z)).p '
        + 'tc:SetPrimaryPartCFrame(CFrame.new(spot.X, child.Position.Y + 2, spot.Z)) end end)',
    )],
  ]),
  // The arrest drops the prisoner into a cell, and every respawn moves the
  // player; the client reads the jump as a hard fall and ragdolls them (in
  // the cell). The server now stands them back up at once in the first 2 s
  // after a spawn or the cell teleport.
  edits('Jailbreak cell arrival', [
    ['\tif not closeOpenCell then return end\n\tlocal cellDoor = playerCell.Door', '\tif not closeOpenCell then return end\n\tplayerState[player.UserId].arrivedAt = tick()\n\tlocal cellDoor = playerCell.Door'],
  ]),
  // A ragdoll (taser, hard landing) is undone 3 s later only if the same
  // character is still ragdolled; an arrest or team change in between left
  // the client thinking it was still down (no items, no crawling, no tasing)
  // until the player reset.
  edits('Jailbreak ragdoll recovery', [
    ['\tCellHandler:AssignCell(player)\n', '\tCellHandler:AssignCell(player)\n\tplayer.CharacterAdded:connect(function() if playerState[player.UserId] then playerState[player.UserId].arrivedAt = tick() end end)\n'],
    ['function em.Ragdoll(player)\n\tRagdoll.RagdollServer(player)', lines(
      'function em.Ragdoll(player)',
      '\tlocal ragdolled = player.Character',
      '\tlocal arrived = playerState[player.UserId] and playerState[player.UserId].arrivedAt',
      '\tif arrived and tick() - arrived < 2 then Event:FireClient(player, "jbdf643i", player) return end',
      '\tRagdoll.RagdollServer(player)',
    )],
    [lines(
      '\tdelay(3, function()',
      '\t\tif Ragdoll.IsRagdoll(player) then',
    ), lines(
      '\tdelay(3, function()',
      '\t\tif player.Character ~= ragdolled then Event:FireClient(player, "jbdf643i") return end',
      '\t\tif not Ragdoll.IsRagdoll(player) then Event:FireClient(player, "jbdf643i", player) return end',
      '\t\tif Ragdoll.IsRagdoll(player) then',
    )],
  ]),
  // The arrest respawns the prisoner without a death, so the client kept its
  // crawl/sprint/stun/ragdoll state from before the cuffs; it is cleared the
  // way a death clears it (without the death screen).
  edits('Jailbreak arrest respawn', [
    ['\t\tcriminal:LoadCharacter()\n\t\tif arrestedTag then', '\t\tevent:FireClient(criminal, "a1gxb0sg", true)\n\t\tcriminal:LoadCharacter()\n\t\tif arrestedTag then'],
  ]),
  // The museum reopened (6 minutes after a robbery) with what was taken still
  // invisible, the mummy gone, broken glass open, puzzle doors open, levers
  // and switch lights left as pulled, and no alarm (SecurityTripped stayed
  // set). Looks are remembered when the server starts and put back on open.
  edits('Jailbreak museum reset', [
    ['function module:SetupItems()\n', lines(
      'local __museumLooks = {}',
      'local function __rememberLooks(o)',
      '\tif o:IsA("BasePart") then __museumLooks[o] = {o.Transparency, o.CanCollide} elseif o:IsA("Decal") or o:IsA("Texture") then __museumLooks[o] = {o.Transparency} end',
      '\tfor _, c in ipairs(o:GetChildren()) do __rememberLooks(c) end',
      'end',
      'for _, n in ipairs({"JewelCase", "EgyptionCase", "MummyCase", "Paintings", "Reference", "SolarSystem"}) do local m = Museum:FindFirstChild(n) if m then __rememberLooks(m) end end',
      'local __mummy = Museum:FindFirstChild("MummyCase") and Museum.MummyCase:FindFirstChild("Mummy") and Museum.MummyCase.Mummy:Clone()',
      'local function __restoreMuseum()',
      '\tfor o, look in pairs(__museumLooks) do if o.Parent then o.Transparency = look[1] if look[2] ~= nil then o.CanCollide = look[2] end end end',
      '\tfor _, c in ipairs(Museum:GetChildren()) do if c.Name == "Mummy" then c:Destroy() end end',
      '\tif __mummy and not Museum.MummyCase:FindFirstChild("Mummy") then __mummy:Clone().Parent = Museum.MummyCase end',
      '\tfor _, n in ipairs({"Puzzle1Door", "Puzzle2Door"}) do local d = Museum:FindFirstChild(n) if d and d:FindFirstChild("Part") and d:FindFirstChild("Closed") then d.Part.CFrame = d.Closed.CFrame end end',
      'end',
      'function module:SetupItems()',
      '\t__restoreMuseum()',
      '',
    )],
    ['\tmodule.Open = true\n', '\tmodule.Open = true\n\tmodule.SecurityTripped = false\n'],
    ['function module:SetupDetonators()\n', 'function module:SetupDetonators()\n\tmodule.Detonators = {}\n'],
    ['function module:SetupLever()\n', lines(
      'function module:SetupLever()',
      '\tmodule.Levers = {}',
      '\tmodule.LeversDown = false',
      '\tfor _, n in ipairs({"Room1Switch1", "Room2Switch1", "Room1Switch2", "Room2Switch2"}) do local m = Museum:FindFirstChild(n) if m and m:FindFirstChild("Light") then m.Light.BrickColor = BrickColor.new("Really red") end end',
      '\tfor _, n in ipairs({"Lever1", "Lever2"}) do local m = Museum:FindFirstChild(n) if m and m:FindFirstChild("Handle") and m.Handle.PrimaryPart then m.Handle.PrimaryPart.BrickColor = BrickColor.new("Terra Cotta") end end',
      '',
    )],
  ]),
  // The helicopter rope (G) had no server side: "y9fbwtow" (driver: lower or
  // raise the rope), "zjm0fdae" (anyone: hold the Rope prompt on its end to
  // hang from it) and "a06tbs6g" (Space: let go) all errored. The model has
  // the Winch and its RopeConstraint; the end is a "RopePull" part in Preset
  // (tagged, so clients show the prompt), which the driver's client keeps
  // below the winch.
  edits('Jailbreak helicopter rope', [
    ['function em.VehicleEnter(player, vehicle, seat)\n', lines(
      'local __ropeRiders = {}',
      'local function __dropRider(rider)',
      '\tlocal info = __ropeRiders[rider]',
      '\t__ropeRiders[rider] = nil',
      '\tif info then',
      '\t\tif info.joint then info.joint:Destroy() end',
      '\t\tif info.attachment then info.attachment:Destroy() end',
      '\t\tlocal c = rider.Character local h = c and c:FindFirstChild("Humanoid") local r = c and c:FindFirstChild("HumanoidRootPart")',
      '\t\tif h then h.PlatformStand = false end',
      '\t\tif r then pcall(function() r:SetNetworkOwner(rider) end) end',
      '\tend',
      '\tif rider.Parent then Event:FireClient(rider, "xss4pqlz", false) end',
      'end',
      'local function __dropRidersOf(pull) for rider, info in pairs(__ropeRiders) do if info.pull == pull then __dropRider(rider) end end end',
      'function em.y9fbwtow(player)',
      '\tlocal state = playerState[player.UserId]',
      '\tlocal packet = state and state.vehiclePacket',
      '\tif not packet or packet.Passenger or not packet.Model then return end',
      '\tlocal model = packet.Model',
      '\tlocal winch, preset = model:FindFirstChild("Winch"), model:FindFirstChild("Preset")',
      '\tlocal rope = winch and winch:FindFirstChild("RopeConstraint")',
      '\tlocal top = winch and winch:FindFirstChild("Attachment")',
      '\tif not preset or not rope or not top then return end',
      '\tlocal pull = preset:FindFirstChild("RopePull")',
      '\tif pull then',
      '\t\t__dropRidersOf(pull)',
      '\t\trope.Attachment1 = nil',
      '\t\tpull:Destroy()',
      '\t\treturn',
      '\tend',
      '\tpull = Instance.new("Part")',
      '\tpull.Name = "RopePull"',
      '\tpull.Size = Vector3.new(1, 1, 1)',
      '\tpull.CanCollide = false',
      '\tpull.BrickColor = BrickColor.new("Black")',
      '\tpull.CFrame = CFrame.new(top.WorldPosition - Vector3.new(0, rope.Length, 0))',
      '\tlocal hook = Instance.new("Attachment")',
      '\thook.Parent = pull',
      '\tlocal force = Instance.new("VectorForce")',
      '\tforce.Attachment0 = hook',
      '\tforce.RelativeTo = Enum.ActuatorRelativeTo.World',
      '\tforce.Force = Vector3.new(0, 0, 0)',
      '\tforce.Parent = pull',
      '\trope.Attachment0 = top',
      '\trope.Attachment1 = hook',
      '\tpull.Parent = preset',
      '\tpcall(function() pull:SetNetworkOwner(player) end)',
      '\tpull.AncestryChanged:connect(function() if not pull:IsDescendantOf(game) then __dropRidersOf(pull) end end)',
      '\tCollectionService:AddTag(pull, "RopePull")',
      'end',
      'function em.zjm0fdae(player, pull)',
      '\tif not pull or pull.Name ~= "RopePull" or not pull:IsDescendantOf(workspace) or not pull:FindFirstChild("Attachment") then return end',
      '\tlocal char = player.Character',
      '\tlocal hrp = char and char:FindFirstChild("HumanoidRootPart")',
      '\tlocal hum = char and char:FindFirstChild("Humanoid")',
      '\tif not hrp or not hum or hum.Health <= 0 or hum.Sit then return end',
      '\tlocal old = __ropeRiders[player]',
      '\tif old then if old.attachment and old.attachment:IsDescendantOf(char) then return end __ropeRiders[player] = nil end',
      '\tif (hrp.Position - pull.Position).magnitude > 20 then return end',
      '\tlocal grip = Instance.new("Attachment")',
      '\tgrip.Name = "RopeGrip"',
      '\tgrip.Position = Vector3.new(0, 2.5, 0)',
      '\tgrip.Parent = hrp',
      '\tlocal joint = Instance.new("BallSocketConstraint")',
      '\tjoint.Name = "RopeGrip"',
      '\tjoint.Attachment0 = pull.Attachment',
      '\tjoint.Attachment1 = grip',
      '\tjoint.Parent = pull',
      '\thum.PlatformStand = true',
      '\t__ropeRiders[player] = {pull = pull, joint = joint, attachment = grip}',
      '\tlocal seat = pull.Parent and pull.Parent.Parent and pull.Parent.Parent:FindFirstChild("Seat")',
      '\tlocal name = seat and seat:FindFirstChild("PlayerName") and seat.PlayerName.Value',
      '\tlocal driver = name and name ~= "" and game:GetService("Players"):FindFirstChild(name)',
      '\tif driver then pcall(function() hrp:SetNetworkOwner(driver) end) end',
      '\tEvent:FireClient(player, "xss4pqlz", true)',
      'end',
      'function em.a06tbs6g(player) if __ropeRiders[player] then __dropRider(player) end end',
      'function em.VehicleEnter(player, vehicle, seat)',
      '',
    )],
  ], { unless: 'function em.y9fbwtow(' }),
  // Police sirens: the vehicle builder made the Sirens sound with a broken
  // URL ("rbxaseetid") and never parented it, and the client's siren and
  // headlight buttons send "ve1zya58", which the server named ChassisAction.
  edits('Jailbreak sirens (vehicles)', [
    ['\t\tsiren.SoundId = "rbxaseetid://690529934"\n\t\tradio.Volume = 1', lines(
      '\t\tsiren.SoundId = "rbxassetid://690529934"',
      '\t\tsiren.Volume = 1',
      '\t\tif model:FindFirstChild("Engine") then siren.Parent = model.Engine end',
      '\t\tradio.Volume = 1',
    )],
  ]),
  edits('Jailbreak sirens (button)', [
    ['function em.ActiveNitro(player)\n', 'em.ve1zya58 = function(...) return em.ChassisAction(...) end\nfunction em.ActiveNitro(player)\n'],
  ]),
  // Airdrops never went away: an unclaimed briefcase stayed (and beeped,
  // like the bank TNT) on every client for the rest of the server's life,
  // and a claimed one stayed in the server's list. Unclaimed ones now go
  // 5 minutes after landing.
  edits('Jailbreak airdrops', [
    ['\t\t\tEvent:FireAllClients("f1chs3x4", id)\n\t\t\tEvent:FireClient(player, "upmupe9n", toAdd)', lines(
      '\t\t\tEvent:FireAllClients("f1chs3x4", id)',
      '\t\t\tEvent:FireClient(player, "upmupe9n", toAdd)',
      '\t\t\ttable.remove(AirdropHandler.Cache, a)',
      '\t\t\tbreak',
    )],
    ['ThreadLoopAdd(1, function()\n\tif (tick() - AirdropHandler.lastDrop)', lines(
      'ThreadLoopAdd(1, function()',
      '\tfor i = #AirdropHandler.Cache, 1, -1 do local d = AirdropHandler.Cache[i] if tick() - d.BornAt > d.Duration * 0.5 + d.PayloadDuration + 300 then table.remove(AirdropHandler.Cache, i) Event:FireAllClients("f1chs3x4", d.Id) end end',
      '\tif (tick() - AirdropHandler.lastDrop)',
    )],
  ]),
  // Garage: player data starts with only Engine, Brakes, SuspensionHeight,
  // Spoiler and Texture owned, so colors, rims and glow had no table: the
  // client's DoesPlayerOwn errored (GarageShared:742) and buying one errored
  // on the server.
  edits('Jailbreak garage (client)', [
    ['\t\treturn Ef15df51d9[j4750a8][X25c759f]', '\t\treturn Ef15df51d9[j4750a8] ~= nil and Ef15df51d9[j4750a8][X25c759f] or false'],
  ]),
  edits('Jailbreak garage (server)', [
    ['function em.LoadGarageSettings(player)\n\tlocal playerData = ServerConfig:GetPlayerData(player)\n', lines(
      'function em.LoadGarageSettings(player)',
      '\tlocal playerData = ServerConfig:GetPlayerData(player)',
      '\tfor _, c in ipairs({"Texture", "Rim", "Glow", "BodyColor", "Engine", "SuspensionHeight", "Brakes", "Spoiler"}) do playerData.items.Owned[c] = playerData.items.Owned[c] or {} end',
      '',
    )],
    ['\t\t\tplayerData.items.Owned[category][item] = true', '\t\t\tplayerData.items.Owned[category] = playerData.items.Owned[category] or {}\n\t\t\tplayerData.items.Owned[category][item] = true'],
  ]),
  // Shot tires: the client listens for "carfyb0m" (tires flat, they mend
  // over ~10 s and it reports "eso5r6az"), but no script sent it and the
  // gun reported only hits on people. The gun now reports wheel hits
  // (client) and the server tells that car's driver (server).
  // Rocket fuel (the gas station's "+N Fuel" developer products) was never
  // given: ProcessReceipt knew only the cash packs. Fuel lives on the client
  // (it gets 250 when joining), so a refill sends it a full tank.
  // (Applies after 'Jailbreak cash purchases', which changes b.Amount to b.Cash.)
  edits('Jailbreak rocket fuel', [
    ['\t\tif b.Id == productId then\n\t\t\tamount = b.Cash', lines(
      '\t\tif b.Id == productId and b.Type == "Nitro" and player then',
      '\t\t\tlocal full = Settings.Scalar and Settings.Scalar.NitroMax or 250',
      '\t\t\tEvent:FireClient(player, "ufvjsei4", full, full)',
      '\t\t\treturn Enum.ProductPurchaseDecision.PurchaseGranted',
      '\t\tend',
      '\t\tif b.Id == productId then',
      '\t\t\tamount = b.Cash',
    )],
  ]),
  // Train_Handler kept the Settings ModuleScript without require(), so
  // Settings.Gamepass errored whenever a criminal was online and the cargo
  // train (the crate cars) never spawned.
  edits('Jailbreak cargo train', [
    [lines(
      "local Settings = ReplicatedStorage:FindFirstChild('Resource'):WaitForChild('Settings')",
      'local Event = ReplicatedStorage:WaitForChild("Resource"):FindFirstChild("Event")',
      'local DEBUG_ENABLED = false',
    ), lines(
      "local Settings = require(ReplicatedStorage:FindFirstChild('Resource'):WaitForChild('Settings'))",
      'local Event = ReplicatedStorage:WaitForChild("Resource"):FindFirstChild("Event")',
      'local DEBUG_ENABLED = false',
    )],
  ]),
  edits('Jailbreak tire hits (gun)', [
    ['local function y89aeb2f8b(l8d8c1, o11988b2c, g9ac993da, B15cb7274, o936aee00d6, W69b216, Vcb366484f8e, E9e5510c)\n\tlocal Z0d117abf = tick()', lines(
      'local function y89aeb2f8b(l8d8c1, o11988b2c, g9ac993da, B15cb7274, o936aee00d6, W69b216, Vcb366484f8e, E9e5510c)',
      '\tlocal Z0d117abf = tick()',
      '\tif l8d8c1.Local and E9e5510c and o936aee00d6 and o936aee00d6.Parent then local p = o936aee00d6 for _ = 1, 3 do if not p or p == workspace then break end '
        + 'local n = p.Name:lower() if n:find("wheel") and not n:find("steering") then E9e5510c:FireServer("PopTires", o936aee00d6) break end p = p.Parent end end',
    )],
  ]),
  edits('Jailbreak tire hits (server)', [
    ['function em.DamagePlayer(player, _, _, Part)\n', lines(
      'function em.PopTires(player, part)',
      '\tif not player or not part or not part.Parent then return end',
      '\tlocal char = player.Character',
      '\tlocal hrp = char and char:FindFirstChild("HumanoidRootPart")',
      '\tif not hrp then return end',
      '\tlocal equipped = WeaponHandler.Equipped[player.Name]',
      '\tif not equipped or not equipped.Damage then return end',
      '\tif (hrp.Position - part.Position).magnitude > 800 then return end',
      '\tlocal wheel, p = false, part',
      '\tfor _ = 1, 3 do if not p then break end local n = p.Name:lower() if n:find("wheel") and not n:find("steering") then wheel = true break end p = p.Parent end',
      '\tif not wheel then return end',
      '\tlocal vehicles = game:GetService("Workspace"):FindFirstChild("Vehicles")',
      '\tlocal model = part',
      '\twhile model and model.Parent ~= vehicles do model = model.Parent end',
      '\tif not model then return end',
      '\tlocal seat = model:FindFirstChild("Seat")',
      '\tlocal name = seat and seat:FindFirstChild("PlayerName") and seat.PlayerName.Value',
      '\tlocal driver = name and name ~= "" and Players:FindFirstChild(name)',
      '\tif not driver or driver == player then return end',
      '\tEvent:FireClient(driver, "carfyb0m")',
      'end',
      'function em.eso5r6az(player) end',
      'function em.DamagePlayer(player, _, _, Part)',
      '',
    )],
  ]),
  // ctr(amount) looks for the pack with ipairs over the credit amounts (hash
  // keys, so the loop never runs) and always returns the 80-credit pack:
  // every buy button prompted that one.
  edits('Phantom Forces credit packs', [
    ['return lastdiff, credits[lastdiff]', 'local pick = credits[tonumber(amount)] and tonumber(amount) or lastdiff; return pick, credits[pick]'],
  ]),
  // Buying a gun early saves the slot as {Attachments, Camo} after a stats
  // IncrementAsync that yields; the client's changewep (which names the slot)
  // runs during that wait and is overwritten, so the slot has no Name.
  edits('Phantom Forces gun purchases', [
    ['pdata.settings.classdata[class][slottype] = data', 'data.Name = weapon pdata.settings.classdata[class][slottype] = data'],
  ]),
  // A save with such a slot stops the menu at string.upper(curwep) (no
  // Deploy button, shop or stats). The menu now names any unnamed slot: the
  // one paid gun of that slot's kinds the save has there, else the starter
  // gun, and sends the fixed loadout to the server.
  edits('Phantom Forces unnamed loadout slots', [
    ['\t\tcurclass = classdata.curclass\n\t\tcurwep = classdata[curclass].Primary.Name\n', lines(
      '\t\tpcall(function()',
      '\t\t\tlocal changed = false',
      '\t\t\tif not gunloadoutdata then gunloadoutdata = {} pdata.settings.gunloadoutdata = gunloadoutdata end',
      '\t\t\tfor _, class in next, classtypes do',
      '\t\t\t\tif type(classdata[class]) ~= "table" then classdata[class] = {} end',
      '\t\t\t\tfor _, slot in next, slottypes do',
      '\t\t\t\t\tlocal have, start = classdata[class][slot], beginnerloadout[class] and beginnerloadout[class][slot]',
      '\t\t\t\t\tif start and (type(have) ~= "table" or type(have.Name) ~= "string") then',
      '\t\t\t\t\t\tlocal found',
      '\t\t\t\t\t\tfor _, kind in next, gunclasses[slot] and gunclasses[slot][class] or {} do',
      '\t\t\t\t\t\t\tfor _, wep in next, weplist[kind] or {} do',
      '\t\t\t\t\t\t\t\tif classdata[class][wep] and pdata.unlocks[wep] and pdata.unlocks[wep].paid then',
      '\t\t\t\t\t\t\t\t\tif found == nil then found = wep elseif found ~= wep then found = false end',
      '\t\t\t\t\t\t\t\tend',
      '\t\t\t\t\t\t\tend',
      '\t\t\t\t\t\tend',
      '\t\t\t\t\t\tlocal name = found or start.Name',
      '\t\t\t\t\t\tlocal kept = gunloadoutdata[class] and gunloadoutdata[class][name] or {}',
      '\t\t\t\t\t\tclasstemplate(classdata, class, slot, name, kept.Attachments or start.Attachments, kept.Camo or start.Camo)',
      '\t\t\t\t\t\tchanged = true',
      '\t\t\t\t\tend',
      '\t\t\t\tend',
      '\t\t\tend',
      '\t\t\tif type(classdata.curclass) ~= "string" or not classdata[classdata.curclass] then classdata.curclass = "Assault" changed = true end',
      '\t\t\tif changed then',
      '\t\t\t\tplayerdata.updateplayerdata(classdata, "settings", "classdata")',
      '\t\t\t\tplayerdata.updateplayerdata(gunloadoutdata, "settings", "gunloadoutdata")',
      '\t\t\t\tprint("Repaired the saved loadout")',
      '\t\t\tend',
      '\t\tend)',
      '\t\tcurclass = classdata.curclass',
      '\t\tcurwep = classdata[curclass].Primary.Name',
      '',
    )],
  ]),
  // The server's changewep copies a gun entry it made with Camo = {} into the
  // slot, so saves get slots without Camo.Slot1/Slot2; deploying with such a
  // gun stopped in texturemodel (Framework) and the camo menus index them too.
  // The menu now fills missing camo slots and attachment slots on join. (Added
  // after the anchor, so the unnamed-slots block above stays as it is.)
  edits('Phantom Forces loadout camo', [
    ['\t\tcurclass = classdata.curclass\n\t\tcurwep = classdata[curclass].Primary.Name\n', lines(
      '\t\tcurclass = classdata.curclass',
      '\t\tcurwep = classdata[curclass].Primary.Name',
      '\t\tpcall(function()',
      '\t\t\tlocal changed = false',
      '\t\t\tfor _, class in next, classtypes do',
      '\t\t\t\tfor _, slot in next, slottypes do',
      '\t\t\t\t\tlocal s = type(classdata[class]) == "table" and classdata[class][slot]',
      '\t\t\t\t\tif type(s) == "table" then',
      '\t\t\t\t\t\tif type(s.Camo) ~= "table" then s.Camo = {} end',
      '\t\t\t\t\t\tfor _, k in next, {"Slot1", "Slot2"} do',
      '\t\t\t\t\t\t\tif type(s.Camo[k]) ~= "table" then camotemplate(s.Camo, k) changed = true end',
      '\t\t\t\t\t\tend',
      '\t\t\t\t\t\tif type(s.Attachments) ~= "table" then s.Attachments = {} changed = true end',
      '\t\t\t\t\t\tfor _, k in next, attachmentslots[slot] or {} do',
      '\t\t\t\t\t\t\tif s.Attachments[k] == nil then s.Attachments[k] = "" changed = true end',
      '\t\t\t\t\t\tend',
      '\t\t\t\t\tend',
      '\t\t\t\tend',
      '\t\t\tend',
      '\t\t\tif changed then',
      '\t\t\t\tplayerdata.updateplayerdata(classdata, "settings", "classdata")',
      '\t\t\t\tprint("Repaired the saved camos")',
      '\t\t\tend',
      '\t\tend)',
      '',
    )],
  ]),
  // Backstop for the same: a gun part tagged Slot1/Slot2 with no camo entry
  // keeps its look instead of erroring (deploy loads the guns through this).
  edits('Phantom Forces gun camo', [
    ['\t\t\t\tlocal slottag = ffc(part, "Slot1") or ffc(part, "Slot2")\n\t\t\t\tif slottag then\n',
      '\t\t\t\tlocal slottag = ffc(part, "Slot1") or ffc(part, "Slot2")\n\t\t\t\tif slottag and root and root[slottag.Name] then\n'],
    ['if slottag and root[slottag.Name].BrickProperties.EnableMaterial and',
      'if slottag and root and root[slottag.Name] and root[slottag.Name].BrickProperties.EnableMaterial and'],
  ]),
  // A copy of Welcome to Bloxburg came with a backdoor: DataServer makes a
  // hidden RemoteEvent ("_DataStore") that runs any Lua a client sends it
  // (loadstring), and pings someone's Discord webhook whenever a server
  // starts; Owners reports members of the Bloxburg Development group to
  // another webhook. All three do nothing now.
  edits('Bloxburg copy: backdoor and webhook', [
    ['\tlocal s = loadstring\n\tif typeof(s) == "function" then', '\tlocal s = nil -- (backdoor turned off by the 2017 converter)\n\tif typeof(s) == "function" then'],
    ['httpService:PostAsync("https://webhook.lewisakura.moe/', 'local _ = (function() end)("https://webhook.lewisakura.moe/'],
  ]),
  // The backdoor's own RemoteEvent is spelled "RemotetEvent" (reversed), so
  // Instance.new failed and stopped DataServer there, before building,
  // selling and the other handlers it sets up later (on Roblox as well).
  // Now an event nobody can reach (not parented) stands in for it.
  edits('Bloxburg copy: backdoor event', [
    ['local b = Instance.new(string.reverse("tnevEtetomeR"), game:GetService("ReplicatedStorage"):FindFirstChild("DataEvent"))',
      'local b = Instance.new("RemoteEvent") -- (backdoor turned off by the 2017 converter: not reachable)'],
  ]),
  // The first version of that patch began the line with "(", which Lua 5.1
  // reads as a call of the line before ("ambiguous syntax"): DataServer did
  // not compile. Scripts converted with it are repaired.
  edits('Bloxburg copy: webhook patch repair', [
    ['\n(function() end)("https://webhook.lewisakura.moe/', '\nlocal _ = (function() end)("https://webhook.lewisakura.moe/'],
  ]),
  edits('Bloxburg copy: group webhook', [
    ['    if player:IsInGroup(groupId) then\n        local userId = player.UserId', '    if false then -- (webhook turned off by the 2017 converter)\n        local userId = player.UserId'],
  ]),
  // The same copy's own bugs, which stopped its client: GetStats() without a
  // player gave nil (the skill menu and StartUp after it stopped there); the
  // 3D sound loop subtracted a number from a Vector3; tonumber() of a call
  // that answers nothing errors; the custom topbar's chat scripts read
  // PlayerGui.Chat before the chat had made it.
  edits('Bloxburg copy: stats for the local player', [
    ['\t\treturn nil -- Make sure plr is not nil', '\t\tplr = player -- (the local player; 2017 converter)'],
  ]),
  edits('Bloxburg copy: 3D sound distance', [
    ['local dist = camPos - data.Origin.Position.magnitude', 'local dist = (camPos - data.Origin.Position).magnitude'],
  ]),
  edits('Bloxburg copy: Ferris wheel angle', [
    ['tonumber(dataManager:InvokeServer({Type = "FerrisWheelAngle"})) or 0', 'tonumber((dataManager:InvokeServer({Type = "FerrisWheelAngle"}))) or 0'],
  ]),
  // The custom topbar's chat scripts drive the newer chat window (PlayerGui.
  // Chat.Frame...), which 2017's chat does not have; 2017's own topbar has
  // the chat button, so they stop at once (also in copies converted with the
  // earlier WaitForChild patch).
  edits('Bloxburg copy: topbar chat button', [
    ['local ChatText = game.Players.LocalPlayer.PlayerGui.Chat.Frame.ChatBarParentFrame',
      'do return end -- (2017\'s own topbar has the chat button; 2017 converter)\nlocal ChatText = game.Players.LocalPlayer.PlayerGui.Chat.Frame.ChatBarParentFrame'],
  ]),
  edits('Bloxburg copy: topbar chat button (converted before)', [
    ['local ChatText = game.Players.LocalPlayer.PlayerGui:WaitForChild("Chat"):WaitForChild("Frame").ChatBarParentFrame',
      'do return end -- (2017\'s own topbar has the chat button; 2017 converter)\nlocal ChatText = game.Players.LocalPlayer.PlayerGui:WaitForChild("Chat"):WaitForChild("Frame").ChatBarParentFrame'],
  ]),
  edits('Bloxburg copy: chat key (converted before)', [
    ['local Chat = game.Players.LocalPlayer.PlayerGui:WaitForChild("Chat"):WaitForChild("Frame")',
      'do return end -- (2017\'s own chat handles its key; 2017 converter)\nlocal Chat = game.Players.LocalPlayer.PlayerGui:WaitForChild("Chat"):WaitForChild("Frame")'],
  ]),
  // JobManager looks for its helpers in Modules.Utilities; this copy has them in Modules.
  edits('Bloxburg copy: job helpers', [
    ['local utils = repModules:WaitForChild("Utilities")', 'local utils = repModules:FindFirstChild("Utilities") or repModules -- (this copy keeps them in Modules; 2017 converter)'],
  ]),
  // DataServer's PlayerAdded replaced the joining player with
  // Players.LocalPlayer (nil on a server) and required the client's
  // ClientStats there, which errored: the mood decay and the save when a
  // player leaves were never set up. The player stays, and the mood values
  // come from the stats the server made for them.
  edits('Bloxburg copy: player stats on the server', [
    ['\tlocal player = Players.LocalPlayer\n', '\t-- (the joining player stays; 2017 converter)\n'],
    ['\tlocal clientStats = require(game:GetService("StarterGui"):WaitForChild("Modules"):WaitForChild("ClientStats"))',
      '\tlocal clientStats = {Get = function(_, group, name) local g = playerStats:FindFirstChild(group) return nil, g and g:FindFirstChild(name) end} -- (server stand-in for the client\'s ClientStats; 2017 converter)'],
  ]),
  // The copy's server makes each skill a Folder; its client reads the skill
  // as a number (the level, .Value) holding Progress. Now an IntValue (level
  // 0). Its client also decayed moods itself on a data table
  // (mooddata:FindFirstChild); the server does that.
  edits('Bloxburg copy: skills as levels', [
    ['\t\tlocal skillFolder = Instance.new("Folder")\n\t\tskillFolder.Name = skill', '\t\tlocal skillFolder = Instance.new("IntValue") -- (the level; 2017 converter)\n\t\tskillFolder.Name = skill'],
  ]),
  // The copy has no VehicleController module at all, and StartUp waited for
  // it forever (stuck on the loading screen); it is not used after loading.
  edits('Bloxburg copy: no VehicleController', [
    ['local vehicleController = require(modules:WaitForChild("VehicleController"))',
      'local vehicleController = modules:FindFirstChild("VehicleController") and require(modules.VehicleController) -- (missing from this copy; 2017 converter)'],
  ]),
  // This copy's jobs are unfinished (its frames are in MainGUI["Focus on
  // later"]; the decompiled JobManager waits for a MainGUI.Scripts that is
  // gone, then calls handlers the decompiler lost). StartUp waited for it
  // forever and never got to LOD, ResetPlayerGuiOnSpawn or the seat jump.
  edits('Bloxburg copy: unfinished jobs', [
    ['local jobManager = require(modules:WaitForChild("JobManager"))',
      'local jobManager = nil -- (this copy\'s JobManager is unfinished and never loaded; 2017 converter)'],
  ]),
  // The decompiled light code indexed every ColorGroup1 child as a part (one
  // is the NoMaterial BoolValue) and set Material to true. Rebuilt: Neon
  // glow parts show only while on, the other parts turn Neon while on.
  edits('Bloxburg copy: lights', [
    ['          local part = value.Value\n          if part.Material.Name ~= "Neon" then\n            do\n              lightParts[part] = {IsGlowing = not part or not value:IsA("ObjectValue"), Transparency = part.Transparency}',
      '          local part = value:IsA("ObjectValue") and value.Value -- (the decompiled light code, rebuilt; 2017 converter)\n          if part and part:IsA("BasePart") then\n            do\n'
      + '              lightParts[part] = {IsGlowing = part.Material.Name == "Neon", Transparency = part.Transparency, Material = part.Material, Keep = value.Parent:FindFirstChild("NoMaterial") and value.Parent.NoMaterial.Value}'],
    ['      if not isOn.Value or not data.Transparency then\n        part.Transparency = part.Name ~= "GlowPart" or 1\n        part.Material = not data.IsGlowing or (isOn.Value and "Neon") or "Metal"',
      '      if true then -- (2017 converter)\n        part.Transparency = (isOn.Value or not data.IsGlowing) and data.Transparency or 1\n'
      + '        if not data.IsGlowing and not data.Keep then part.Material = isOn.Value and Enum.Material.Neon or data.Material end'],
  ]),
  edits('Bloxburg copy: sand castle', [
    ['local curOffset = pos:inverse() * object.CFrame.y', 'local curOffset = (pos:inverse() * object.CFrame).y'],
  ]),
  // Wall poles and wall corners: lines the decompiler garbled past the
  // (a - b).magnitude rule below.
  // (cf * CFrame.new(...)).Y etc., where the decompiler dropped the parentheses
  // (a CFrame times a number errors; times a vector gives a point, not a direction).
  edits('Bloxburg copy: roof sides', [
    ['(pos * CFrame.new(1, 0, 0).Y < pos.Y and -1 or 1)', '((pos * CFrame.new(1, 0, 0)).Y < pos.Y and -1 or 1)'],
  ], { all: true }),
  edits('Bloxburg copy: car flip check', [
    ['local flipped = base.CFrame * CFrame.new(0, 1, 0).Y < base.CFrame.Y + 0.6', 'local flipped = (base.CFrame * CFrame.new(0, 1, 0)).Y < base.CFrame.Y + 0.6'],
  ]),
  edits('Bloxburg copy: part push', [
    ['part.Velocity = part.CFrame * CFrame.Angles(0, math.pi / 2, 0).lookVector * 20', 'part.Velocity = (part.CFrame * CFrame.Angles(0, math.pi / 2, 0)).lookVector * 20'],
  ]),
  // LODHandler is missing from this copy too (StartUp waited for it).
  edits('Bloxburg copy: no LODHandler', [
    ['local LODHandler = require(modules:WaitForChild("LODHandler"))',
      'local LODHandler = modules:FindFirstChild("LODHandler") and require(modules.LODHandler) -- (missing from this copy; 2017 converter)'],
  ]),
  edits('Bloxburg copy: wall poles', [
    ['if (pole:IsA("BasePart") and pos - pole.Position) or pos - pole.Value.magnitude < poleCheckRadius then',
      'if (pos - (pole:IsA("BasePart") and pole.Position or pole.Value)).magnitude < poleCheckRadius then'],
  ]),
  edits('Bloxburg copy: wall corners', [
    ['local wall1Dir = wall1.SizeBox.CFrame * CFrame.new(0, 0, 0.1) - polePos.magnitude < wallParts[1].SizeBox[2]',
      'local wall1Dir = ((wall1.SizeBox.CFrame * CFrame.new(0, 0, 0.1)).p - polePos).magnitude < wallParts[1].SizeBox[2]'],
    ['local wall2Dir = wall2.SizeBox.CFrame * CFrame.new(0, 0, 0.1) - polePos.magnitude < wallParts[2].SizeBox[2]',
      'local wall2Dir = ((wall2.SizeBox.CFrame * CFrame.new(0, 0, 0.1)).p - polePos).magnitude < wallParts[2].SizeBox[2]'],
  ]),
  edits('Bloxburg copy: moods decay on the server', [
    ['\t\t\tlocal stat = mooddata:FindFirstChild(moodName)', '\t\t\tlocal stat = nil -- (the server decays moods; 2017 converter)'],
  ]),
  // Its console handler got the whole request ({Type, Command}) and called
  // :lower() on it.
  edits('Bloxburg copy: console commands', [
    ['DataManager:HookFunction("RunCommand", function(player, command)',
      'DataManager:HookFunction("RunCommand", function(player, command) if type(command) == "table" then command = command.Command end if type(command) ~= "string" then return end'],
  ]),
  edits('Bloxburg copy: chat key', [
    ['local Chat = game.Players.LocalPlayer.PlayerGui.Chat.Frame',
      'do return end -- (2017\'s own chat handles its key; 2017 converter)\nlocal Chat = game.Players.LocalPlayer.PlayerGui.Chat.Frame'],
  ]),
  // The shop sends every previewed attachment slot, "" for one toggled off;
  // the server looked each up as attachments[Type][Name] and errored, so no
  // attachment purchase went through. Blank or unknown ones are skipped.
  edits('Phantom Forces attachment purchases', [
    ['if gundata.attachments[Type][Name].unlockkills then',
      'local own = gundata.attachments[Type] and gundata.attachments[Type][Name] if Name == "" or not (own or infodata[Name]) then elseif own and own.unlockkills then'],
    ['unlockkills = unlockkills + infodata[Name].unlockkills', 'unlockkills = unlockkills + (infodata[Name] and infodata[Name].unlockkills or 0)'],
  ]),
  DECOMPILED_MAGNITUDE,
];

// source -> source with the patches that fit applied; their names are added
// to `applied` (a Set).
function apply(source, applied) {
  let text = source;
  for (const patch of PATCHES) {
    if (!patch.applies(text)) continue;
    text = patch.fix(text);
    if (applied) applied.add(patch.name);
  }
  return text;
}

module.exports = { apply, PATCHES };
