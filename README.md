# Cassandra Campus Record Console

A university records console backed by a real **Apache Cassandra** database. It has four modules: analytics, student management, a Cassandra explorer and database monitoring. A Node.js API talks to Cassandra, and a single-page frontend (no build step) talks to the API.

## Table of contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Project structure](#project-structure)
4. [Quick start](#quick-start)
5. [Configuration](#configuration)
6. [API reference](#api-reference)
7. [Cassandra schema](#cassandra-schema)
8. [Security notes](#security-notes)
9. [Troubleshooting](#troubleshooting)
10. [Roadmap](#roadmap)

## Features

### 1. University analytics dashboard
- Total students, departments, average CGPA and students on leave
- Enrollment trend (line chart), department comparison and semester distribution (bar charts)
- Date-range filters that update every chart and counter
- Data-quality indicators: valid emails, duplicate emails, missing phone numbers
- Recent database activity

### 2. Advanced student management
- Student profiles with academic details and enrollment history (from the `enrollments` table)
- Search, column sorting, department and status filters, pagination
- Add, edit and delete with validation on both client and server (name, email format and uniqueness, semester 1-8, CGPA 0-10, 10-digit phone)
- Bulk CSV import (quoted fields supported; invalid rows are skipped and reported) and CSV export

CSV format: `name,email,dept,semester,gpa,phone` with an optional header row. `dept` must be one of the six departments in the dropdown.

### 3. Cassandra explorer
- Keyspaces, tables and schemas read live from `system_schema` (partition and clustering keys marked)
- Browse real records and see record counts
- A CQL editor with example queries, row count and execution time. It accepts one `SELECT`, `INSERT`, `UPDATE` or `DELETE` statement at a time. Reads are limited to the `university` and `system_schema` keyspaces; changes are limited to `university`.
- Connection status, host and Cassandra version

### 4. Monitoring and activity
- Live connection status and ping time, refreshed every 10 seconds
- Successful and failed operation counts, average latency and a latency chart
- Student create, update and delete log linked to the CQL each action ran
- Full operation history; writes and failures are also persisted to `university.activity_log` (kept for 30 days)

All modules share one sidebar, responsive layout, loading skeletons, empty states, light and dark themes, and success or error toasts.

## Architecture

```
Browser (public/index.html)  --HTTP/JSON-->  Express API (server/)  --CQL-->  Cassandra 4.1 (Docker)
                                                                     host port 9043 -> container port 9042
```

- The frontend never talks to Cassandra directly. Browsers cannot use the Cassandra protocol.
- Every query goes through `db.run()` in `server/db.js`, which times it and records the result. That log feeds the Monitoring and Dashboard activity views.
- Table browsing is limited to the `university` and `system_schema` keyspaces, and the CQL editor validates the keyspace of every statement before running it.
- If Cassandra is down, the API returns `503` and the UI shows a retry screen. The server keeps retrying the first connection every 5 seconds; after that the driver reconnects on its own.

## Project structure

```
cassandra-campus-record-console/
├── docker-compose.yml    # Cassandra 4.1 container with a data volume
├── package.json
├── .env.example          # copy to .env to customise
├── .gitignore
├── server/
│   ├── index.js          # Express routes, validation, static hosting
│   ├── db.js             # connection, schema bootstrap, operation tracking
│   └── seed.js           # sample data (runs only when the table is empty)
├── public/
│   └── index.html        # the whole frontend
└── README.md
```

## Quick start

**Requirements:** Node.js 18+, Docker Desktop (or Docker Engine with Compose v2), about 1.5 GB of free RAM.

```bash
# 1. clone
git clone https://github.com/sowjanya-m025/cassandra-campus-record-console.git
cd cassandra-campus-record-console

# 2. start Cassandra (first boot takes 1-2 minutes)
docker compose up -d --wait   # returns when the container is healthy

# 3. install and run the app
npm install
cp .env.example .env         # Windows: copy .env.example .env
npm start
```

Open **http://localhost:3002**.

On first connection the server creates the `university` keyspace and tables, then inserts 60 sample students with enrollment history. Later starts reuse the stored data.

Useful commands:

```bash
npm run dev                          # restart on file changes
npm run seed                         # seed manually (only if students table is empty)
docker compose logs -f cassandra     # watch Cassandra start
docker compose exec cassandra cqlsh  # open a CQL shell
docker compose down                  # stop (data is kept)
docker compose down -v               # stop and delete all data
```

Try it in `cqlsh`: `SELECT name, dept, gpa FROM university.students LIMIT 5;`

## Configuration

Set these in `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | Web server port |
| `HOST` | `127.0.0.1` | Address the web server listens on (see [Security notes](#security-notes)) |
| `CASSANDRA_HOSTS` | `127.0.0.1` | Comma-separated contact points |
| `CASSANDRA_PORT` | `9043` | Native protocol port on the host. `docker-compose.yml` publishes it as `127.0.0.1:9043 -> 9042` |
| `CASSANDRA_DC` | `datacenter1` | Local data centre name |
| `SEED_ON_START` | `true` | Insert sample data when the table is empty |

If you change the host port in `docker-compose.yml`, change `CASSANDRA_PORT` to match. The part after the colon (`9042`) is Cassandra's own port inside the container and must stay as it is.

## API reference

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/health` | Connection status, host, version, ping |
| GET | `/api/activity` | Operation log, latency series, success and failure counts |
| GET | `/api/students` | All students |
| POST | `/api/students` | Create a student |
| PUT | `/api/students/:id` | Update a student |
| DELETE | `/api/students/:id` | Delete a student and their enrollments |
| GET | `/api/students/:id/enrollments` | Enrollment history |
| POST | `/api/students/bulk` | Bulk import `{ rows: [...] }` (max 1000 rows) |
| GET | `/api/schema` | Keyspaces, tables, columns and keys |
| GET | `/api/counts` | Record counts per table |
| GET | `/api/browse?ks=&table=` | First 15 rows of a table |
| GET | `/api/queries` | Example CQL queries |
| POST | `/api/queries/run` | Run one of the example queries `{ id }` |
| POST | `/api/queries/custom` | Run one `SELECT`, `INSERT`, `UPDATE` or `DELETE` `{ cql }` |

Errors return `{ "error": "...", "details": { "field": "message" } }` with status 400 (validation), 404, 500, or 503 when Cassandra is unavailable.

## Cassandra schema

Created automatically on startup:

```sql
CREATE KEYSPACE IF NOT EXISTS university
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE TABLE IF NOT EXISTS university.students (
  id uuid PRIMARY KEY,
  name text, email text, dept text,
  semester int, gpa double, enrolled date,
  status text, phone text
);
CREATE INDEX IF NOT EXISTS students_email_idx ON university.students (email);

CREATE TABLE IF NOT EXISTS university.enrollments (
  student_id uuid, term text, credits int, gpa double,
  PRIMARY KEY (student_id, term)
);

-- activity rows expire after 30 days
CREATE TABLE IF NOT EXISTS university.activity_log (
  day date, ts timestamp, action text, latency_ms int,
  PRIMARY KEY (day, ts)
) WITH CLUSTERING ORDER BY (ts DESC)
  AND default_time_to_live = 2592000;
```

Design notes: `SimpleStrategy` with replication factor 1 suits a single local node only. For a real cluster use `NetworkTopologyStrategy`. The email index is used for the uniqueness check, which is not a hard guarantee: two simultaneous requests with the same email could both pass. The dashboard reads the full students table, which is fine at demo scale but would need dedicated query tables for large data.

## Security notes

This is a demo console. It has **no login**, and the CQL editor can change and delete data in the `university` keyspace.

- The web server listens on `127.0.0.1` by default, so only your own machine can reach it. Do not set `HOST=0.0.0.0` or deploy it to a shared network without adding authentication first.
- `docker-compose.yml` publishes Cassandra on `127.0.0.1` only, because the container runs without authentication.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Sidebar shows "Disconnected" right after start | Cassandra is still booting. Wait for `docker compose ps` to show healthy. The app reconnects on its own. |
| Terminal repeats "Waiting for Cassandra" with `ECONNRESET` | The published port does not reach Cassandra. `docker compose ps` must show `127.0.0.1:9043->9042/tcp`. If it shows `9043->9043`, fix the `ports:` line in `docker-compose.yml`, then run `docker compose up -d --force-recreate`. |
| Terminal repeats "Waiting for Cassandra" with `ECONNREFUSED` | Nothing is listening on `CASSANDRA_PORT`. Check `docker compose ps`, and make sure `.env` uses the same host port as `docker-compose.yml`. |
| Cassandra container exits | Give Docker at least 2 GB of memory, or lower `MAX_HEAP_SIZE` in `docker-compose.yml`. |
| `All hosts tried for query failed` with a data-centre error | Set `CASSANDRA_DC` to match your cluster. Check with `docker compose exec cassandra nodetool status`. |
| Port 3002 in use | Set a different `PORT` in `.env`. |
| `docker compose` not found | Install Docker Desktop, or use `docker-compose` (v1) with the same arguments. |

## Roadmap

- Authentication and role-based access
- Query tables for dashboard aggregates instead of full scans
- Automated tests for validation and CSV parsing
- Containerised app service in `docker-compose.yml`

## License

MIT. Add a `LICENSE` file when you publish.
