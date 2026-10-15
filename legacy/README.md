# Legacy schema — frozen

This is how the database was set up before Prisma. **Do not edit or add files here.**
Schema changes go through Prisma: see [`prisma/README.md`](../prisma/README.md).

It's kept only so `DbMigrate.ts` can bring a pre-Prisma database level with the `0_init` baseline the first time that database boots on the new code. After every environment has been migrated, this folder can be deleted.
