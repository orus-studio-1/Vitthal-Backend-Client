-- Clean separation of Product Categories and Service Categories.
-- 1. Ensure service categories in product_category are deactivated so product queries never return services.
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

-- 2. Ensure remaining active categories in product_category have category_type = 'product'.
UPDATE public.product_category
SET category_type = 'product'
WHERE is_active = true AND category_type IS DISTINCT FROM 'product';

-- 3. In service_categories, ensure only dedicated service categories are active.
UPDATE public.service_categories
SET is_active = true, updated_at = now()
WHERE code IN (
  'machine_maintenance',
  'job_inquiry',
  'logistics',
  'goods_ticket_inquiry',
  'freelancer_work'
);

-- 4. Deactivate any legacy product categories or placeholders in service_categories so service lists never return products.
UPDATE public.service_categories
SET is_active = false, updated_at = now()
WHERE code IN (
  'precision_cnc_machining',
  'industrial_maintenance',
  'plant_automation',
  'structural_fabrication',
  'quality_inspection'
)
OR code LIKE 'cat_%'
OR code LIKE 'legacy_%';
