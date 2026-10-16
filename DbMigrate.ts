import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
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

function getMigrationsDir(): string | null {
    const candidateDirs = [
        path.join(process.cwd(), "prisma", "migrations"),
        path.join(__dirname, "prisma", "migrations"),
        path.join(__dirname, "..", "prisma", "migrations"),
    ];
    for (const dir of candidateDirs) {
        if (fs.existsSync(dir)) return dir;
    }
    return null;
}

/**
 * Automatically recovers any failed migrations recorded in _prisma_migrations.
 * When a migration fails during `migrate deploy`, Prisma writes finished_at=NULL and
 * blocks all subsequent migrations with P3018 until marked as rolled back.
 */
async function resolveFailedMigrations() {
    try {
        const { rows } = await pool.query(`
            SELECT migration_name FROM _prisma_migrations
            WHERE finished_at IS NULL AND rolled_back_at IS NULL;
        `);

        for (const row of rows) {
            console.log(`[DbMigrate] Found failed migration in database: ${row.migration_name}. Marking as rolled back...`);
            try {
                prisma("migrate", "resolve", "--rolled-back", row.migration_name);
                console.log(`[DbMigrate] Successfully marked ${row.migration_name} as rolled back.`);
            } catch (err) {
                console.warn(`[DbMigrate] CLI resolve failed, updating _prisma_migrations directly:`, err);
                await pool.query(`
                    UPDATE _prisma_migrations
                    SET rolled_back_at = NOW()
                    WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL;
                `, [row.migration_name]);
            }
        }
    } catch (err) {
        console.warn(`[DbMigrate] Could not check or resolve failed migrations:`, err);
    }
}

/**
 * Syncs checksums in _prisma_migrations for already-applied migrations with the
 * files on disk to prevent Prisma P3009 (checksum mismatch) errors.
 */
async function syncAppliedMigrationChecksums() {
    try {
        const migrationsDir = getMigrationsDir();
        if (!migrationsDir) return;

        const { rows } = await pool.query(`
            SELECT id, migration_name, checksum FROM _prisma_migrations
            WHERE finished_at IS NOT NULL;
        `);

        for (const row of rows) {
            const sqlPath = path.join(migrationsDir, row.migration_name, "migration.sql");
            if (fs.existsSync(sqlPath)) {
                const content = fs.readFileSync(sqlPath);
                const currentChecksum = crypto.createHash("sha256").update(content).digest("hex");
                if (row.checksum !== currentChecksum) {
                    console.log(`[DbMigrate] Updating checksum for applied migration ${row.migration_name} to match migration.sql`);
                    await pool.query(
                        `UPDATE _prisma_migrations SET checksum = $1 WHERE id = $2;`,
                        [currentChecksum, row.id]
                    );
                }
            }
        }
    } catch (err) {
        console.warn(`[DbMigrate] Checksum sync encountered an issue:`, err);
    }
}

/**
 * Brings the database up to date using Prisma migrations (prisma/migrations).
 *
 * - DB already managed by Prisma  -> recover failed, sync checksums, apply pending migrations.
 * - Pre-Prisma DB (has tables but no _prisma_migrations) -> run legacy setup, baseline 0_init, apply pending.
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

    if (await tableExists("_prisma_migrations")) {
        await resolveFailedMigrations();
        await syncAppliedMigrationChecksums();
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
