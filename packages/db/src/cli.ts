import { migrate } from './migrate.ts';

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is required to run migrations');
  process.exit(1);
}

const result = await migrate(url);
process.stdout.write(
  `${JSON.stringify({
    msg: 'migrations complete',
    applied: result.applied,
    skipped: result.skipped.length,
  })}\n`,
);
