import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Read leniently so `prisma generate` (postinstall/build) works without a DB configured.
    url: process.env.DATABASE_URL ?? '',
    // Optional. Only needed by `prisma migrate dev` / `migrate diff` when the DB user
    // can't create a temporary shadow database itself (e.g. some hosted Postgres plans).
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
