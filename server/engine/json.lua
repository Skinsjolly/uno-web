-- Minimal JSON encode/decode for the web engine sidecar (luau CLI has no JSON).
-- Handles the primitives/tables used by the UNO engine: numbers, strings,
-- booleans, nil, and nested tables (arrays + objects). Not for hostile input.

local Json = {}

local ESCAPES = {
	['"'] = '\\"',
	["\\"] = "\\\\",
	["\b"] = "\\b",
	["\f"] = "\\f",
	["\n"] = "\\n",
	["\r"] = "\\r",
	["\t"] = "\\t",
}

local function encodeString(s)
	local out = { '"' }
	for i = 1, #s do
		local c = s:sub(i, i)
		if ESCAPES[c] then
			out[#out + 1] = ESCAPES[c]
		else
			local b = s:byte(i)
			if b < 32 then
				out[#out + 1] = string.format("\\u%04x", b)
			else
				out[#out + 1] = c
			end
		end
	end
	out[#out + 1] = '"'
	return table.concat(out)
end

local function isArray(t)
	local n = #t
	for k in pairs(t) do
		if type(k) ~= "number" or k < 1 or k > n or k ~= math.floor(k) then
			return false
		end
	end
	return true
end

function Json.encode(v)
	local t = type(v)
	if t == "nil" then
		return "null"
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then
			return "null"
		end
		if v == math.floor(v) and math.abs(v) < 1e15 then
			return string.format("%d", v)
		end
		return string.format("%.12g", v)
	elseif t == "boolean" then
		return tostring(v)
	elseif t == "string" then
		return encodeString(v)
	elseif t == "table" then
		local parts = {}
		if isArray(v) then
			for i = 1, #v do
				parts[#parts + 1] = Json.encode(v[i])
			end
			return "[" .. table.concat(parts, ",") .. "]"
		else
			for k, val in pairs(v) do
				if type(k) == "string" then
					parts[#parts + 1] = encodeString(k) .. ":" .. Json.encode(val)
				end
			end
			table.sort(parts)
			return "{" .. table.concat(parts, ",") .. "}"
		end
	end
	error("cannot json-encode type " .. t, 2)
end

-- --- decoder ----------------------------------------------------------------

local function decodeValue(s, i)
	while i <= #s and s:sub(i, i):find("%s") do
		i += 1
	end
	local c = s:sub(i, i)
	if c == "{" then
		local obj = {}
		i += 1
		while true do
			while i <= #s and s:sub(i, i):find("%s") do
				i += 1
			end
			c = s:sub(i, i)
			if c == "}" then
				return obj, i + 1
			end
			if c ~= '"' then
				error("expected object key at " .. i)
			end
			local key, j = decodeValue(s, i)
			while j <= #s and s:sub(j, j):find("%s") do
				j += 1
			end
			if s:sub(j, j) ~= ":" then
				error("expected : at " .. j)
			end
			local val, k = decodeValue(s, j + 1)
			obj[key] = val
			i = k
			while i <= #s and s:sub(i, i):find("%s") do
				i += 1
			end
			if s:sub(i, i) == "," then
				i += 1
			elseif s:sub(i, i) ~= "}" then
				error("expected , or } at " .. i)
			end
		end
	elseif c == "[" then
		local arr = {}
		local n = 0
		i += 1
		while true do
			while i <= #s and s:sub(i, i):find("%s") do
				i += 1
			end
			c = s:sub(i, i)
			if c == "]" then
				return arr, i + 1
			end
			local val, j = decodeValue(s, i)
			n += 1
			arr[n] = val
			i = j
			while i <= #s and s:sub(i, i):find("%s") do
				i += 1
			end
			if s:sub(i, i) == "," then
				i += 1
			elseif s:sub(i, i) ~= "]" then
				error("expected , or ] at " .. i)
			end
		end
	elseif c == '"' then
		local out = {}
		i += 1
		while true do
			local ch = s:sub(i, i)
			if ch == "" or ch == '"' then
				break
			elseif ch == "\\" then
				local esc = s:sub(i + 1, i + 1)
				if esc == "u" then
					local hex = s:sub(i + 2, i + 5)
					local cp = tonumber("0x" .. hex)
					table.insert(out, utf8.char(cp))
					i += 6
				else
					local map = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", ["b"] = "\b", ["f"] = "\f", ["n"] = "\n", ["r"] = "\r", ["t"] = "\t" }
					table.insert(out, map[esc] or esc)
					i += 2
				end
			else
				table.insert(out, ch)
				i += 1
			end
		end
		return table.concat(out), i + 1
	elseif c == "t" then
		if s:sub(i, i + 3) == "true" then
			return true, i + 4
		end
		error("bad literal at " .. i)
	elseif c == "f" then
		if s:sub(i, i + 4) == "false" then
			return false, i + 5
		end
		error("bad literal at " .. i)
	elseif c == "n" then
		if s:sub(i, i + 3) == "null" then
			return nil, i + 4
		end
		error("bad literal at " .. i)
	elseif c == "-" or (c and c:byte() and c:byte() >= 48 and c:byte() <= 57) then
		local start, fini = s:find("[%d%.eE+-]+", i)
		local tok = s:sub(start, fini)
		local num = tonumber(tok)
		return num, fini + 1
	end
	error("unexpected char '" .. c .. "' at " .. i)
end

function Json.decode(s)
	local v = decodeValue(s, 1)
	return v
end

return Json