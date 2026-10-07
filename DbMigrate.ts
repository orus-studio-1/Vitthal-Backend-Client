import { execFileSync } from "child_process";
import pool from "./DbConnect";
import { ensureMarketplaceSchema } from "./legacy/DbSetup";

const BASELINE_MIGRATION = "0_init";

function prisma(...args: string[]) {
    // Run the locally installed CLI with the current node binary (works on Windows and without npx).
    const cli = require.resolve("prisma/build/index.js");
    execFileSync(process.execPath, [cli, ...args], { stdio: "inherit", env: process.env });
}

async function tableExists(name: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS exists;`, [`public.${name}`]);
    return rows[0].exists;
}

/**
 * Brings the database up to date using Prisma migrations (prisma/migrations).
 *
 * - DB already managed by Prisma  -> apply pending migrations.
 * - Pre-Prisma DB (has tables but no _prisma_migrations) -> run the frozen legacy setup one last
 *   time so it matches the baseline, mark 0_init as applied, then apply pending migrations.
 * - Empty DB -> `migrate deploy` creates everything from 0_init.
 */
export async function runDatabaseMigrations() {
    const managedByPrisma = await tableExists("_prisma_migrations");

    if (!managedByPrisma && (await tableExists("users"))) {
        console.log("[DbMigrate] Existing pre-Prisma database detected. Syncing legacy schema and baselining...");
        await ensureMarketplaceSchema();
        try {
            prisma("migrate", "resolve", "--applied", BASELINE_MIGRATION);
        } catch (err) {
            // Another instance may have baselined concurrently; only rethrow if it's still not recorded.
            if (!(await tableExists("_prisma_migrations"))) throw err;
        }
    }

    prisma("migrate", "deploy");
}

// Allow running directly: `npm run db:deploy`
if (require.main === module) {
    runDatabaseMigrations()
        .then(() => pool.end())
        .catch(async (err) => {
            console.error("[DbMigrate] Migration failed:", err);
            await pool.end();
            process.exit(1);
        });
}
