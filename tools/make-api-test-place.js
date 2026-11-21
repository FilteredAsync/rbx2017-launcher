'use strict';

// Builds the API test place: a 2017 place (.rbxlx) that checks, wherever it
// runs (the 2017 client, RCC on the server, Studio's Play Solo), which classes
// can be made, which members of the 2017 API dump answer, and which newer
// APIs that converted games use are there. Results show on screen, are kept
// as JSON in ReplicatedStorage.ApiTestResults (Server / Client StringValues),
// and are warn()ed in 900-character chunks ("APITEST|<where>|<n>|<of>|<json>") so Studio's
// log file has them too. tools/api-test-report.js compares runs.
//
//   node tools/make-api-test-place.js [Client/apidump.txt] [out.rbxlx]
//
// The API dump is the 2017 client's own (RobloxPlayerBeta.exe -API); it isn't
// in this repository. The place holds only these scripts and a baseplate.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dumpFile = process.argv[2] || path.join(ROOT, 'Client', 'apidump.txt');
const outFile = process.argv[3] || path.join(ROOT, 'share', 'api-test.rbxlx');

// --- the 2017 API dump -----------------------------------------------------------------------

const SECURED = /\[(?:RobloxScriptSecurity|LocalUserSecurity|PluginSecurity|RobloxSecurity|RobloxPlaceSecurity|NotAccessibleSecurity)\]/;
const classes = new Map(); // name -> { name, base, tags, props: [], funcs: [], events: [] }
let current = null;
for (const line of fs.readFileSync(dumpFile, 'utf8').split(/\r?\n/)) {
  const head = /^Class (\w+)(?: : (\w+))?(.*)$/.exec(line);
  if (head) {
    current = { name: head[1], base: head[2] || null, tags: head[3] || '', props: [], funcs: [], events: [] };
    classes.set(current.name, current);
    continue;
  }
  const member = /^\t(Property|Function|YieldFunction|Event|Callback) .*?\b(\w+)[.:](\w+)(?:\(|\s|$)(.*)$/.exec(line);
  if (!member || !current) continue;
  const [, kind, owner, name] = member;
  if (owner !== current.name || SECURED.test(line)) continue;
  if (kind === 'Property' && !/\[writeonly\]/.test(line)) current.props.push(name);
  else if (kind === 'Function' || kind === 'YieldFunction') current.funcs.push(name);
  else if (kind === 'Event') current.events.push(name);
}

// Where each class's members are tried: the class itself, else a subclass
// that can be made (members of BasePart are tried on a Part...).
const children = new Map();
for (const c of classes.values()) if (c.base) children.set(c.base, (children.get(c.base) || []).concat(c.name));
function hosts(name) {
  const out = [name];
  const queue = [...(children.get(name) || [])];
  while (queue.length && out.length < 6) {
    const next = queue.shift();
    const c = classes.get(next);
    if (c && !/notCreatable|deprecated/.test(c.tags)) out.push(next);
    queue.push(...(children.get(next) || []));
  }
  return out;
}

const lua = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const list = (items) => `{${items.map(lua).join(',')}}`;
const classData = [...classes.values()].map((c) => `{n=${lua(c.name)},c=${/notCreatable/.test(c.tags) ? 'false' : 'true'},h=${list(hosts(c.name))},p=${list(c.props)},f=${list(c.funcs)},e=${list(c.events)}}`).join(',\n');

// --- newer APIs that converted games use (hand-written checks) --------------------------------
// Each is { name, where: "both" | "server" | "client", body }: body is Lua that
// errors when the API is missing or broken.

const MODERN = [
  // Lua and globals
  ['Lua: typeof', 'both', 'assert(typeof(Vector3.new()) == "Vector3")'],
  ['Lua: task.wait', 'both', 'task.wait()'],
  ['Lua: task.spawn', 'both', 'task.spawn(function() end)'],
  ['Lua: task.defer', 'both', 'task.defer(function() end)'],
  ['Lua: task.delay', 'both', 'task.delay(0, function() end)'],
  ['Lua: wait/spawn/delay', 'both', 'spawn(function() end) delay(0, function() end)'],
  ['Lua: tick/time/os.clock', 'both', 'assert(tick() and time() and os.clock())'],
  ['Lua: os.date', 'both', 'assert(os.date("*t").year > 2000)'],
  ['Lua: utf8', 'both', 'assert(utf8.char(72) == "H")'],
  ['Lua: bit32', 'both', 'assert(bit32.band(3, 1) == 1)'],
  ['Lua: string.split', 'both', 'assert(#("a,b"):split(",") == 2)'],
  ['Lua: string.pack', 'both', 'string.pack("i4", 1)'],
  ['Lua: string.format %q', 'both', 'assert(string.format("%q", "a") == \'"a"\')'],
  ['Lua: table.find', 'both', 'assert(table.find({1, 2}, 2) == 2)'],
  ['Lua: table.clear', 'both', 'table.clear({1})'],
  ['Lua: table.create', 'both', 'assert(#table.create(3, 0) == 3)'],
  ['Lua: table.move', 'both', 'table.move({1}, 1, 1, 1, {})'],
  ['Lua: table.pack/unpack', 'both', 'assert(table.unpack(table.pack(1)) == 1)'],
  ['Lua: math.clamp', 'both', 'assert(math.clamp(5, 0, 1) == 1)'],
  ['Lua: math.sign', 'both', 'assert(math.sign(-2) == -1)'],
  ['Lua: math.round', 'both', 'assert(math.round(1.6) == 2)'],
  ['Lua: math.noise', 'both', 'math.noise(1, 2)'],
  ['Lua: math.log base', 'both', 'assert(math.abs(math.log(8, 2) - 3) < 1e-9)'],
  ['Lua: coroutine.isyieldable', 'both', 'coroutine.isyieldable()'],
  ['Lua: coroutine.close', 'both', 'coroutine.close(coroutine.create(function() end))'],
  ['Lua: debug.traceback', 'both', 'assert(debug.traceback())'],
  ['Lua: debug.info', 'both', 'debug.info(1, "s")'],
  ['Lua: debug.profilebegin', 'both', 'debug.profilebegin("x") debug.profileend()'],
  ['Lua: getfenv/setfenv', 'both', 'setfenv(function() end, getfenv())'],
  ['Lua: newproxy', 'both', 'newproxy(true)'],
  ['Lua: xpcall with args', 'both', 'local ok, v = xpcall(function(a) return a end, print, 5) assert(v == 5)'],
  ['Lua: string interpolation (Luau)', 'server', 'loadstring("return `x`")()'],
  ['Lua: compound assignment (Luau)', 'server', 'assert(loadstring("local a = 1 a += 1 return a")() == 2)'],
  ['Lua: continue (Luau)', 'server', 'assert(loadstring("for i = 1, 2 do continue end return true")())'],
  ['Lua: if-expression (Luau)', 'server', 'assert(loadstring("return if true then 1 else 2")() == 1)'],
  ['Lua: type annotations (Luau)', 'server', 'assert(loadstring("local a: number = 1 return a")() == 1)'],
  // Data types
  ['Type: RaycastParams', 'both', 'local p = RaycastParams.new() p.FilterDescendantsInstances = {} p.FilterType = Enum.RaycastFilterType.Exclude'],
  ['Type: OverlapParams', 'both', 'OverlapParams.new()'],
  ['Type: CFrame.lookAt', 'both', 'CFrame.lookAt(Vector3.new(), Vector3.new(0, 0, 1))'],
  ['Type: CFrame.new(pos, lookAt)', 'both', 'CFrame.new(Vector3.new(), Vector3.new(0, 0, 1))'],
  ['Type: CFrame.fromOrientation', 'both', 'CFrame.fromOrientation(0, 1, 0)'],
  ['Type: CFrame.fromEulerAnglesYXZ', 'both', 'CFrame.fromEulerAnglesYXZ(0, 1, 0)'],
  ['Type: CFrame.fromAxisAngle', 'both', 'CFrame.fromAxisAngle(Vector3.new(0, 1, 0), 1)'],
  ['Type: CFrame.fromMatrix', 'both', 'CFrame.fromMatrix(Vector3.new(), Vector3.new(1, 0, 0), Vector3.new(0, 1, 0))'],
  ['Type: CFrame.Position/Rotation', 'both', 'local c = CFrame.new(1, 2, 3) assert(c.Position.X == 1) local r = c.Rotation'],
  ['Type: CFrame.RightVector/UpVector', 'both', 'local c = CFrame.new() local a, b = c.RightVector, c.UpVector assert(a and b)'],
  ['Type: CFrame.XVector/YVector/ZVector', 'both', 'local c = CFrame.new() assert(c.XVector and c.YVector and c.ZVector)'],
  ['Type: CFrame:ToOrientation', 'both', 'CFrame.new():ToOrientation()'],
  ['Type: CFrame:Lerp', 'both', 'CFrame.new():Lerp(CFrame.new(1, 0, 0), 0.5)'],
  ['Type: CFrame.identity', 'both', 'assert(CFrame.identity)'],
  ['Type: Vector3 constants', 'both', 'assert(Vector3.zero and Vector3.one and Vector3.xAxis)'],
  ['Type: Vector3:Lerp', 'both', 'Vector3.new():Lerp(Vector3.new(1, 1, 1), 0.5)'],
  ['Type: Vector3:FuzzyEq', 'both', 'Vector3.new():FuzzyEq(Vector3.new())'],
  ['Type: Vector3:Max/Min', 'both', 'Vector3.new():Max(Vector3.new(1, 1, 1))'],
  ['Type: Vector3:Angle', 'both', 'Vector3.new(1, 0, 0):Angle(Vector3.new(0, 1, 0))'],
  ['Type: Vector3.FromNormalId', 'both', 'Vector3.FromNormalId(Enum.NormalId.Top)'],
  ['Type: Vector2.zero', 'both', 'assert(Vector2.zero)'],
  ['Type: Color3.fromRGB', 'both', 'Color3.fromRGB(255, 0, 0)'],
  ['Type: Color3.fromHSV', 'both', 'Color3.fromHSV(0, 1, 1)'],
  ['Type: Color3.fromHex', 'both', 'Color3.fromHex("#ff0000")'],
  ['Type: Color3:ToHSV', 'both', 'Color3.new(1, 0, 0):ToHSV()'],
  ['Type: Color3:ToHex', 'both', 'Color3.new(1, 0, 0):ToHex()'],
  ['Type: Color3:Lerp', 'both', 'Color3.new():Lerp(Color3.new(1, 1, 1), 0.5)'],
  ['Type: UDim2.fromScale/fromOffset', 'both', 'UDim2.fromScale(1, 1) UDim2.fromOffset(1, 1)'],
  ['Type: UDim2:Lerp', 'both', 'UDim2.new():Lerp(UDim2.new(1, 0, 1, 0), 0.5)'],
  ['Type: TweenInfo', 'both', 'TweenInfo.new(1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)'],
  ['Type: NumberSequence/ColorSequence', 'both', 'NumberSequence.new(0) ColorSequence.new(Color3.new())'],
  ['Type: NumberRange', 'both', 'NumberRange.new(1, 2)'],
  ['Type: Random', 'both', 'Random.new(1):NextNumber()'],
  ['Type: DateTime', 'both', 'DateTime.now()'],
  ['Type: Rect', 'both', 'Rect.new(0, 0, 1, 1)'],
  ['Type: PhysicalProperties', 'both', 'PhysicalProperties.new(Enum.Material.Plastic)'],
  ['Type: Region3:ExpandToGrid', 'both', 'Region3.new(Vector3.new(), Vector3.new(4, 4, 4)):ExpandToGrid(4)'],
  ['Type: Font', 'both', 'Font.new("rbxasset://fonts/families/SourceSansPro.json")'],
  ['Type: Enum:GetEnumItems', 'both', 'assert(#Enum.Material:GetEnumItems() > 0)'],
  ['Enum: Material.SmoothPlastic', 'both', 'local m = Enum.Material.SmoothPlastic'],
  ['Enum: Material.Glass', 'both', 'local m = Enum.Material.Glass'],
  ['Enum: Material.ForceField', 'both', 'local m = Enum.Material.ForceField'],
  ['Enum: Material.Neon', 'both', 'local m = Enum.Material.Neon'],
  ['Enum: Font.GothamBold', 'both', 'local f = Enum.Font.GothamBold'],
  ['Enum: Font.FredokaOne', 'both', 'local f = Enum.Font.FredokaOne'],
  ['Enum: Font.Gotham', 'both', 'local f = Enum.Font.Gotham'],
  ['Enum: KeyCode.ButtonL3', 'both', 'local k = Enum.KeyCode.ButtonL3'],
  ['Enum: RaycastFilterType.Exclude', 'both', 'local k = Enum.RaycastFilterType.Exclude'],
  ['Enum: AutomaticSize', 'both', 'local k = Enum.AutomaticSize.XY'],
  ['Enum: HumanoidRigType.R15', 'both', 'local k = Enum.HumanoidRigType.R15'],
  // Instance methods
  ['Instance:FindFirstChildWhichIsA', 'both', 'workspace:FindFirstChildWhichIsA("BasePart")'],
  ['Instance:FindFirstChildOfClass', 'both', 'workspace:FindFirstChildOfClass("Part")'],
  ['Instance:FindFirstAncestorWhichIsA', 'both', 'workspace:FindFirstAncestorWhichIsA("Instance")'],
  ['Instance:FindFirstAncestorOfClass', 'both', 'workspace:FindFirstAncestorOfClass("DataModel")'],
  ['Instance:FindFirstDescendant', 'both', 'workspace:FindFirstDescendant("Baseplate")'],
  ['Instance:FindFirstChild recursive', 'both', 'assert(game:FindFirstChild("Baseplate", true))'],
  ['Instance:GetDescendants', 'both', 'assert(#workspace:GetDescendants() > 0)'],
  ['Instance:IsDescendantOf', 'both', 'assert(workspace:IsDescendantOf(game))'],
  ['Instance:GetPropertyChangedSignal', 'both', 'Instance.new("Part"):GetPropertyChangedSignal("Size"):Connect(function() end)'],
  ['Instance:GetAttribute/SetAttribute', 'both', 'local f = Instance.new("Folder") f:SetAttribute("a", 1) assert(f:GetAttribute("a") == 1)'],
  ['Instance:GetAttributes', 'both', 'Instance.new("Folder"):GetAttributes()'],
  ['Instance:GetAttributeChangedSignal', 'both', 'Instance.new("Folder"):GetAttributeChangedSignal("a"):Connect(function() end)'],
  ['Instance:AddTag/HasTag', 'both', 'local f = Instance.new("Folder") f:AddTag("x") assert(f:HasTag("x"))'],
  ['Instance.Destroying', 'both', 'Instance.new("Folder").Destroying:Connect(function() end)'],
  ['Instance:WaitForChild timeout', 'both', 'workspace:WaitForChild("Nothing here", 0.01)'],
  ['Instance:ClearAllChildren', 'both', 'Instance.new("Folder"):ClearAllChildren()'],
  ['RBXScriptSignal:Once', 'both', 'Instance.new("BindableEvent").Event:Once(function() end)'],
  ['RBXScriptSignal:Wait', 'both', 'local b = Instance.new("BindableEvent") delay(0, function() b:Fire() end) b.Event:Wait()'],
  ['RBXScriptConnection.Connected', 'both', 'local c = Instance.new("BindableEvent").Event:Connect(function() end) assert(c.Connected == true)'],
  ['Model:GetPivot/PivotTo', 'both', 'local m = Instance.new("Model") m:PivotTo(m:GetPivot())'],
  ['Model:GetBoundingBox', 'both', 'Instance.new("Model"):GetBoundingBox()'],
  ['Model:GetExtentsSize', 'both', 'Instance.new("Model"):GetExtentsSize()'],
  ['Model:SetPrimaryPartCFrame', 'both', 'local m = Instance.new("Model") local p = Instance.new("Part", m) m.PrimaryPart = p m:SetPrimaryPartCFrame(CFrame.new())'],
  ['Model:ScaleTo', 'both', 'local m = Instance.new("Model") Instance.new("Part", m) m:ScaleTo(1)'],
  ['BasePart:GetConnectedParts', 'both', 'Instance.new("Part"):GetConnectedParts()'],
  ['BasePart:GetTouchingParts', 'both', 'Instance.new("Part"):GetTouchingParts()'],
  ['BasePart:ApplyImpulse', 'both', 'Instance.new("Part"):ApplyImpulse(Vector3.new())'],
  ['BasePart:GetMass', 'both', 'Instance.new("Part"):GetMass()'],
  ['BasePart:SetNetworkOwner', 'server', 'local p = Instance.new("Part", workspace) p:SetNetworkOwner(nil) p:Destroy()'],
  ['BasePart:CanCollideWith', 'both', 'local p = Instance.new("Part") p:CanCollideWith(Instance.new("Part"))'],
  ['BasePart.AssemblyLinearVelocity', 'both', 'Instance.new("Part").AssemblyLinearVelocity = Vector3.new()'],
  ['BasePart.CollisionGroup', 'both', 'Instance.new("Part").CollisionGroup = "Default"'],
  ['BasePart.CollisionGroupId', 'both', 'local x = Instance.new("Part").CollisionGroupId'],
  ['BasePart.CanTouch/CanQuery', 'both', 'local p = Instance.new("Part") p.CanTouch = true p.CanQuery = true'],
  ['BasePart.Massless', 'both', 'Instance.new("Part").Massless = true'],
  ['BasePart.PivotOffset', 'both', 'local x = Instance.new("Part").PivotOffset'],
  ['BasePart.CastShadow', 'both', 'Instance.new("Part").CastShadow = false'],
  ['BasePart.Orientation', 'both', 'local x = Instance.new("Part").Orientation'],
  ['MeshPart creatable', 'both', 'Instance.new("MeshPart")'],
  ['MeshPart.MeshId read', 'both', 'local x = Instance.new("MeshPart").MeshId'],
  ['UnionOperation creatable', 'both', 'Instance.new("UnionOperation")'],
  ['Attachment.WorldPosition/WorldCFrame', 'both', 'local a = Instance.new("Attachment") local x, y = a.WorldPosition, a.WorldCFrame'],
  // Services
  ['TweenService:Create + Play', 'both', 'local p = Instance.new("Part") local t = game:GetService("TweenService"):Create(p, TweenInfo.new(0.05), {Transparency = 1}) t:Play()'],
  ['TweenService:GetValue', 'both', 'game:GetService("TweenService"):GetValue(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)'],
  ['CollectionService tags', 'both', 'local cs = game:GetService("CollectionService") local f = Instance.new("Folder") cs:AddTag(f, "x") assert(cs:HasTag(f, "x")) cs:GetTagged("x") cs:GetInstanceAddedSignal("x")'],
  ['RunService:IsServer/IsClient/IsStudio', 'both', 'local r = game:GetService("RunService") r:IsServer() r:IsClient() r:IsStudio()'],
  ['RunService.Heartbeat/Stepped', 'both', 'local r = game:GetService("RunService") r.Heartbeat:Connect(function() end):Disconnect() r.Stepped:Connect(function() end):Disconnect()'],
  ['RunService.PreSimulation/PostSimulation', 'both', 'local r = game:GetService("RunService") r.PostSimulation:Connect(function() end):Disconnect()'],
  ['RunService:BindToRenderStep', 'client', 'local r = game:GetService("RunService") r:BindToRenderStep("apitest", 1, function() end) r:UnbindFromRenderStep("apitest")'],
  ['RunService.RenderStepped', 'client', 'game:GetService("RunService").RenderStepped:Connect(function() end):Disconnect()'],
  ['HttpService JSON + GUID', 'both', 'local h = game:GetService("HttpService") assert(h:JSONDecode(h:JSONEncode({a = 1})).a == 1) h:GenerateGUID(false)'],
  ['HttpService:UrlEncode', 'both', 'game:GetService("HttpService"):UrlEncode("a b")'],
  ['TextService:GetTextSize', 'both', 'game:GetService("TextService"):GetTextSize("hi", 14, Enum.Font.SourceSans, Vector2.new(100, 100))'],
  ['PhysicsService:CreateCollisionGroup', 'server', 'local ps = game:GetService("PhysicsService") pcall(function() ps:CreateCollisionGroup("ApiTest") end) ps:CollisionGroupSetCollidable("ApiTest", "Default", false)'],
  ['PhysicsService:RegisterCollisionGroup', 'server', 'game:GetService("PhysicsService"):RegisterCollisionGroup("ApiTest2")'],
  ['PathfindingService:CreatePath', 'server', 'game:GetService("PathfindingService"):CreatePath({AgentRadius = 2})'],
  ['Debris:AddItem', 'both', 'game:GetService("Debris"):AddItem(Instance.new("Folder"), 0)'],
  ['DataStoreService:GetDataStore', 'server', 'game:GetService("DataStoreService"):GetDataStore("ApiTest")'],
  ['DataStoreService:GetOrderedDataStore', 'server', 'game:GetService("DataStoreService"):GetOrderedDataStore("ApiTest")'],
  ['MessagingService', 'server', 'game:GetService("MessagingService")'],
  ['MemoryStoreService', 'server', 'game:GetService("MemoryStoreService")'],
  ['TeleportService:GetLocalPlayerTeleportData', 'client', 'game:GetService("TeleportService"):GetLocalPlayerTeleportData()'],
  ['MarketplaceService:GetProductInfo', 'server', 'game:GetService("MarketplaceService"):GetProductInfo(1818)'],
  ['MarketplaceService:UserOwnsGamePassAsync', 'server', 'local m = game:GetService("MarketplaceService") assert(m.UserOwnsGamePassAsync)'],
  ['BadgeService:UserHasBadgeAsync', 'server', 'local b = game:GetService("BadgeService") assert(b.UserHasBadgeAsync)'],
  ['Chat:FilterStringForBroadcast', 'server', 'local c = game:GetService("Chat") assert(c.FilterStringForBroadcast)'],
  ['TextChatService', 'both', 'game:GetService("TextChatService")'],
  ['ProximityPromptService', 'both', 'game:GetService("ProximityPromptService")'],
  ['LocalizationService', 'both', 'game:GetService("LocalizationService")'],
  ['PolicyService', 'both', 'game:GetService("PolicyService")'],
  ['SocialService', 'both', 'game:GetService("SocialService")'],
  ['AvatarEditorService', 'both', 'game:GetService("AvatarEditorService")'],
  ['GroupService:GetGroupInfoAsync', 'server', 'local g = game:GetService("GroupService") assert(g.GetGroupInfoAsync)'],
  ['Players:GetPlayerByUserId', 'both', 'game:GetService("Players"):GetPlayerByUserId(1)'],
  ['Players:GetUserThumbnailAsync', 'both', 'assert(game:GetService("Players").GetUserThumbnailAsync)'],
  ['Players:CreateHumanoidModelFromDescription', 'server', 'assert(game:GetService("Players").CreateHumanoidModelFromDescription)'],
  ['Players.LocalPlayer', 'client', 'assert(game:GetService("Players").LocalPlayer)'],
  ['Player.Team', 'client', 'local x = game:GetService("Players").LocalPlayer.Team'],
  ['Player.DisplayName', 'client', 'local x = game:GetService("Players").LocalPlayer.DisplayName'],
  ['Player.MembershipType', 'client', 'local x = game:GetService("Players").LocalPlayer.MembershipType'],
  ['Player:GetMouse', 'client', 'game:GetService("Players").LocalPlayer:GetMouse()'],
  ['Teams:GetTeams', 'both', 'game:GetService("Teams"):GetTeams()'],
  ['Lighting.ClockTime', 'both', 'local l = game:GetService("Lighting") l.ClockTime = l.ClockTime'],
  ['Lighting:GetMinutesAfterMidnight', 'both', 'game:GetService("Lighting"):GetMinutesAfterMidnight()'],
  ['Lighting.Technology', 'both', 'local x = game:GetService("Lighting").Technology'],
  ['Workspace.FilteringEnabled', 'both', 'local x = workspace.FilteringEnabled'],
  ['Workspace.StreamingEnabled', 'both', 'local x = workspace.StreamingEnabled'],
  ['Workspace:Raycast', 'both', 'workspace:Raycast(Vector3.new(0, 50, 0), Vector3.new(0, -100, 0))'],
  ['Workspace:FindPartOnRayWithIgnoreList', 'both', 'workspace:FindPartOnRayWithIgnoreList(Ray.new(Vector3.new(0, 50, 0), Vector3.new(0, -100, 0)), {})'],
  ['Workspace:FindPartOnRayWithWhitelist', 'both', 'workspace:FindPartOnRayWithWhitelist(Ray.new(Vector3.new(0, 50, 0), Vector3.new(0, -100, 0)), {workspace})'],
  ['Workspace:FindPartsInRegion3WithWhiteList', 'both', 'workspace:FindPartsInRegion3WithWhiteList(Region3.new(Vector3.new(-4, -4, -4), Vector3.new(4, 4, 4)), {workspace})'],
  ['Workspace:GetPartBoundsInBox', 'both', 'workspace:GetPartBoundsInBox(CFrame.new(), Vector3.new(4, 4, 4))'],
  ['Workspace:GetPartsInPart', 'both', 'workspace:GetPartsInPart(Instance.new("Part"))'],
  ['Workspace:Blockcast/Spherecast', 'both', 'workspace:Spherecast(Vector3.new(0, 50, 0), 1, Vector3.new(0, -100, 0))'],
  ['Workspace:BulkMoveTo', 'both', 'workspace:BulkMoveTo({}, {})'],
  ['Workspace:GetServerTimeNow', 'both', 'workspace:GetServerTimeNow()'],
  ['Workspace:ArePartsTouchingOthers', 'both', 'workspace:ArePartsTouchingOthers({})'],
  ['Workspace.CurrentCamera', 'client', 'assert(workspace.CurrentCamera)'],
  ['Camera:WorldToViewportPoint', 'client', 'workspace.CurrentCamera:WorldToViewportPoint(Vector3.new())'],
  ['Camera:ViewportPointToRay', 'client', 'workspace.CurrentCamera:ViewportPointToRay(0, 0)'],
  ['Camera.ViewportSize', 'client', 'local x = workspace.CurrentCamera.ViewportSize'],
  ['UserInputService:GetMouseLocation', 'client', 'game:GetService("UserInputService"):GetMouseLocation()'],
  ['UserInputService:GetMouseDelta', 'client', 'game:GetService("UserInputService"):GetMouseDelta()'],
  ['UserInputService.MouseBehavior', 'client', 'local u = game:GetService("UserInputService") u.MouseBehavior = u.MouseBehavior'],
  ['UserInputService:IsKeyDown', 'client', 'game:GetService("UserInputService"):IsKeyDown(Enum.KeyCode.W)'],
  ['UserInputService.TouchEnabled', 'client', 'local x = game:GetService("UserInputService").TouchEnabled'],
  ['UserInputService:GetGamepadConnected', 'client', 'game:GetService("UserInputService"):GetGamepadConnected(Enum.UserInputType.Gamepad1)'],
  ['ContextActionService:BindActionAtPriority', 'client', 'local c = game:GetService("ContextActionService") c:BindActionAtPriority("apitest", function() end, false, 2000, Enum.KeyCode.F13) c:UnbindAction("apitest")'],
  ['ContextActionService:BindAction', 'client', 'local c = game:GetService("ContextActionService") c:BindAction("apitest2", function() end, false, Enum.KeyCode.F13) c:UnbindAction("apitest2")'],
  ['GuiService:GetGuiInset', 'client', 'game:GetService("GuiService"):GetGuiInset()'],
  ['StarterGui:SetCoreGuiEnabled', 'client', 'game:GetService("StarterGui"):SetCoreGuiEnabled(Enum.CoreGuiType.Backpack, true)'],
  ['StarterGui:SetCore', 'client', 'game:GetService("StarterGui"):SetCore("ResetButtonCallback", true)'],
  ['ReplicatedFirst:RemoveDefaultLoadingScreen', 'client', 'game:GetService("ReplicatedFirst"):RemoveDefaultLoadingScreen()'],
  ['SoundService:PlayLocalSound', 'client', 'assert(game:GetService("SoundService").PlayLocalSound)'],
  ['VRService', 'both', 'game:GetService("VRService")'],
  ['HapticService', 'both', 'game:GetService("HapticService")'],
  // Humanoids and characters
  ['Humanoid:BuildRigFromAttachments', 'both', 'Instance.new("Humanoid"):BuildRigFromAttachments()'],
  ['Humanoid:GetAppliedDescription', 'both', 'assert(Instance.new("Humanoid").GetAppliedDescription)'],
  ['Humanoid:ApplyDescription', 'both', 'assert(Instance.new("Humanoid").ApplyDescription)'],
  ['Humanoid.UseJumpPower/JumpHeight', 'both', 'local h = Instance.new("Humanoid") h.UseJumpPower = true h.JumpHeight = 7'],
  ['Humanoid.BreakJointsOnDeath', 'both', 'Instance.new("Humanoid").BreakJointsOnDeath = false'],
  ['Humanoid.EvaluateStateMachine', 'both', 'local x = Instance.new("Humanoid").EvaluateStateMachine'],
  ['Humanoid:GetState/ChangeState', 'both', 'local h = Instance.new("Humanoid") h:ChangeState(h:GetState())'],
  ['Humanoid:LoadAnimation', 'both', 'local h = Instance.new("Humanoid") local a = Instance.new("Animation") a.AnimationId = "rbxassetid://1" assert(h.LoadAnimation)'],
  ['Animator:LoadAnimation', 'both', 'assert(Instance.new("Animator").LoadAnimation)'],
  ['AnimationTrack.Looped', 'both', 'local c = Instance.new("AnimationController") local t = c:LoadAnimation(Instance.new("Animation")) t.Looped = true'],
  ['HumanoidDescription creatable', 'both', 'Instance.new("HumanoidDescription")'],
  // GUI
  ['GuiObject.AutomaticSize', 'both', 'Instance.new("Frame").AutomaticSize = Enum.AutomaticSize.XY'],
  ['TextLabel.RichText', 'both', 'Instance.new("TextLabel").RichText = true'],
  ['TextLabel.FontFace', 'both', 'local x = Instance.new("TextLabel").FontFace'],
  ['TextLabel.MaxVisibleGraphemes', 'both', 'Instance.new("TextLabel").MaxVisibleGraphemes = -1'],
  ['TextLabel.TextScaled', 'both', 'Instance.new("TextLabel").TextScaled = true'],
  ['ScreenGui.IgnoreGuiInset', 'both', 'Instance.new("ScreenGui").IgnoreGuiInset = true'],
  ['ScreenGui.ZIndexBehavior', 'both', 'Instance.new("ScreenGui").ZIndexBehavior = Enum.ZIndexBehavior.Sibling'],
  ['ScreenGui.ResetOnSpawn', 'both', 'Instance.new("ScreenGui").ResetOnSpawn = false'],
  ['ScreenGui.DisplayOrder', 'both', 'Instance.new("ScreenGui").DisplayOrder = 2'],
  ['ImageLabel.ScaleType Slice', 'both', 'Instance.new("ImageLabel").ScaleType = Enum.ScaleType.Slice'],
  ['ImageLabel.ImageRectOffset', 'both', 'Instance.new("ImageLabel").ImageRectOffset = Vector2.new()'],
  ['GuiObject:TweenPosition', 'both', 'Instance.new("Frame"):TweenPosition(UDim2.new(), "Out", "Quad", 0.01, true)'],
  ['ScrollingFrame.AutomaticCanvasSize', 'both', 'Instance.new("ScrollingFrame").AutomaticCanvasSize = Enum.AutomaticSize.Y'],
  ['ScrollingFrame.CanvasPosition', 'both', 'local x = Instance.new("ScrollingFrame").CanvasPosition'],
  ['TextBox.ClearTextOnFocus', 'both', 'Instance.new("TextBox").ClearTextOnFocus = false'],
  ['BillboardGui.MaxDistance', 'both', 'Instance.new("BillboardGui").MaxDistance = 50'],
  ['SurfaceGui.PixelsPerStud', 'both', 'Instance.new("SurfaceGui").PixelsPerStud = 50'],
  // Sound and effects
  ['Sound.PlaybackSpeed', 'both', 'Instance.new("Sound").PlaybackSpeed = 1'],
  ['Sound.RollOffMode', 'both', 'Instance.new("Sound").RollOffMode = Enum.RollOffMode.Inverse'],
  ['Sound.TimePosition', 'both', 'local x = Instance.new("Sound").TimePosition'],
  ['ParticleEmitter.SpreadAngle', 'both', 'Instance.new("ParticleEmitter").SpreadAngle = Vector2.new(5, 5)'],
  ['ParticleEmitter:Emit', 'both', 'Instance.new("ParticleEmitter"):Emit(1)'],
  ['Beam.FaceCamera', 'both', 'Instance.new("Beam").FaceCamera = true'],
  ['Tool.ToolTip/CanBeDropped', 'both', 'local t = Instance.new("Tool") t.ToolTip = "x" t.CanBeDropped = false'],
]
// Newer classes: Instance.new each.
const NEW_CLASSES = [
  'UICorner', 'UIStroke', 'UIGradient', 'UIAspectRatioConstraint', 'UISizeConstraint', 'UITextSizeConstraint', 'UIPadding',
  'UIScale', 'UIListLayout', 'UIGridLayout', 'UIPageLayout', 'UITableLayout', 'UIFlexItem', 'ViewportFrame', 'WorldModel', 'CanvasGroup',
  'ProximityPrompt', 'Beam', 'Trail', 'WeldConstraint', 'NoCollisionConstraint', 'AlignPosition', 'AlignOrientation', 'LinearVelocity',
  'AngularVelocity', 'VectorForce', 'Torque', 'RopeConstraint', 'SpringConstraint', 'HingeConstraint', 'BallSocketConstraint',
  'PrismaticConstraint', 'CylindricalConstraint', 'RodConstraint', 'Highlight', 'SurfaceAppearance', 'Atmosphere', 'Clouds',
  'BloomEffect', 'BlurEffect', 'ColorCorrectionEffect', 'SunRaysEffect', 'DepthOfFieldEffect', 'EqualizerSoundEffect',
  'ReverbSoundEffect', 'SoundGroup', 'VideoFrame', 'Animator', 'HumanoidDescription', 'RemoteFunction', 'BindableFunction',
  'UnreliableRemoteEvent', 'Configuration', 'Folder', 'TextChannel', 'Bone', 'WrapLayer', 'WrapTarget', 'PathfindingModifier',
  'PathfindingLink', 'DragDetector', 'AudioPlayer', 'Wire', 'Actor', 'IntConstrainedValue', 'DoubleConstrainedValue',
];

const modernLua = MODERN.map(([name, where, body]) => `{n=${lua(name)},w=${lua(where)},f=function() ${body} end}`).join(',\n');
// A check that doesn't even compile in 2017 Lua is kept as a string and loaded at run time.
const MODULE = `-- ApiTest: runs the checks where it is required (made by tools/make-api-test-place.js).
local M = {}
local CLASSES = {
${classData}
}
local NEW_CLASSES = ${list(NEW_CLASSES)}
local function modern() return {
${modernLua}
} end

local function short(err)
  local s = tostring(err)
  s = s:gsub("^.-:%d+: ", "")
  return s:sub(1, 140)
end
local function try(fn)
  local ok, res = pcall(fn)
  if ok then return true end
  return short(res)
end

function M.run(where, progress)
  local results = {classes = {}, properties = {}, functions = {}, events = {}, newClasses = {}, modern = {}}
  local counted = 0
  local function tick()
    counted = counted + 1
    if counted % 40 == 0 then
      if progress then progress(counted) end
      wait()
    end
  end
  for _, class in ipairs(CLASSES) do
    local inst, owned = nil, false
    local service = nil
    pcall(function() service = game:FindService(class.n) end)
    if service then
      inst = service
      results.classes[class.n] = "service"
    else
      for i, host in ipairs(class.h) do
        local ok, obj = pcall(function() return Instance.new(host) end)
        if ok and obj then
          inst = obj
          owned = true
          if i == 1 then results.classes[class.n] = true else results.classes[class.n] = "via " .. host end
          break
        elseif i == 1 then
          results.classes[class.n] = class.c and short(obj) or "notCreatable"
        end
      end
    end
    if inst then
      for _, p in ipairs(class.p) do results.properties[class.n .. "." .. p] = try(function() local v = inst[p] end) end
      for _, f in ipairs(class.f) do results.functions[class.n .. ":" .. f] = try(function() local v = inst[f] if type(v) ~= "function" then error("not a function") end end) end
      for _, e in ipairs(class.e) do results.events[class.n .. "." .. e] = try(function() local v = inst[e] if v == nil then error("nil") end end) end
      if owned then pcall(function() inst:Destroy() end) end
    end
    tick()
  end
  for _, name in ipairs(NEW_CLASSES) do
    results.newClasses[name] = try(function() Instance.new(name):Destroy() end)
    tick()
  end
  local ok, list = pcall(modern)
  if not ok then
    results.modern["(the checks did not compile)"] = short(list)
  else
    for _, check in ipairs(list) do
      if check.w == "both" or check.w == where then
        results.modern[check.n] = try(check.f)
      end
      tick()
    end
  end
  return results
end

-- Counts by kind: { [kind] = { ok = n, failed = n } }
function M.summary(results)
  local out = {}
  for kind, entries in pairs(results) do
    local ok, failed = 0, 0
    for _, value in pairs(entries) do
      if value == true or value == "service" or (type(value) == "string" and value:sub(1, 4) == "via ") then ok = ok + 1 else failed = failed + 1 end
    end
    out[kind] = {ok = ok, failed = failed}
  end
  return out
end

return M
`;

// Each piece of Lua above must parse in 2017's Lua 5.1, except the Luau
// checks, which go through loadstring on purpose.

const SERVER = `-- Runs the API checks on the server, then keeps the client's results too.
local HttpService = game:GetService("HttpService")
local RS = game:GetService("ReplicatedStorage")
local folder = RS:WaitForChild("ApiTestResults")
local api = require(RS:WaitForChild("ApiTest"))

local function where()
  local rs = game:GetService("RunService")
  local ok, studio = pcall(function() return rs:IsStudio() end)
  local place = (ok and studio) and "studio" or "rcc"
  return place .. "-server"
end

-- Studio's log keeps about 1000 characters of a line.
local function publish(label, json)
  local size = 900
  local count = math.ceil(#json / size)
  for i = 1, count do
    warn("APITEST|" .. label .. "|" .. i .. "|" .. count .. "|" .. json:sub((i - 1) * size + 1, i * size))
  end
end

local label = where()
local started = tick()
local results = api.run("server")
local json = HttpService:JSONEncode({where = label, version = version(), seconds = tick() - started, results = results})
folder.Server.Value = json
publish(label, json)
warn("APITEST|" .. label .. "|done|" .. #json)

-- The client's results arrive in pieces: { index, count, text }.
local parts = {}
folder.Report.OnServerEvent:Connect(function(player, index, count, text)
  if type(index) ~= "number" or type(count) ~= "number" or type(text) ~= "string" then return end
  parts[index] = text
  for i = 1, count do if not parts[i] then return end end
  local whole = table.concat(parts, "", 1, count)
  parts = {}
  folder.Client.Value = whole
  local ok, data = pcall(function() return HttpService:JSONDecode(whole) end)
  publish(ok and data.where or "client", whole)
end)
`;

const CLIENT = `-- Runs the API checks on this client, shows a summary and sends the results to the server.
local HttpService = game:GetService("HttpService")
local RS = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")
local folder = RS:WaitForChild("ApiTestResults")
local api = require(RS:WaitForChild("ApiTest"))
local player = Players.LocalPlayer

local gui = Instance.new("ScreenGui")
gui.Name = "ApiTest"
gui.ResetOnSpawn = false
local box = Instance.new("TextLabel")
box.Size = UDim2.new(0, 520, 1, -80)
box.Position = UDim2.new(0, 10, 0, 40)
box.BackgroundColor3 = Color3.new(0, 0, 0)
box.BackgroundTransparency = 0.25
box.TextColor3 = Color3.new(1, 1, 1)
box.Font = Enum.Font.SourceSans
box.FontSize = Enum.FontSize.Size14
box.TextXAlignment = Enum.TextXAlignment.Left
box.TextYAlignment = Enum.TextYAlignment.Top
box.TextWrapped = true
box.Text = "API test: running..."
box.Parent = gui
gui.Parent = player:WaitForChild("PlayerGui")

local rs = game:GetService("RunService")
local ok, studio = pcall(function() return rs:IsStudio() end)
local label = ((ok and studio) and "studio" or "client") .. "-client"
local started = tick()
local results = api.run("client", function(n) box.Text = "API test: " .. n .. " checks..." end)
local seconds = tick() - started

local function lines(title, sum)
  local out = {title}
  for kind, c in pairs(sum) do table.insert(out, string.format("  %-12s %5d ok   %4d failed", kind, c.ok, c.failed)) end
  return table.concat(out, "\\n")
end
local failures = {}
for _, name in ipairs({"modern", "newClasses"}) do
  for key, value in pairs(results[name]) do
    if value ~= true then table.insert(failures, key .. ": " .. tostring(value)) end
  end
end
table.sort(failures)
local text = lines(label .. string.format(" (%.1f s)", seconds), api.summary(results))
local serverJson = folder.Server.Value
if serverJson ~= "" then
  local okDecode, data = pcall(function() return HttpService:JSONDecode(serverJson) end)
  if okDecode then text = text .. "\\n\\n" .. lines(data.where, api.summary(data.results)) end
end
text = text .. "\\n\\nNewer APIs missing here (" .. #failures .. "):\\n" .. table.concat(failures, "\\n", 1, math.min(#failures, 60))
box.Text = text

local json = HttpService:JSONEncode({where = label, version = version(), seconds = seconds, results = results})
local size = 20000
local count = math.ceil(#json / size)
for i = 1, count do
  folder.Report:FireServer(i, count, json:sub((i - 1) * size + 1, i * size))
end
`;

// --- the place file ----------------------------------------------------------------------------

let ref = 0;
const id = () => `RBX${(++ref).toString(16).toUpperCase().padStart(8, '0')}`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cdata = (s) => `<![CDATA[${String(s).split(']]>').join(']]]]><![CDATA[>')}]]>`;
const str = (name, value) => `<string name="${name}">${xml(value)}</string>`;
const script = (cls, name, source) => `<Item class="${cls}" referent="${id()}"><Properties>${str('Name', name)}<bool name="Disabled">false</bool><ProtectedString name="Source">${cdata(source)}</ProtectedString></Properties></Item>`;
const cf = (x, y, z) => `<X>${x}</X><Y>${y}</Y><Z>${z}</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22>`;
const part = (cls, name, y, size, color) => `<Item class="${cls}" referent="${id()}"><Properties>${str('Name', name)}<bool name="Anchored">true</bool>`
  + `<CoordinateFrame name="CFrame">${cf(0, y, 0)}</CoordinateFrame><Vector3 name="size"><X>${size[0]}</X><Y>${size[1]}</Y><Z>${size[2]}</Z></Vector3>`
  + `<int name="BrickColor">${color}</int></Properties></Item>`;
const service = (cls, inner = '', props = '') => `<Item class="${cls}" referent="${id()}"><Properties>${str('Name', cls)}${props}</Properties>${inner}</Item>`;

const place = `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
<External>null</External><External>nil</External>
${service('Workspace', part('Part', 'Baseplate', -10, [512, 20, 512], 194) + part('SpawnLocation', 'SpawnLocation', 0.5, [12, 1, 12], 194))}
${service('Lighting')}
${service('ReplicatedStorage', `<Item class="ModuleScript" referent="${id()}"><Properties>${str('Name', 'ApiTest')}<ProtectedString name="Source">${cdata(MODULE)}</ProtectedString></Properties></Item>`
  + `<Item class="Folder" referent="${id()}"><Properties>${str('Name', 'ApiTestResults')}</Properties>`
  + `<Item class="StringValue" referent="${id()}"><Properties>${str('Name', 'Server')}${str('Value', '')}</Properties></Item>`
  + `<Item class="StringValue" referent="${id()}"><Properties>${str('Name', 'Client')}${str('Value', '')}</Properties></Item>`
  + `<Item class="RemoteEvent" referent="${id()}"><Properties>${str('Name', 'Report')}</Properties></Item></Item>`)}
${service('ServerScriptService', script('Script', 'ApiTestServer', SERVER), '<bool name="LoadStringEnabled">true</bool>')}
${service('StarterPlayer', `<Item class="StarterPlayerScripts" referent="${id()}"><Properties>${str('Name', 'StarterPlayerScripts')}</Properties>${script('LocalScript', 'ApiTestClient', CLIENT)}</Item>`)}
${service('StarterGui')}
</roblox>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, place);
const counts = [...classes.values()].reduce((n, c) => ({ props: n.props + c.props.length, funcs: n.funcs + c.funcs.length, events: n.events + c.events.length }), { props: 0, funcs: 0, events: 0 });
console.log(`${outFile}: ${classes.size} classes, ${counts.props} properties, ${counts.funcs} functions, ${counts.events} events, ${NEW_CLASSES.length} newer classes, ${MODERN.length} newer API checks (${(place.length / 1024).toFixed(0)} KB)`);
