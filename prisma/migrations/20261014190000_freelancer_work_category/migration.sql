INSERT INTO public.service_categories
  (code, label, description, image, min_commision_percentage,
   max_commision_percentage, sort_order, is_active)
VALUES
  ('freelancer_work', 'Freelancer Work',
   'Freelance design, CAD, manufacturing, CNC, CAM, tooling, and quality advisory projects.',
   '', 0, 10, 4, true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();
