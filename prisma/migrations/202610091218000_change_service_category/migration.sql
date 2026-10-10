ALTER TABLE public.service_subcategories
  ADD COLUMN IF NOT EXISTS form_schema jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.client_assets
  ADD COLUMN IF NOT EXISTS service_subcategory_id uuid;

ALTER TABLE public.service_tickets
  ADD COLUMN IF NOT EXISTS service_subcategory_id uuid,
  ADD COLUMN IF NOT EXISTS service_sub_subcategory_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_client_assets_service_subcategory'
      AND conrelid = 'public.client_assets'::regclass
  ) THEN
    ALTER TABLE public.client_assets
      ADD CONSTRAINT fk_client_assets_service_subcategory
      FOREIGN KEY (service_subcategory_id)
      REFERENCES public.service_subcategories (id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_service_tickets_service_subcategory'
      AND conrelid = 'public.service_tickets'::regclass
  ) THEN
    ALTER TABLE public.service_tickets
      ADD CONSTRAINT fk_service_tickets_service_subcategory
      FOREIGN KEY (service_subcategory_id)
      REFERENCES public.service_subcategories (id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_service_tickets_service_sub_subcategory'
      AND conrelid = 'public.service_tickets'::regclass
  ) THEN
    ALTER TABLE public.service_tickets
      ADD CONSTRAINT fk_service_tickets_service_sub_subcategory
      FOREIGN KEY (service_sub_subcategory_id)
      REFERENCES public.service_subcategories (id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_service_subcategory_form_schema_array'
      AND conrelid = 'public.service_subcategories'::regclass
  ) THEN
    ALTER TABLE public.service_subcategories
      ADD CONSTRAINT chk_service_subcategory_form_schema_array
      CHECK (jsonb_typeof(form_schema) = 'array') NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_assets_service_subcategory
  ON public.client_assets (service_subcategory_id);
CREATE INDEX IF NOT EXISTS idx_service_tickets_service_subcategory
  ON public.service_tickets (service_subcategory_id);
CREATE INDEX IF NOT EXISTS idx_service_tickets_service_sub_subcategory
  ON public.service_tickets (service_sub_subcategory_id);

-- Keep previously configured legacy form fields where names match.
UPDATE public.service_subcategories current_sc
SET form_schema = legacy.form_schema
FROM public.subcategories legacy
WHERE current_sc.category_id = legacy.category_id
  AND lower(current_sc.name) = lower(legacy.name)
  AND current_sc.parent_id IS NULL
  AND current_sc.form_schema = '[]'::jsonb
  AND legacy.form_schema IS NOT NULL
  AND jsonb_typeof(legacy.form_schema) = 'array';

-- Seed one stable service category. Category/subcategory choices remain admin-owned.
DO $$
BEGIN
  UPDATE public.product_category
  SET label = 'Machine Maintenance',
      description = 'Machine maintenance, repair, and service quotations.',
      category_type = 'service',
      is_active = true,
      updated_at = now()
  WHERE code = 'machine_maintenance';

  IF NOT EXISTS (
    SELECT 1 FROM public.product_category
    WHERE code = 'machine_maintenance' OR lower(label) = 'machine maintenance'
  ) THEN
    INSERT INTO public.product_category
      (code, label, description, image, category_type, sort_order,
       min_commision_percentage, max_commision_percentage, is_active)
    VALUES
      ('machine_maintenance', 'Machine Maintenance',
       'Machine maintenance, repair, and service quotations.', '', 'service', 0, 0, 10, true);
  END IF;
END $$;

-- Seed Job Inquiry after Machine Maintenance. Its request form is implemented
-- in the client web app; taxonomy choices remain managed through the service
-- category administration flow.
DO $$
BEGIN
  UPDATE public.product_category
  SET code = 'job_inquiry',
      label = 'Job Inquiry',
      description = 'Submit multi-item jobwork inquiries with drawings, material specifications, and delivery requirements.',
      category_type = 'service',
      is_active = true,
      updated_at = now()
  WHERE code = 'job_inquiry' OR lower(label) = 'job inquiry';

  IF NOT EXISTS (
    SELECT 1 FROM public.product_category
    WHERE code = 'job_inquiry' OR lower(label) = 'job inquiry'
  ) THEN
    INSERT INTO public.product_category
      (code, label, description, image, category_type, sort_order,
       min_commision_percentage, max_commision_percentage, is_active)
    VALUES
      ('job_inquiry', 'Job Inquiry',
       'Submit multi-item jobwork inquiries with drawings, material specifications, and delivery requirements.',
       '', 'service', 1, 0, 10, true);
  END IF;
END $$;
