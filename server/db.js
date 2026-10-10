const cassandra = require('cassandra-driver');
const { types } = cassandra;

const hosts = (process.env.CASSANDRA_HOSTS || '127.0.0.1').split(',').map(h => h.trim()).filter(Boolean);
const port = Number(process.env.CASSANDRA_PORT || 9043);
const state = { connected: false, error: null, version: null };
const log = []; // newest first, in-memory operation history
let client = null;

const SCHEMA = [
  `CREATE KEYSPACE IF NOT EXISTS university
     WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
  `CREATE TABLE IF NOT EXISTS university.students (
     id uuid PRIMARY KEY, name text, email text, dept text,
     semester int, gpa double, enrolled date, status text, phone text)`,
  `CREATE INDEX IF NOT EXISTS students_email_idx ON university.students (email)`,
  `CREATE TABLE IF NOT EXISTS university.enrollments (
     student_id uuid, term text, credits int, gpa double,
     PRIMARY KEY (student_id, term))`,
  // Activity rows expire after 30 days so the table cannot grow without limit.
  `CREATE TABLE IF NOT EXISTS university.activity_log (
     day date, ts timestamp, action text, latency_ms int,
     PRIMARY KEY (day, ts)) WITH CLUSTERING ORDER BY (ts DESC)
     AND default_time_to_live = 2592000`
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Short, readable reason for a failure. NoHostAvailableError hides the real cause
// (e.g. "read ECONNRESET") inside innerErrors, so surface that instead.
function describe(e) {
  const inner = e.innerErrors ? Object.entries(e.innerErrors)[0] : null;
  return inner ? `${inner[0]}: ${inner[1].message}` : String(e.message).split('\n')[0];
}

async function connect() {
  const c = new cassandra.Client({
    contactPoints: hosts,
    localDataCenter: process.env.CASSANDRA_DC || 'datacenter1',
    protocolOptions: { port }
  });
  try {
    await c.connect();
    for (const q of SCHEMA) await c.execute(q);
    const r = await c.execute('SELECT release_version FROM system.local');
    state.version = r.first().release_version;
  } catch (e) {
    await c.shutdown().catch(() => {});
    throw e;
  }
  client = c;
  state.connected = true;
  state.error = null;
}

async function connectLoop() {
  while (!state.connected) {
    try {
      await connect();
      console.log(`Connected to Cassandra ${state.version} at ${hosts.join(',')}:${port}`);
    } catch (e) {
      state.error = describe(e);
      console.log(`Waiting for Cassandra (${state.error.slice(0, 160)}). Retrying in 5s...`);
      await sleep(5000);
    }
  }
}

async function close() {
  const c = client;
  client = null;
  state.connected = false;
  if (c) await c.shutdown().catch(() => {});
}

function record(entry) {
  log.unshift(entry);
  if (log.length > 300) log.pop();
  // Persist writes and failures to the activity_log table (best effort).
  if (client && (entry.op !== 'SELECT' || !entry.ok)) {
    client.execute(
      'INSERT INTO university.activity_log (day, ts, action, latency_ms) VALUES (?, ?, ?, ?)',
      [types.LocalDate.fromDate(new Date()), new Date(), `${entry.action}${entry.ok ? '' : ' (failed)'}`, entry.ms],
      { prepare: true }
    ).catch(() => {});
  }
}

// Runs fn(client), times it and records the outcome.
async function track(action, cql, fn) {
  const t = process.hrtime.bigint();
  const done = (ok, msg) => record({
    ts: new Date().toISOString(), action, cql: cql.replace(/\s+/g, ' ').trim(),
    op: cql.trim().split(/\s+/)[0].toUpperCase(),
    ms: Math.round(Number(process.hrtime.bigint() - t) / 1e6), ok, msg
  });
  try {
    if (!client) throw new Error('Cassandra is not connected yet');
    const r = await fn(client);
    done(true, 'OK');
    return r;
  } catch (e) {
    if (e.name === 'NoHostAvailableError') state.connected = false;
    done(false, describe(e));
    throw e;
  }
}

const run = (action, cql, params = []) =>
  track(action, cql, c => c.execute(cql, params, { prepare: true }));

// Executes many [cql, params] statements, 50 at a time, as one tracked operation.
// Not atomic: if one statement fails, earlier ones are already written.
const runMany = (action, label, list) =>
  track(action, label, async c => {
    for (let i = 0; i < list.length; i += 50)
      await Promise.all(list.slice(i, i + 50).map(([q, p]) => c.execute(q, p, { prepare: true })));
  });

module.exports = {
  connect, connectLoop, close, run, runMany, state, log, hosts: `${hosts.join(',')}:${port}`,
  client: () => client
};
