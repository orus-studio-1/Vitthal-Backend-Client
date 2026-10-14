-- Vendor service request coverage uses the admin-managed service taxonomy.
-- A NULL subcategory row marks the vendor's selected main service category;
-- additional rows mark selectable subcategory and sub-subcategory nodes.
CREATE TABLE IF NOT EXISTS public.vendor_service_category_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL,
  service_category_id uuid NOT NULL,
  service_subcategory_id uuid,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT fk_vendor_service_category_selections_vendor
    FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE,
  CONSTRAINT fk_vendor_service_category_selections_category
    FOREIGN KEY (service_category_id) REFERENCES public.service_categories(id) ON DELETE CASCADE,
  CONSTRAINT fk_vendor_service_category_selections_subcategory
    FOREIGN KEY (service_subcategory_id) REFERENCES public.service_subcategories(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_service_category_selections_category
  ON public.vendor_service_category_selections (vendor_id, service_category_id)
  WHERE service_subcategory_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_service_category_selections_node
  ON public.vendor_service_category_selections (vendor_id, service_subcategory_id)
  WHERE service_subcategory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_service_category_selections_vendor_category
  ON public.vendor_service_category_selections (vendor_id, service_category_id);

CREATE INDEX IF NOT EXISTS idx_vendor_service_category_selections_subcategory
  ON public.vendor_service_category_selections (service_subcategory_id);
