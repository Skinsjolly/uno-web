-- bridge_body.lua: web sidecar runtime, appended after the BUNDLE defs by
-- gen_bundle.sh. Runs the UNO engine inside the luau-web WASM VM and exposes a
-- single RPC entry: __rpc.dispatch(jsonRequest) -> jsonResponse (JSON strings).
-- The engine's Roblox touches (game/workspace/require/remotes) are shimmed so
-- the game logic is byte-for-byte identical to the Roblox + headless builds.

-- --- Roblox-like environment ------------------------------------------------
local clockValue = 0
liveUsers = {} -- userId -> true; which users the engine may broadcast to

Color3 = {
	fromRGB = function(_, r, g, b) return { r = r, g = g, b = b } end,
	new = function() return {} end,
}
Random = {
	new = function()
		return {
			NextInteger = function(_, a, b) return math.random(a, b) end,
		}
	end,
}
if os and os.time then
	math.randomseed(os.time() % 2147483647)
end

local fakeWorkspace = {
	GetServerTimeNow = function()
		return clockValue
	end,
}
local fakePlayers = {
	GetPlayerByUserId = function(_, uid)
		if liveUsers[uid] then
			return { UserId = uid, Parent = true }
		end
		return nil
	end,
}
local fakeReplicatedStorage = { UNO = { Config = {}, CardDefs = {}, Rules = {} } }
game = {
	GetService = function(_, name)
		if name == "ReplicatedStorage" then
			return fakeReplicatedStorage
		elseif name == "Workspace" then
			return fakeWorkspace
		elseif name == "Players" then
			return fakePlayers
		end
		error("unexpected GetService: " .. tostring(name))
	end,
	Players = fakePlayers,
	Workspace = fakeWorkspace,
	ReplicatedStorage = fakeReplicatedStorage,
}
workspace = fakeWorkspace
script = { Parent = { CardDefs = fakeReplicatedStorage.UNO.CardDefs } }
Players = fakePlayers
ReplicatedStorage = fakeReplicatedStorage

-- --- module loading (needs a JS-backed global `loadstring`) ------------------
local mapping = {} -- instance table -> module
loaded = {}
require = function(m)
	if typeof(m) == "table" then
		if mapping[m] then
			return mapping[m]
		end
		error("unmapped instance passed to require: " .. tostring(m), 2)
	end
	error("bad require argument", 2)
end

local function loadModule(name)
	if loaded[name] then
		return loaded[name]
	end
	local fn = loadstring(BUNDLE[name], "=" .. name)
	if not fn then
		error("failed to load module " .. name)
	end
	local ok, mod = pcall(fn)
	if not ok then
		error("failed to init module " .. name .. ": " .. tostring(mod))
	end
	loaded[name] = mod
	return mod
end

local confMod = loadModule("Config")
local cardMod = loadModule("CardDefs")
mapping[fakeReplicatedStorage.UNO.Config] = confMod
mapping[fakeReplicatedStorage.UNO.CardDefs] = cardMod
local rulesMod = loadModule("Rules")
mapping[fakeReplicatedStorage.UNO.Rules] = rulesMod
local GameMod = loadModule("Game")
local Json = loadModule("Json")

-- --- RPC plumbing -----------------------------------------------------------
local sessions = {} -- gid -> Game instance
LUA__outbox = {} -- events gathered during the current request

local function withOutbox(var)
	LUA__outbox = var or {}
	return LUA__outbox
end

-- each handler: (sess, req) and may push into LUA__outbox
local handlers = {}

-- create: {"players":[{"userId":..,"name":..}], "capacity":..}
handlers.create = function(_sess, req)
	local roster = {}
	for _, p in ipairs(req.players) do
		table.insert(roster, { userId = p.userId, name = p.name })
		liveUsers[p.userId] = true
	end
	local remotes = {
		StateUpdate = {
			FireClient = function(_, plr, st)
				table.insert(LUA__outbox, { kind = "state", userId = plr.UserId, state = st })
			end,
		},
		Notice = {
			FireClient = function(_, plr, data)
				table.insert(LUA__outbox, { kind = "notice", userId = plr.UserId, notice = data })
			end,
		},
	}
	local g = GameMod.new(roster, remotes)
	g.capacity = req.capacity or 4
	return g
end

-- join: {"userId":.., "name":..}
handlers.join = function(sess, req)
	liveUsers[req.userId] = true
	sess:addLobbyPlayer(req.userId, req.name)
end

-- leave: {"userId":..}
handlers.leave = function(sess, req)
	liveUsers[req.userId] = nil
	sess:onPlayerLeave(req.userId)
end

-- action: {"userId":.., "action":{...}} -- mirrors the Roblox Action remote
handlers.action = function(sess, req)
	sess:handleAction({ UserId = req.userId, Name = "" }, req.action)
end

-- tick: {} -- heartbeat; the Node side supplies `t` in the request
handlers.tick = function(sess, _req)
	sess:tick()
end

-- sync: {"userId":..} -- full state push for a (re)connecting client
handlers.sync = function(sess, req)
	local st = sess:serializeFor(req.userId)
	if st then
		table.insert(LUA__outbox, { kind = "state", userId = req.userId, state = st })
	end
end

-- dispatch(jsonRequest) -> jsonResponse
-- request:  {"t":<clock>, "gid":<string>, "op":<string>, ...}
-- response: {"ok":bool, "gid":<string>, "events":[{"kind":"state|notice","userId":..,"state"?:..,"notice"?:..}]}
__rpc = {}
__rpc.dispatch = function(requestJson)
	local req = Json.decode(requestJson)
	if type(req.t) == "number" then
		clockValue = math.max(clockValue, req.t)
	end
	withOutbox({})
	local ok = true
	local err = nil
	local gid = req.gid
	local sess = sessions[gid]
	local created = false
	if req.op == "create" then
		local pres, res = pcall(handlers.create, nil, req)
		if pres then
			sess = res
			sessions[gid] = sess
		else
			ok = false
			err = tostring(res)
		end
	else
		if not sess then
			ok = false
			err = "unknown game: " .. tostring(gid)
		else
			local h = handlers[req.op]
			if not h then
				ok = false
				err = "unknown op: " .. tostring(req.op)
			else
				local pres, res = pcall(h, sess, req)
				if not pres then
					ok = false
					err = tostring(res)
				end
			end
		end
	end
	-- broadcast after any successful mutation so all connected users resync
	if ok and sess and req.op ~= "sync" then
		local pcfg = pcall(function()
			sess:broadcast()
		end)
		if not pcfg then
			ok = false
			err = "broadcast failed"
		end
	end
	local events = {}
	for _, ev in ipairs(LUA__outbox) do
		local encoded = {
			kind = ev.kind,
			userId = ev.userId,
			state = ev.kind == "state" and Json.encode(ev.state) or nil,
			notice = ev.kind == "notice" and Json.encode(ev.notice) or nil,
		}
		-- drop consecutive duplicates (the engine may broadcast internally AND
		-- the dispatcher re-broadcasts after every op)
		local last = events[#events]
		if last and last.kind == encoded.kind and last.userId == encoded.userId and last.state == encoded.state and last.notice == encoded.notice then
			-- skip
		else
			table.insert(events, encoded)
		end
	end
	return Json.encode({ ok = ok, gid = gid, events = events, error = err })
end

return __rpc