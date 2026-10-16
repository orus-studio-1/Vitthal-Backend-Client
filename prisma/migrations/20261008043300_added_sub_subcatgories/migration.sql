ALTER TABLE service_subcategories
ADD COLUMN IF NOT EXISTS parent_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_subcategory_id_category
ON service_subcategories (id, category_id);

CREATE INDEX IF NOT EXISTS idx_service_subcategories_category_id
ON service_subcategories (category_id);

CREATE INDEX IF NOT EXISTS idx_service_subcategories_parent_id
ON service_subcategories (parent_id);

CREATE INDEX IF NOT EXISTS idx_service_subcategories_category_parent
ON service_subcategories (category_id, parent_id);

ALTER TABLE service_subcategories
DROP CONSTRAINT IF EXISTS unique_subcategory_name_per_category;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_subcategory_root_name
ON service_subcategories (category_id, LOWER(name))
WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_subcategory_child_name
ON service_subcategories (category_id, parent_id, LOWER(name))
WHERE parent_id IS NOT NULL;

ALTER TABLE service_subcategories
DROP CONSTRAINT IF EXISTS fk_service_subcategory_parent_category;

ALTER TABLE service_subcategories
ADD CONSTRAINT fk_service_subcategory_parent_category
FOREIGN KEY (parent_id, category_id)
REFERENCES service_subcategories (id, category_id)
ON DELETE NO ACTION
ON UPDATE NO ACTION;

CREATE OR REPLACE FUNCTION check_service_subcategory_depth()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL THEN

        IF EXISTS (
            SELECT 1
            FROM service_subcategories parent
            WHERE parent.id = NEW.parent_id
              AND parent.parent_id IS NOT NULL
        ) THEN
            RAISE EXCEPTION
                'A service subcategory cannot have another subcategory as its parent. Maximum depth is 2.';
        END IF;

    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.parent_id IS NULL
       AND NEW.parent_id IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM service_subcategories child WHERE child.parent_id = NEW.id
       ) THEN
        RAISE EXCEPTION
            'A service subcategory with children cannot become a child. Maximum depth is 2.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_service_subcategory_depth
ON service_subcategories;

CREATE TRIGGER trg_check_service_subcategory_depth
BEFORE INSERT OR UPDATE OF parent_id
ON service_subcategories
FOR EACH ROW
EXECUTE FUNCTION check_service_subcategory_depth();

