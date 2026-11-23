-- Each Global Catalogue Excel import is recorded with the file's SHA-256 fingerprint, so the exact
-- same file cannot be imported twice. Product-level duplicates are caught separately by the import.
CREATE TABLE IF NOT EXISTS "product_import_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "file_hash" TEXT NOT NULL,
    "file_name" TEXT,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "imported_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT "product_import_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_product_import_batches_user" FOREIGN KEY ("imported_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "idx_product_import_batches_file_hash" ON "product_import_batches"("file_hash");

-- Speeds up the duplicate checks the import runs (item code and name, both case-insensitive).
CREATE INDEX IF NOT EXISTS "idx_products_item_code_lower" ON "products"(LOWER("item_code"));
CREATE INDEX IF NOT EXISTS "idx_products_name_lower" ON "products"(LOWER(TRIM("name")));
