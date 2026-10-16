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

-- Preserve existing service category IDs so existing service tickets,
-- catalogue services, and subcategory rows keep their references.
INSERT INTO public.service_categories
  (id, code, label, description, image, min_commision_percentage,
   max_commision_percentage, sort_order, is_active, created_at, updated_at)
SELECT id, code, label, description, image, min_commision_percentage,
       max_commision_percentage, sort_order, is_active, created_at, updated_at
FROM public.product_category
WHERE category_type IN ('service', 'both')
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code,
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  image = EXCLUDED.image,
  min_commision_percentage = EXCLUDED.min_commision_percentage,
  max_commision_percentage = EXCLUDED.max_commision_percentage,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = now();

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

-- The historical seed created these service-only rows in product_category.
-- Keep them for legacy foreign keys, but hide them from product category lists.
UPDATE public.product_category
SET is_active = false, updated_at = now()
WHERE code IN ('machine_maintenance', 'job_inquiry')
  AND category_type = 'service';
