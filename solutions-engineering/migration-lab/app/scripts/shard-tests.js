const fs = require('fs');
const path = require('path');

function parseShard(argv) {
  const flag = argv.find((arg) => arg.startsWith('--shard='));
  const value = flag ? flag.replace('--shard=', '') : process.env.TEST_SHARD;

  if (!value) {
    return { index: 1, total: 1 };
  }

  const [indexRaw, totalRaw] = value.split('/');
  const index = Number(indexRaw);
  const total = Number(totalRaw);

  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
    console.error('invalid shard: expected --shard=N/T');
    process.exit(1);
  }

  return { index, total };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Balance tests across shards by duration (Longest Processing Time greedy):
// sort tests longest-first, then assign each to the currently lightest shard.
// This keeps every shard's total duration close, instead of the old
// positional (idx % total) split that could pile all the slow tests onto one.
function assignTestsToShards(manifest, total) {
  const shards = Array.from({ length: total }, () => ({ tests: [], durationMs: 0 }));

  const sorted = [...manifest].sort((a, b) => {
    if (b.durationMs !== a.durationMs) {
      return b.durationMs - a.durationMs;
    }
    return a.name.localeCompare(b.name);
  });

  for (const test of sorted) {
    let target = 0;
    for (let i = 1; i < total; i++) {
      if (shards[i].durationMs < shards[target].durationMs) {
        target = i;
      }
    }
    shards[target].tests.push(test);
    shards[target].durationMs += test.durationMs;
  }

  return shards;
}

async function main() {
  const { index, total } = parseShard(process.argv.slice(2));
  const manifestPath = path.join(__dirname, '..', 'fixtures', 'test-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const scale = Number(process.env.TEST_DURATION_SCALE || 0.15);

  const tests = assignTestsToShards(manifest, total)[index - 1].tests;
  const expectedDuration = tests.reduce((sum, test) => sum + test.durationMs, 0);

  console.log(`running unit test shard ${index}/${total}`);
  console.log(`selected ${tests.length} tests with ${expectedDuration}ms historical duration`);

  for (const test of tests) {
    const started = Date.now();
    await sleep(Math.max(20, Math.round(test.durationMs * scale)));
    const elapsed = Date.now() - started;
    console.log(`PASS ${test.name} (${elapsed}ms, historical=${test.durationMs}ms)`);
  }

  console.log(`unit test shard ${index}/${total} completed`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
