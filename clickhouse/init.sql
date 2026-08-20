CREATE TABLE IF NOT EXISTS logs (
  tenant_id LowCardinality(String) DEFAULT 'default',
  ts DateTime64(3, 'UTC'),
  service LowCardinality(String),
  host LowCardinality(String) DEFAULT '',
  level LowCardinality(String),
  message String,
  attrs String DEFAULT '{}',
  attr_map Map(LowCardinality(String), String) DEFAULT map(),
  trace_id String DEFAULT '',
  INDEX idx_trace_id_bf trace_id TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_attr_vals_bf mapValues(attr_map) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_message_text lowerUTF8(message) TYPE text(tokenizer = 'splitByNonAlpha') GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, service, ts)
TTL toDate(ts) + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS logs_by_minute (
  tenant_id LowCardinality(String),
  minute DateTime('UTC'),
  service LowCardinality(String),
  level LowCardinality(String),
  host LowCardinality(String),
  n AggregateFunction(count)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(minute)
ORDER BY (tenant_id, minute, service, level, host)
TTL toDate(minute) + INTERVAL 30 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS logs_by_minute_mv TO logs_by_minute AS
SELECT
  tenant_id,
  toStartOfMinute(ts) AS minute,
  service,
  level,
  host,
  countState() AS n
FROM logs
GROUP BY tenant_id, minute, service, level, host;

CREATE TABLE IF NOT EXISTS logs_attr_keys_by_minute (
  tenant_id LowCardinality(String),
  minute DateTime('UTC'),
  service LowCardinality(String),
  level LowCardinality(String),
  host LowCardinality(String),
  key LowCardinality(String),
  n AggregateFunction(count)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(minute)
ORDER BY (tenant_id, minute, service, level, host, key)
TTL toDate(minute) + INTERVAL 30 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS logs_attr_keys_by_minute_mv TO logs_attr_keys_by_minute AS
SELECT
  tenant_id,
  toStartOfMinute(ts) AS minute,
  service,
  level,
  host,
  key,
  countState() AS n
FROM logs
ARRAY JOIN mapKeys(attr_map) AS key
GROUP BY tenant_id, minute, service, level, host, key;

CREATE TABLE IF NOT EXISTS logs_attr_values_by_minute (
  tenant_id LowCardinality(String),
  minute DateTime('UTC'),
  service LowCardinality(String),
  level LowCardinality(String),
  host LowCardinality(String),
  key LowCardinality(String),
  value String,
  n AggregateFunction(count)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(minute)
ORDER BY (tenant_id, minute, key, value, service, host, level)
TTL toDate(minute) + INTERVAL 30 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS logs_attr_values_by_minute_mv TO logs_attr_values_by_minute AS
SELECT
  tenant_id,
  toStartOfMinute(ts) AS minute,
  service,
  level,
  host,
  key,
  value,
  countState() AS n
FROM logs
ARRAY JOIN mapKeys(attr_map) AS key, mapValues(attr_map) AS value
WHERE lengthUTF8(value) <= 64
  AND value != ''
  AND NOT startsWith(value, '{')
  AND NOT startsWith(value, '[')
  AND NOT match(value, '^[0-9a-fA-F]{32}$')
  AND NOT match(value, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
GROUP BY tenant_id, minute, service, level, host, key, value;

CREATE TABLE IF NOT EXISTS logs_attr_numeric_by_minute (
  tenant_id LowCardinality(String),
  minute DateTime('UTC'),
  service LowCardinality(String),
  level LowCardinality(String),
  host LowCardinality(String),
  key LowCardinality(String),
  n AggregateFunction(count),
  v_sum AggregateFunction(sum, Float64),
  v_min AggregateFunction(min, Float64),
  v_max AggregateFunction(max, Float64),
  v_p99 AggregateFunction(quantileTDigest(0.99), Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(minute)
ORDER BY (tenant_id, key, minute, service, host, level)
TTL toDate(minute) + INTERVAL 30 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS logs_attr_numeric_by_minute_mv TO logs_attr_numeric_by_minute AS
SELECT
  tenant_id,
  toStartOfMinute(ts) AS minute,
  service,
  level,
  host,
  key,
  countState() AS n,
  sumState(toFloat64(value)) AS v_sum,
  minState(toFloat64(value)) AS v_min,
  maxState(toFloat64(value)) AS v_max,
  quantileTDigestState(0.99)(toFloat64(value)) AS v_p99
FROM logs
ARRAY JOIN mapKeys(attr_map) AS key, mapValues(attr_map) AS value
WHERE lengthUTF8(value) <= 64
  AND value != ''
  AND NOT startsWith(value, '{')
  AND NOT startsWith(value, '[')
  AND NOT match(value, '^[0-9a-fA-F]{32}$')
  AND NOT match(value, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
  AND isFinite(toFloat64OrNull(value))
GROUP BY tenant_id, minute, service, level, host, key;
