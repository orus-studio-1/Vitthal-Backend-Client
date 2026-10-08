ALTER TABLE products
  ADD COLUMN IF NOT EXISTS size TEXT,
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS grade TEXT,
  ADD COLUMN IF NOT EXISTS colour TEXT,
  ADD COLUMN IF NOT EXISTS warranty TEXT,
  ADD COLUMN IF NOT EXISTS manufacturer TEXT,
  ADD COLUMN IF NOT EXISTS unit TEXT DEFAULT 'nos';

-- Keep previously captured catalog values available to the new typed fields.
UPDATE products
SET size = COALESCE(size, attributes->>'size'),
    brand = COALESCE(brand, attributes->>'brand', attributes->>'Brand'),
    grade = COALESCE(grade, attributes->>'grade', attributes->>'Grade'),
    colour = COALESCE(colour, attributes->>'colour', attributes->>'color', attributes->>'Colour', attributes->>'Color'),
    warranty = COALESCE(warranty, attributes->>'warranty', attributes->>'guarantee', attributes->>'Warranty / Guarantee'),
    manufacturer = COALESCE(manufacturer, attributes->>'manufacturer', attributes->>'Manufacturer'),
    unit = COALESCE(NULLIF(attributes->>'unit', ''), NULLIF(attributes->>'uom', ''), NULLIF(attributes->>'unit_of_measure', ''), unit, 'nos');

ALTER TABLE vendor_products ALTER COLUMN gst_percentage SET DEFAULT 18.00;
