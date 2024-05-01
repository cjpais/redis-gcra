local rate_limit_key = KEYS[1]
local now            = ARGV[1]
local burst          = ARGV[2]
local rate           = ARGV[3]
local period         = ARGV[4]
local cost           = ARGV[5]
local monthly_limit  = ARGV[6]
local start_of_month = ARGV[7]

-- tat
local emission_interval = period / rate
local increment         = emission_interval * cost
local burst_offset      = emission_interval * burst

-- monthly limit
local monthly_count_key = rate_limit_key .. ":monthly_count:" .. start_of_month
local monthly_count = tonumber(redis.call("GET", monthly_count_key) or 0)

if monthly_count == 0 then
  -- set the key to expire 33 days after the start of the month
  redis.call("SET", monthly_count_key, 0, "EXAT", start_of_month + (60 * 60 * 24 * 33))
end

local tat = redis.call("GET", rate_limit_key)

if not tat then
  tat = now
else
  tat = tonumber(tat)
end
tat = math.max(tat, now)

local new_tat = tat + increment
local allow_at = new_tat - burst_offset
local diff = now - allow_at

local limited
local retry_in
local reset_in

local remaining = math.floor(diff / emission_interval) -- poor man's round

if remaining < 0 or (tonumber(monthly_limit) ~= -1 and monthly_count >= tonumber(monthly_limit)) then
  limited = 1
  -- calculate how many tokens there actually are, since
  -- remaining is how many there would have been if we had been able to limit
  -- and we did not limit
  remaining = math.floor((now - (tat - burst_offset)) / emission_interval)
  reset_in = math.ceil(tat - now)
  retry_in = math.ceil(diff * -1)
elseif remaining == 0 and increment <= 0 then
  -- request with cost of 0
  -- cost of 0 with remaining 0 is still limited
  limited = 1
  remaining = 0
  reset_in = math.ceil(tat - now)
  retry_in = 0 -- retry in is meaningless when cost is 0
else
  limited = 0
  reset_in = math.ceil(new_tat - now)
  retry_in = 0
  if increment > 0 then
    redis.call("SET", rate_limit_key, new_tat, "PX", reset_in)
  end

  redis.call("INCRBY", monthly_count_key, cost)
  monthly_count = monthly_count + cost
end

local monthly_remaining = "unlimited"
if monthly_limit ~= "-1" then
  monthly_remaining = monthly_limit - monthly_count
end

return {limited, remaining, retry_in, reset_in, tostring(diff), tostring(emission_interval), monthly_remaining}