CREATE TABLE "vendor_logistics_vehicles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vendor_id" UUID NOT NULL,
    "vehicle_class_key" VARCHAR(80) NOT NULL,
    "vehicle_class" VARCHAR(120) NOT NULL,
    "vehicle_name" VARCHAR(160) NOT NULL,
    "payload" VARCHAR(120) NOT NULL,
    "dimensions" VARCHAR(160) NOT NULL,
    "image_key" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_logistics_vehicles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_vendor_logistics_vehicles_class"
    ON "vendor_logistics_vehicles" ("vehicle_class_key", "is_active");

CREATE INDEX "idx_vendor_logistics_vehicles_vendor"
    ON "vendor_logistics_vehicles" ("vendor_id", "is_active");

ALTER TABLE "vendor_logistics_vehicles"
    ADD CONSTRAINT "vendor_logistics_vehicles_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
