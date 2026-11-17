const { Pool } = require('pg');

// Fallback if the server somehow doesn't report max_connections.
const FALLBACK_MAX_CONNECTIONS = 20;

function connectionString() {
  return process.env.DATABASE_URL || 'postgresql://acme:acme@localhost:55432/acme_test';
}

function parsePoolSize() {
  const size = Number(process.env.APP_DB_POOL_SIZE || 4);
  if (!Number.isInteger(size) || size < 1) {
    console.error('invalid APP_DB_POOL_SIZE value');
    process.exit(1);
  }
  return size;
}

// Ask Postgres how many connections it will actually accept, minus the slots it
// reserves for superuser/maintenance use. This is the hard capacity the suite
// must live within — the database is the scarce resource, so we size the
// clients to fit it rather than letting client demand float free with CPU count.
async function readConnectionBudget() {
  const pool = new Pool({
    connectionString: connectionString(),
    max: 1,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 1000,
  });

  try {
    const result = await pool.query(
      "select name, setting from pg_settings where name in ('max_connections', 'superuser_reserved_connections', 'reserved_connections')",
    );
    const settings = Object.fromEntries(result.rows.map((row) => [row.name, Number(row.setting)]));
    const maxConnections = settings.max_connections || FALLBACK_MAX_CONNECTIONS;
    const reserved =
      (settings.superuser_reserved_connections || 0) + (settings.reserved_connections || 0);
    const available = Math.max(1, maxConnections - reserved);
    return { maxConnections, reserved, available };
  } finally {
    await pool.end();
  }
}

// Derive the worker count from the connection budget: workers * poolSize must
// stay within the connections the server actually has. An explicit
// INTEGRATION_WORKERS still overrides, but it is validated against the budget
// below so an oversized value fails loudly instead of exhausting the server.
function resolveWorkers(available, poolSize) {
  const budgetWorkers = Math.max(1, Math.floor(available / poolSize));

  const configured = process.env.INTEGRATION_WORKERS;
  if (configured === undefined || configured === '' || configured === 'auto') {
    return { workers: budgetWorkers, source: 'budget' };
  }

  const workers = Number(configured);
  if (!Number.isInteger(workers) || workers < 1) {
    console.error('invalid INTEGRATION_WORKERS value');
    process.exit(1);
  }
  return { workers, source: 'override' };
}

async function runWorker(workerId, poolSize) {
  const pool = new Pool({
    connectionString: connectionString(),
    max: poolSize,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 1000,
  });

  try {
    await Promise.all(
      Array.from({ length: poolSize }, async () => {
        await pool.query('select pg_sleep(0.4)');
      }),
    );
    await pool.query('insert into test_events (worker_id) values ($1)', [workerId]);
    return { workerId, ok: true };
  } finally {
    await pool.end();
  }
}

async function prepareDatabase() {
  const pool = new Pool({
    connectionString: connectionString(),
    max: 1,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 1000,
  });

  try {
    await pool.query('create table if not exists test_events (id serial primary key, worker_id int, created_at timestamptz default now())');
  } finally {
    await pool.end();
  }
}

async function main() {
  const poolSize = parsePoolSize();

  console.log('starting integration suite');

  const { maxConnections, reserved, available } = await readConnectionBudget();
  const { workers, source } = resolveWorkers(available, poolSize);
  const demand = workers * poolSize;

  console.log(
    `connection budget: max_connections=${maxConnections} reserved=${reserved} available=${available}`,
  );
  console.log(
    `concurrency: ${workers} workers (${source}) x ${poolSize} conns/pool = ${demand} peak connections`,
  );

  // Fail loudly and early if the concurrency would exhaust the server, instead
  // of surfacing a vague "readiness deadline" after the pools time out.
  if (demand > available) {
    console.error(
      `connection budget exceeded: ${workers} workers x ${poolSize} conns/pool = ${demand} ` +
        `> ${available} available (max_connections=${maxConnections} - ${reserved} reserved). ` +
        'Lower INTEGRATION_WORKERS or APP_DB_POOL_SIZE, or raise Postgres max_connections.',
    );
    process.exit(1);
  }

  await prepareDatabase();

  const results = await Promise.allSettled(
    Array.from({ length: workers }, (_, index) => runWorker(index + 1, poolSize)),
  );

  const failures = results.filter((result) => result.status === 'rejected');

  if (failures.length > 0) {
    console.error('tenant bootstrap failed before the readiness deadline');
    console.error('inspect runtime service logs from the runner for more detail');
    process.exit(1);
  }

  console.log(`integration suite completed`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
