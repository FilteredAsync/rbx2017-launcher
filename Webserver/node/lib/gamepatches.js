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

function edits(name, pairs) {
  return {
    name,
    applies: (source) => pairs.every(([find, replace]) => count(source, find) === 1 && !source.includes(replace)),
    fix: (source) => pairs.reduce((text, [find, replace]) => text.replace(find, () => replace), source),
  };
}

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
