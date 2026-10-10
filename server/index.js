require('dotenv').config();
const path = require('path');
const express = require('express');
const { types } = require('cassandra-driver');
const db = require('./db');
const { DEPTS, seedIfEmpty } = require('./seed');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const S = 'university.students';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toStudent = r => ({
  id: r.id.toString(), name: r.name, email: r.email, dept: r.dept, semester: r.semester,
  gpa: r.gpa, enrolled: r.enrolled ? r.enrolled.toString() : '', status: r.status || 'Active', phone: r.phone || ''
});
const bad = (msg, details, status = 400) => Object.assign(new Error(msg), { status, details });
const handler = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.status || (db.state.connected ? 500 : 503)).json({ error: e.message, details: e.details }); }
};
const requireId = id => { if (!UUID_RE.test(id)) throw bad('Invalid student id'); };

// ---- validation ----
const str = v => String(v ?? '').trim();

function validate(d) {
  if (!d || typeof d !== 'object') return { row: 'Invalid record.' };
  const e = {}, sem = Number(d.semester), g = Number(d.gpa);
  if (str(d.name).length < 2 || str(d.name).length > 100) e.name = 'Enter a full name (2-100 characters).';
  if (str(d.email).length > 254 || !/^\S+@\S+\.\S+$/.test(str(d.email))) e.email = 'Enter a valid email like name@uni.edu.';
  if (!DEPTS.includes(d.dept)) e.dept = 'Choose a department.';
  if (str(d.semester) === '' || !Number.isInteger(sem) || sem < 1 || sem > 8) e.semester = 'Semester must be 1-8.';
  if (str(d.gpa) === '' || !(g >= 0 && g <= 10)) e.gpa = 'CGPA must be between 0 and 10.';
  if (str(d.phone) && !/^\d{10}$/.test(str(d.phone))) e.phone = 'Phone must be 10 digits.';
  return e;
}
// Order: name, email (stored lower-case), dept, semester, gpa, phone
const fields = d => [str(d.name), str(d.email).toLowerCase(), d.dept, Number(d.semester), Number(d.gpa), str(d.phone) || null];

async function emailTaken(email, exceptId) {
  const r = await db.run('Check email', `SELECT id FROM ${S} WHERE email = ?`, [email]);
  return r.rows.some(x => x.id.toString() !== exceptId);
}

// ---- health & monitoring ----
app.get('/api/health', handler(async (req, res) => {
  const t = Date.now();
  let ok = false, error = db.state.error || 'Connecting...';
  if (db.client()) {
    try {
      const r = await db.client().execute('SELECT release_version FROM system.local');
      db.state.version = r.first().release_version;
      ok = true; error = null;
    } catch (e) { error = e.message.split('\n')[0]; }
  }
  db.state.connected = ok;
  res.json({ connected: ok, host: db.hosts, version: db.state.version, ms: Date.now() - t, error });
}));

app.get('/api/activity', handler(async (req, res) => {
  const l = db.log, lat = l.slice(0, 40).map(x => x.ms).reverse(), ok = l.filter(x => x.ok).length;
  res.json({
    log: l.slice(0, 100), latency: lat,
    stats: { total: l.length, ok, failed: l.length - ok, avgMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0 }
  });
}));

// ---- students ----
app.get('/api/students', handler(async (req, res) => {
  const r = await db.run('Read students', `SELECT * FROM ${S}`);
  res.json(r.rows.map(toStudent));
}));

app.get('/api/students/:id/enrollments', handler(async (req, res) => {
  requireId(req.params.id);
  const r = await db.run('Read enrollment history', 'SELECT term, credits, gpa FROM university.enrollments WHERE student_id = ?', [req.params.id]);
  res.json(r.rows.map(x => ({ term: x.term, credits: x.credits, gpa: x.gpa })));
}));

