CREATE TABLE IF NOT EXISTS public.service_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  image text NOT NULL DEFAULT '',
  min_commision_percentage integer NOT NULL DEFAULT 0,
  max_commision_percentage integer NOT NULL DEFAULT 10,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now()
);

-- Step 1: Migrate all existing service-relevant categories from product_category.
-- This includes categories marked as 'service' or 'both', plus any product_category
-- rows that are currently referenced by service_subcategories, service_tickets,
-- services, or client_assets.
DO $$
DECLARE
  r RECORD;
  safe_code TEXT;
BEGIN
  FOR r IN (
    SELECT DISTINCT ON (pc.id)
      pc.id,
      COALESCE(NULLIF(pc.code, ''), 'cat_' || replace(pc.id::text, '-', '_')) AS code,
      COALESCE(NULLIF(pc.label, ''), 'Service Category') AS label,
      pc.description,
      COALESCE(pc.image, '') AS image,
      COALESCE(pc.min_commision_percentage, 0) AS min_comm,
      COALESCE(pc.max_commision_percentage, 10) AS max_comm,
      COALESCE(pc.sort_order, 0) AS sort_ord,
      COALESCE(pc.is_active, true) AS is_act,
      COALESCE(pc.created_at, now()) AS cr_at,
      COALESCE(pc.updated_at, now()) AS up_at
    FROM public.product_category pc
    WHERE pc.category_type IN ('service', 'both')
       OR pc.id IN (SELECT category_id FROM public.service_subcategories WHERE category_id IS NOT NULL)
       OR pc.id IN (SELECT category_id FROM public.service_tickets WHERE category_id IS NOT NULL)
       OR pc.id IN (SELECT category_id FROM public.services WHERE category_id IS NOT NULL)
       OR pc.id IN (SELECT category_id FROM public.client_assets WHERE category_id IS NOT NULL)
  ) LOOP
    safe_code := r.code;
    IF EXISTS (SELECT 1 FROM public.service_categories sc WHERE sc.code = safe_code AND sc.id <> r.id) THEN
      safe_code := safe_code || '_' || substr(replace(r.id::text, '-', ''), 1, 8);
    END IF;

    INSERT INTO public.service_categories
      (id, code, label, description, image, min_commision_percentage,
       max_commision_percentage, sort_order, is_active, created_at, updated_at)
    VALUES
      (r.id, safe_code, r.label, r.description, r.image, r.min_comm,
       r.max_comm, r.sort_ord, false, r.cr_at, r.up_at)
    ON CONFLICT (id) DO UPDATE SET
      code = EXCLUDED.code,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      image = EXCLUDED.image,
      min_commision_percentage = EXCLUDED.min_commision_percentage,
      max_commision_percentage = EXCLUDED.max_commision_percentage,
      sort_order = EXCLUDED.sort_order,
      is_active = false,
      updated_at = now();
  END LOOP;
END $$;

-- Step 2: Handle any orphaned category_id values that do not exist in product_category
-- but are referenced in service_subcategories, service_tickets, or services.
-- Inserted as inactive so they preserve foreign keys without polluting the active service list.
INSERT INTO public.service_categories (id, code, label, description, is_active)
SELECT DISTINCT
  sub.category_id,
  'legacy_subcat_' || replace(sub.category_id::text, '-', '_'),
  'Legacy Service Category',
  'Auto-created to preserve orphaned subcategories during migration',
  false
FROM public.service_subcategories sub
WHERE sub.category_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.service_categories sc WHERE sc.id = sub.category_id
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.service_categories (id, code, label, description, is_active)
SELECT DISTINCT
  st.category_id,
  'legacy_ticket_' || replace(st.category_id::text, '-', '_'),
  'Legacy Service Category',
  'Auto-created to preserve orphaned service tickets during migration',
  false
FROM public.service_tickets st
WHERE st.category_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.service_categories sc WHERE sc.id = st.category_id
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.service_categories (id, code, label, description, is_active)
SELECT DISTINCT
  s.category_id,
  'legacy_service_' || replace(s.category_id::text, '-', '_'),
  'Legacy Service Category',
  'Auto-created to preserve orphaned services during migration',
  false
FROM public.services s
WHERE s.category_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.service_categories sc WHERE sc.id = s.category_id
  )
ON CONFLICT (id) DO NOTHING;

-- Step 3: Seed standard service categories
INSERT INTO public.service_categories
  (code, label, description, image, min_commision_percentage,
   max_commision_percentage, sort_order, is_active)
VALUES
  ('machine_maintenance', 'Machine Maintenance',
   'Machine maintenance, repair, and service quotations.', '', 0, 10, 0, true),
  ('job_inquiry', 'Job Inquiry',
   'Multi-item jobwork inquiries with drawings, material specifications, and delivery requirements.', '', 0, 10, 1, true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

ALTER TABLE public.client_assets
  ADD COLUMN IF NOT EXISTS service_category_id uuid;

UPDATE public.client_assets asset
SET service_category_id = asset.category_id
FROM public.service_categories category
WHERE asset.category_id = category.id
  AND asset.service_category_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_client_assets_service_category'
      AND conrelid = 'public.client_assets'::regclass
  ) THEN
    ALTER TABLE public.client_assets
      ADD CONSTRAINT fk_client_assets_service_category
      FOREIGN KEY (service_category_id)
      REFERENCES public.service_categories(id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_service_subcategories_service_category'
      AND conrelid = 'public.service_subcategories'::regclass
  ) THEN
    ALTER TABLE public.service_subcategories
      DROP CONSTRAINT IF EXISTS service_subcategories_category_id_fkey;
    ALTER TABLE public.service_subcategories
      DROP CONSTRAINT IF EXISTS fk_subcategories_category;
    ALTER TABLE public.service_subcategories
      ADD CONSTRAINT fk_service_subcategories_service_category
      FOREIGN KEY (category_id)
      REFERENCES public.service_categories(id)
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_service_tickets_service_category'
      AND conrelid = 'public.service_tickets'::regclass
  ) THEN
    ALTER TABLE public.service_tickets
      DROP CONSTRAINT IF EXISTS service_tickets_category_id_fkey;
    ALTER TABLE public.service_tickets
      ADD CONSTRAINT fk_service_tickets_service_category
      FOREIGN KEY (category_id)
      REFERENCES public.service_categories(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_services_service_category'
      AND conrelid = 'public.services'::regclass
  ) THEN
    ALTER TABLE public.services
      DROP CONSTRAINT IF EXISTS fk_services_category;
    ALTER TABLE public.services
      ADD CONSTRAINT fk_services_service_category
      FOREIGN KEY (category_id)
      REFERENCES public.service_categories(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_assets_service_category
  ON public.client_assets (service_category_id);
CREATE INDEX IF NOT EXISTS idx_service_categories_active_sort
  ON public.service_categories (is_active, sort_order, label);

-- The historical seed created service rows in product_category.
-- Keep them for legacy foreign keys, but hide them completely from product category lists.
UPDATE public.product_category
SET is_active = false, updated_at = now()
WHERE category_type = 'service'
   OR code IN (
     'machine_maintenance',
     'job_inquiry',
     'logistics',
     'goods_ticket_inquiry',
     'freelancer_work',
     'precision_cnc_machining',
     'industrial_maintenance',
     'plant_automation',
     'structural_fabrication',
     'quality_inspection'
   );
