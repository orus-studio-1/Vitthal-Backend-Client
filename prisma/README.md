# Database (Prisma)

`prisma/schema.prisma` + `prisma/migrations/` are the **only** source of truth for the database schema.
Do not create tables with raw SQL, `legacy/`, or one-off scripts in `scratch/`.

## Day-to-day

| Task | Command |
| --- | --- |
| Change the schema (add table/column/index) | edit `schema.prisma`, then `npm run db:migrate:dev -- --name add_something` |
| Apply pending migrations (also runs automatically on server start) | `npm run db:migrate` |
| See which migrations are applied | `npm run db:status` |
| Check a DB for drift from the migrations (prints the SQL difference; empty = OK) | `npm run db:drift` |
| Regenerate the client after pulling | `npm run db:generate` (also runs on `npm install`) |
| Browse data | `npm run db:studio` |

`db:migrate:dev` creates a new folder in `prisma/migrations/`, applies it to your `DATABASE_URL`, and regenerates the client. **Commit that folder** together with the `schema.prisma` change.

Rules:
- Run `db:migrate:dev` only against your **own dev database**, never production. Production only ever gets `npm run db:migrate` (`prisma migrate deploy`), which the server runs on boot.
- Never edit a migration that has already been merged — add a new one.
- Things Prisma can't express in the schema (CHECK constraints, partial indexes, triggers) go in a migration: `npm run db:migrate:dev -- --name x --create-only`, edit the generated SQL, then run `npm run db:migrate:dev` again.
- If two people add migrations in parallel, the second one to merge should pull and re-run `db:migrate:dev`.

## Using Prisma in code

```ts
import prisma from '../DbPrisma';

const user = await prisma.users.findUnique({ where: { id } });
```

Existing `pool.query(...)` code keeps working; Prisma shares the same `pg` pool. Migrate code to Prisma gradually, if at all.

## How existing databases were moved over

`0_init` is a `pg_dump` of the full schema as of commit `15544d6` (what `legacy/schema.sql` + `legacy/DbSetup.ts` + `legacy/migrations/` produced).

On boot, `DbMigrate.ts`:
1. **DB already uses Prisma** (`_prisma_migrations` exists): runs `prisma migrate deploy`.
2. **Pre-Prisma DB** (has `users`, no `_prisma_migrations`): runs the frozen legacy setup one last time so it matches the baseline, marks `0_init` as applied without running it, then runs `migrate deploy`.
3. **Empty DB**: `migrate deploy` creates everything from `0_init`.

If an old DB still differs from the baseline, `npm run db:drift` shows the SQL needed to fix it.

## Shadow database

`migrate dev` and `db:drift` need a temporary "shadow" database. Prisma creates one automatically if your DB user has permission to. If yours doesn't, create an empty database and set `SHADOW_DATABASE_URL` in `.env`.