app.post('/api/students', handler(async (req, res) => {
  const d = req.body, details = validate(d);
  if (Object.keys(details).length) throw bad('Validation failed', details);
  const f = fields(d);
  if (await emailTaken(f[1])) throw bad('Validation failed', { email: 'This email is already registered.' });
  const id = types.Uuid.random(), today = types.LocalDate.fromDate(new Date());
  await db.run('Student created',
    `INSERT INTO ${S} (id, name, email, dept, semester, gpa, enrolled, status, phone) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, f[0], f[1], f[2], f[3], f[4], today, 'Active', f[5]]);
  res.status(201).json({ id: id.toString() });
}));

app.put('/api/students/:id', handler(async (req, res) => {
  const id = req.params.id;
  requireId(id);
  const d = req.body, details = validate(d);
  if (Object.keys(details).length) throw bad('Validation failed', details);
  // Cassandra UPDATE is an upsert, so check the student exists or a typo'd id would create a half-empty row.
  const found = await db.run('Check student', `SELECT id FROM ${S} WHERE id = ?`, [id]);
  if (!found.rows.length) throw bad('Student not found', null, 404);
  const f = fields(d);
  if (await emailTaken(f[1], id)) throw bad('Validation failed', { email: 'This email is already registered.' });
  await db.run('Student updated',
    `UPDATE ${S} SET name = ?, email = ?, dept = ?, semester = ?, gpa = ?, phone = ? WHERE id = ?`, [...f, id]);
  res.json({ id });
}));

app.delete('/api/students/:id', handler(async (req, res) => {
  const id = req.params.id;
  requireId(id);
  await db.run('Student deleted', `DELETE FROM ${S} WHERE id = ?`, [id]);
  await db.run('Delete enrollments', 'DELETE FROM university.enrollments WHERE student_id = ?', [id]);
  res.json({ id });
}));

app.post('/api/students/bulk', handler(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (rows.length > 1000) throw bad('Import up to 1000 rows at a time.');
  const known = new Set((await db.run('Read emails', `SELECT email FROM ${S}`)).rows.map(r => (r.email || '').toLowerCase()));
  const jobs = [], skipped = [], today = types.LocalDate.fromDate(new Date());
  rows.forEach((d, i) => {
    const e = validate(d), f = Object.keys(e).length ? null : fields(d);
    if (f && known.has(f[1])) e.email = 'This email is already registered.';
    if (Object.keys(e).length) return skipped.push(`Row ${i + 1}: ${Object.values(e)[0]}`);
    known.add(f[1]);
    jobs.push([`INSERT INTO ${S} (id, name, email, dept, semester, gpa, enrolled, status, phone) VALUES (?,?,?,?,?,?,?,?,?)`,
      [types.Uuid.random(), f[0], f[1], f[2], f[3], f[4], today, 'Active', f[5]]]);
  });
  if (jobs.length) await db.runMany('Bulk import', `INSERT INTO ${S} (${jobs.length} rows, bulk)`, jobs);
  res.json({ imported: jobs.length, skipped });
}));

// ---- explorer ----
const plain = v => v == null ? null : v instanceof Date ? v.toISOString()
  : typeof v === 'object' ? (Array.isArray(v) || v.constructor === Object ? JSON.stringify(v) : String(v)) : v;
const toRows = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map(c => [c.name, plain(r[c.name])])));
const VISIBLE = ['university', 'system_schema'];

app.get('/api/schema', handler(async (req, res) => {
  const [t, c] = await Promise.all([
    db.run('Read schema', 'SELECT keyspace_name, table_name FROM system_schema.tables'),
    db.run('Read schema', 'SELECT keyspace_name, table_name, column_name, type, kind, position FROM system_schema.columns')
  ]);
  const out = {}, rank = { partition_key: 0, clustering: 1, regular: 2 };
  t.rows.filter(r => VISIBLE.includes(r.keyspace_name)).forEach(r => { (out[r.keyspace_name] ||= {})[r.table_name] = []; });
  c.rows.filter(r => out[r.keyspace_name]?.[r.table_name])
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.position - b.position || a.column_name.localeCompare(b.column_name))
    .forEach(r => out[r.keyspace_name][r.table_name].push([r.column_name, r.type, r.kind === 'partition_key' ? 'PK' : r.kind === 'clustering' ? 'CK' : '']));
  res.json(out);
}));

app.get('/api/counts', handler(async (req, res) => {
  const out = {};
  for (const t of ['students', 'enrollments', 'activity_log'])
    out[t] = Number((await db.run('Read counts', `SELECT COUNT(*) AS c FROM university.${t}`)).first().c);
  res.json(out);
}));

app.get('/api/browse', handler(async (req, res) => {
  const { ks, table } = req.query;
  if (!VISIBLE.includes(ks) || !/^[a-z_]+$/.test(table || '')) throw bad('Unknown keyspace or table');
  const known = await db.run('Read schema', 'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?', [ks]);
  if (!known.rows.some(r => r.table_name === table)) throw bad('Unknown table', null, 404);
  res.json(toRows(await db.run('Browse records', `SELECT * FROM ${ks}.${table} LIMIT 15`)));
}));

const QUERIES = [
  'SELECT * FROM university.students LIMIT 10',
  'SELECT COUNT(*) FROM university.students',
  "SELECT * FROM university.students WHERE dept = 'Civil' LIMIT 15 ALLOW FILTERING",
  'SELECT id, name, gpa FROM university.students WHERE gpa > 9 LIMIT 15 ALLOW FILTERING',
  "SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'university'"
];
app.get('/api/queries', handler(async (req, res) => res.json(QUERIES.map((cql, id) => ({ id, cql })))));
app.post('/api/queries/run', handler(async (req, res) => {
  const cql = QUERIES[Number(req.body && req.body.id)];
  if (!cql) throw bad('Only approved queries can be run');
  const t = Date.now(), rows = toRows(await db.run('Explorer query', cql));
  res.json({ rows, count: rows.length, ms: Date.now() - t });
}));

// Which keyspace.table a statement targets. Quotes, comments and $$ strings are rejected
// before this runs, so a simple pattern per statement type is enough.
const IDENT = '([a-z0-9_]+)\\s*\\.\\s*([a-z0-9_]+)';
const TARGET = {
  select: new RegExp(`\\bfrom\\s+${IDENT}`, 'i'),
  insert: new RegExp(`^\\s*insert\\s+into\\s+${IDENT}`, 'i'),
  update: new RegExp(`^\\s*update\\s+${IDENT}`, 'i'),
  delete: new RegExp(`\\bfrom\\s+${IDENT}`, 'i')
};

app.post('/api/queries/custom', handler(async (req, res) => {
  const cql = String((req.body && req.body.cql) || '').trim().replace(/;+\s*$/, '');
  if (!cql) throw bad('Enter a query to run');
  if (cql.length > 2000) throw bad('Query is too long (max 2000 characters)');
  const bare = cql.replace(/'(?:[^']|'')*'/g, "''"); // text without string literals
  if (bare.includes(';')) throw bad('Run one statement at a time');
  if (/--|\/\*|\/\/|\$\$|"/.test(bare)) throw bad('Comments, quoted identifiers and $$ strings are not supported');
  const verb = ((bare.match(/^\s*([a-z]+)/i) || [])[1] || '').toLowerCase();
  if (!TARGET[verb]) throw bad('Only SELECT, INSERT, UPDATE and DELETE statements are allowed');
  const write = verb !== 'select';
  const m = bare.match(TARGET[verb]);
  if (!m) throw bad('Write the table as keyspace.table, e.g. university.students');
  const ks = m[1].toLowerCase();
  if (write ? ks !== 'university' : !VISIBLE.includes(ks))
    throw bad(write
      ? 'Data changes are only allowed on university tables (write university.table_name)'
      : 'Queries can only read the university and system_schema keyspaces');
  const t = Date.now();
  let rs;
  try {
    rs = await db.run(write ? 'Custom write' : 'Custom query', cql);
  } catch (e) {
    // Typos and invalid CQL are the user's mistake (400); real outages keep their 5xx status.
    const c = types.responseErrorCodes;
    if (e.code === c.syntaxError || e.code === c.invalid) throw bad(String(e.message).split('\n')[0]);
    throw e;
  }
  const all = write ? [] : toRows(rs);
  res.json({ rows: all.slice(0, 200), count: all.length, truncated: all.length > 200, write, ms: Date.now() - t });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

// Last-resort error handler: always answer with JSON (e.g. a malformed request body).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const msg = err.type === 'entity.parse.failed' ? 'Request body is not valid JSON'
    : err.type === 'entity.too.large' ? 'Request body is too large'
    : status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ error: msg });
});

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => console.log(`Console running at http://${HOST}:${PORT}`));
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set a different PORT in .env.` : e.message);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => { server.close(); await db.close(); process.exit(0); });

db.connectLoop().then(async () => {
  if (process.env.SEED_ON_START !== 'false') {
    const n = await seedIfEmpty().catch(e => console.log('Seed skipped:', e.message));
    if (n) console.log(`Seeded ${n} sample students`);
  }
});
