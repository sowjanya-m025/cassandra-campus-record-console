require('dotenv').config();
const { types } = require('cassandra-driver');
const db = require('./db');

const DEPTS = ['Computer Science', 'Electronics', 'Mechanical', 'Civil', 'Business', 'Biotechnology'];
const FN = ['Aarav', 'Diya', 'Rohan', 'Ananya', 'Karthik', 'Meera', 'Vikram', 'Sneha', 'Arjun', 'Priya', 'Nikhil', 'Kavya', 'Rahul', 'Isha', 'Suresh', 'Lakshmi', 'Varun', 'Pooja', 'Manoj', 'Divya'];
const LN = ['Gowda', 'Rao', 'Nair', 'Shetty', 'Iyer', 'Kumar', 'Patil', 'Hegde', 'Reddy', 'Bhat', 'Menon', 'Sharma'];
const pick = a => a[Math.floor(Math.random() * a.length)];
const gpa = () => +(6 + Math.random() * 4).toFixed(2);

// Inserts sample students and enrollment history, only when the table is empty.
async function seedIfEmpty(n = 60) {
  const c = db.client();
  if (!c) throw new Error('Cassandra is not connected');
  const r = await c.execute('SELECT COUNT(*) AS c FROM university.students');
  if (Number(r.first().c) > 0) return 0;

  const now = new Date();
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const id = types.Uuid.random();
    const name = `${pick(FN)} ${pick(LN)}`;
    const sem = 1 + Math.floor(Math.random() * 8);
    // Month index overflows into later years: June 2022 up to mid 2026. Never in the future.
    let when = new Date(2022, 5 + Math.floor(Math.random() * 50), 1 + Math.floor(Math.random() * 27));
    if (when > now) when = now;
    jobs.push([
      'INSERT INTO university.students (id, name, email, dept, semester, gpa, enrolled, status, phone) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, name, `${name.toLowerCase().replace(' ', '.')}${i}@uni.edu`, pick(DEPTS), sem, gpa(),
        types.LocalDate.fromDate(when), Math.random() > 0.9 ? 'On leave' : 'Active',
        // '9' + 9 random digits = a 10-digit number
        Math.random() > 0.12 ? '9' + Math.floor(1e8 + Math.random() * 9e8) : null]
    ]);
    for (let k = 1; k <= sem; k++)
      jobs.push([
        'INSERT INTO university.enrollments (student_id, term, credits, gpa) VALUES (?,?,?,?)',
        [id, `Semester ${k}`, 16 + Math.floor(Math.random() * 8), gpa()]
      ]);
  }
  for (let i = 0; i < jobs.length; i += 50)
    await Promise.all(jobs.slice(i, i + 50).map(([q, p]) => c.execute(q, p, { prepare: true })));
  return n;
}

module.exports = { DEPTS, seedIfEmpty };

if (require.main === module) {
  (async () => {
    await db.connectLoop(); // waits for Cassandra instead of failing on the first attempt
    const n = await seedIfEmpty();
    console.log(n ? `Seeded ${n} students.` : 'Students table is not empty, nothing seeded.');
    await db.close();
    process.exit(0);
  })().catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
}
