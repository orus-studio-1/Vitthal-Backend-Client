import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import pool from './DbConnect';

// Shares the existing pg pool, so Prisma and raw `pool.query` calls use the same connections
// (important on Neon's limited connection count). Existing pg queries keep working unchanged.
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

export default prisma;
