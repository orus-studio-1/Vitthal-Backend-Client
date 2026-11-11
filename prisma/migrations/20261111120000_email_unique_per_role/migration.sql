-- One email may hold one account per role (client, vendor, worker, ...).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_role_key ON users (email, role);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS idx_users_email_unique;
DROP INDEX IF EXISTS users_email_key;
DROP INDEX IF EXISTS idx_users_email_unique;
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
