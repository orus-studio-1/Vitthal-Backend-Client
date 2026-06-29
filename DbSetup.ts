import pool from "./DbConnect";

export async function ensureMarketplaceSchema() {
    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE EXTENSION IF NOT EXISTS citext;

        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
                CREATE TYPE user_role AS ENUM ('client', 'vendor', 'admin', 'super_admin');
            END IF;
        END $$;

        ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'fulfillment_center';

        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cart_type') THEN
                CREATE TYPE cart_type AS ENUM ('direct', 'quotation');
            END IF;
        END $$;

        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quotation_status') THEN
                CREATE TYPE quotation_status AS ENUM (
                    'pending_vendor',
                    'vendor_offered',
                    'vendor_countered',
                    'client_countered',
                    'client_accepted',
                    'client_rejected',
                    'vendor_rejected',
                    'cancelled',
                    'expired'
                );
            END IF;
        END $$;

        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quotation_message_action') THEN
                CREATE TYPE quotation_message_action AS ENUM ('request', 'offer', 'counter', 'accept', 'reject', 'note');
            END IF;
        END $$;

        CREATE TABLE IF NOT EXISTS products_images (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            product_id UUID NOT NULL,
            image_url TEXT NOT NULL,
            is_primary BOOLEAN NOT NULL DEFAULT FALSE,
            display_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS product_category (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            code TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL,
            description TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS vendor_categories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            vendor_id UUID NOT NULL,
            category_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT unique_vendor_category_selection UNIQUE (vendor_id, category_id),
            CONSTRAINT fk_vendor_categories_vendor
                FOREIGN KEY (vendor_id)
                REFERENCES vendors(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_vendor_categories_category
                FOREIGN KEY (category_id)
                REFERENCES product_category(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS product_variants (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            product_id UUID NOT NULL,
            sku TEXT,
            name TEXT,
            properties JSONB NOT NULL DEFAULT '{}'::jsonb,
            approval_status TEXT NOT NULL DEFAULT 'approved',
            approval_notes TEXT,
            created_by_user_id UUID,
            reviewed_by_user_id UUID,
            reviewed_at TIMESTAMPTZ,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_product_variants_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            CONSTRAINT uq_product_id_properties UNIQUE (product_id, properties)
        );

        CREATE TABLE IF NOT EXISTS vendor_products (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            product_id UUID NOT NULL,
            product_variant_id UUID NOT NULL,
            vendor_id UUID NOT NULL,
            price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
            moq INTEGER NOT NULL CHECK (moq > 0),
            stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
            commision_percentage INTEGER DEFAULT 0 CHECK (commision_percentage >= 0 AND commision_percentage <= 100),
            quotation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            quotation_min_qty INTEGER,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT unique_vendor_product_variant UNIQUE (vendor_id, product_variant_id)
        );

        CREATE TABLE IF NOT EXISTS order_item_reviews (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id UUID NOT NULL,
            order_item_id UUID NOT NULL UNIQUE,
            user_id UUID NOT NULL,
            product_id UUID NOT NULL,
            vendor_id UUID NOT NULL,
            rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
            review_title TEXT,
            review_text TEXT,
            is_verified_purchase BOOLEAN NOT NULL DEFAULT TRUE,
            images TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_order_item_reviews_order
                FOREIGN KEY (order_id)
                REFERENCES orders(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_order_item_reviews_order_item
                FOREIGN KEY (order_item_id)
                REFERENCES order_items(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_order_item_reviews_user
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_order_item_reviews_product
                FOREIGN KEY (product_id)
                REFERENCES products(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_order_item_reviews_vendor
                FOREIGN KEY (vendor_id)
                REFERENCES vendors(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS vendor_reviews (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id UUID NOT NULL,
            user_id UUID NOT NULL,
            vendor_id UUID NOT NULL,
            rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
            review_title TEXT,
            review_text TEXT,
            is_verified_purchase BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT unique_vendor_review_per_order UNIQUE (order_id, vendor_id),
            CONSTRAINT fk_vendor_reviews_order
                FOREIGN KEY (order_id)
                REFERENCES orders(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_vendor_reviews_user
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_vendor_reviews_vendor
                FOREIGN KEY (vendor_id)
                REFERENCES vendors(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS addresses (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID UNIQUE NOT NULL,
            address TEXT NOT NULL,
            city TEXT NOT NULL,
            state TEXT NOT NULL,
            country TEXT NOT NULL,
            pincode VARCHAR(6) NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
            latitude DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
            longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS client (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL UNIQUE,
            phone TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS quotation_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL,
            vendor_id UUID NOT NULL,
            product_id UUID NOT NULL,
            product_variant_id UUID NOT NULL,
            requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
            requested_price NUMERIC(12,2) CHECK (requested_price >= 0),
            status quotation_status NOT NULL DEFAULT 'pending_vendor',
            request_note TEXT,
            buyer_city TEXT,
            buyer_state TEXT,
            buyer_country TEXT,
            buyer_pincode VARCHAR(6),
            current_offer_price NUMERIC(12,2) CHECK (current_offer_price >= 0),
            current_offer_quantity INTEGER CHECK (current_offer_quantity > 0),
            current_offer_by TEXT,
            accepted_price NUMERIC(12,2) CHECK (accepted_price >= 0),
            accepted_quantity INTEGER CHECK (accepted_quantity > 0),
            rejection_reason TEXT,
            order_id UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_quotation_requests_user
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_quotation_requests_vendor
                FOREIGN KEY (vendor_id)
                REFERENCES vendors(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_quotation_requests_product
                FOREIGN KEY (product_id)
                REFERENCES products(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_quotation_requests_variant
                FOREIGN KEY (product_variant_id)
                REFERENCES product_variants(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_quotation_requests_order
                FOREIGN KEY (order_id)
                REFERENCES orders(id)
                ON DELETE SET NULL,
            CONSTRAINT chk_quotation_offer_by
                CHECK (current_offer_by IS NULL OR current_offer_by IN ('client', 'vendor'))
        );

        CREATE TABLE IF NOT EXISTS quotation_messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            quotation_id UUID NOT NULL,
            sender_user_id UUID NOT NULL,
            sender_role TEXT NOT NULL,
            action quotation_message_action NOT NULL,
            offer_price NUMERIC(12,2) CHECK (offer_price >= 0),
            offer_quantity INTEGER CHECK (offer_quantity > 0),
            note TEXT,
            reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_quotation_messages_quotation
                FOREIGN KEY (quotation_id)
                REFERENCES quotation_requests(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_quotation_messages_sender
                FOREIGN KEY (sender_user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,
            CONSTRAINT chk_quotation_sender_role
                CHECK (sender_role IN ('client', 'vendor'))
        );

        CREATE TABLE IF NOT EXISTS wishlists (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_wishlists_user
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS wishlist_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wishlist_id UUID NOT NULL,
            product_id UUID NOT NULL,
            product_variant_id UUID NOT NULL,
            vendor_id UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT unique_wishlist_product_variant UNIQUE (wishlist_id, product_variant_id),
            CONSTRAINT fk_wishlist_items_wishlist
                FOREIGN KEY (wishlist_id)
                REFERENCES wishlists(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_wishlist_items_product
                FOREIGN KEY (product_id)
                REFERENCES products(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_wishlist_items_variant
                FOREIGN KEY (product_variant_id)
                REFERENCES product_variants(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_wishlist_items_vendor
                FOREIGN KEY (vendor_id)
                REFERENCES vendors(id)
                ON DELETE SET NULL
        );

            CREATE TABLE IF NOT EXISTS abandoned_reminder_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                source_type TEXT NOT NULL CHECK (source_type IN ('cart', 'wishlist')),
                source_item_id UUID NOT NULL,
                reminder_type TEXT NOT NULL DEFAULT '24h_abandoned_reminder',
                sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT unique_abandoned_reminder_source UNIQUE (source_type, source_item_id, reminder_type),
                CONSTRAINT fk_abandoned_reminder_logs_user
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS fulfillment_centers (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                code TEXT NOT NULL UNIQUE,
                contact_phone TEXT,
                contact_email CITEXT,
                manager_name TEXT,
                address TEXT NOT NULL,
                city TEXT NOT NULL,
                state TEXT NOT NULL,
                country TEXT NOT NULL,
                pincode VARCHAR(6) NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
                latitude DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
                longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
                total_area_sqft NUMERIC(10,2),
                capacity_packages INTEGER,
                storage_type TEXT,
                operating_hours TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            ALTER TABLE fulfillment_centers
                ADD COLUMN IF NOT EXISTS code TEXT,
                ADD COLUMN IF NOT EXISTS contact_phone TEXT,
                ADD COLUMN IF NOT EXISTS contact_email CITEXT,
                ADD COLUMN IF NOT EXISTS manager_name TEXT,
                ADD COLUMN IF NOT EXISTS total_area_sqft NUMERIC(10,2),
                ADD COLUMN IF NOT EXISTS capacity_packages INTEGER,
                ADD COLUMN IF NOT EXISTS storage_type TEXT,
                ADD COLUMN IF NOT EXISTS operating_hours TEXT,
                ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
                ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

            UPDATE fulfillment_centers
            SET code = 'FC-' || substr(id::text, 1, 8)
            WHERE code IS NULL OR btrim(code) = '';

            ALTER TABLE fulfillment_centers
                ALTER COLUMN code SET NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_fulfillment_centers_user_id ON fulfillment_centers(user_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_fulfillment_centers_code ON fulfillment_centers(code);

        ALTER TABLE products
            ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved',
            ADD COLUMN IF NOT EXISTS item_code TEXT,
            ADD COLUMN IF NOT EXISTS approval_notes TEXT,
            ADD COLUMN IF NOT EXISTS created_by_user_id UUID,
            ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS rating NUMERIC(2,1) NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE vendors
            ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending',
            ADD COLUMN IF NOT EXISTS approval_notes TEXT,
            ADD COLUMN IF NOT EXISTS reconsideration_notes TEXT,
            ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS gst_certificate_link TEXT,
            ADD COLUMN IF NOT EXISTS vendor_signature_image_link TEXT,
            ADD COLUMN IF NOT EXISTS business_type TEXT,
            ADD COLUMN IF NOT EXISTS company_website TEXT,
            ADD COLUMN IF NOT EXISTS alternative_number TEXT,
            ADD COLUMN IF NOT EXISTS designation TEXT,
            ADD COLUMN IF NOT EXISTS business_description TEXT,
            ADD COLUMN IF NOT EXISTS application_number TEXT UNIQUE,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE orders
            ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'client',
            ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'direct',
            ADD COLUMN IF NOT EXISTS order_reference TEXT,
            ADD COLUMN IF NOT EXISTS order_notes TEXT,
            ADD COLUMN IF NOT EXISTS customer_name TEXT,
            ADD COLUMN IF NOT EXISTS customer_email TEXT,
            ADD COLUMN IF NOT EXISTS customer_phone TEXT,
            ADD COLUMN IF NOT EXISTS created_by_admin_id TEXT,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE carts
            ADD COLUMN IF NOT EXISTS cart_type cart_type NOT NULL DEFAULT 'direct';

        UPDATE carts
        SET cart_type = 'direct'
        WHERE cart_type IS NULL;

        ALTER TABLE carts
            DROP CONSTRAINT IF EXISTS carts_user_id_key;

        ALTER TABLE products_images
            ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE vendor_products
            ADD COLUMN IF NOT EXISTS product_variant_id UUID,
            ADD COLUMN IF NOT EXISTS stock_quantity INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS commision_percentage INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS quotation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS quotation_min_qty INTEGER,
            ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE addresses
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE client
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE order_item_reviews
            ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}';

        ALTER TABLE product_category
            ADD COLUMN IF NOT EXISTS code TEXT,
            ADD COLUMN IF NOT EXISTS label TEXT,
            ADD COLUMN IF NOT EXISTS image TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS min_commision_percentage INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS max_commision_percentage INTEGER NOT NULL DEFAULT 10;

        UPDATE product_category
        SET code = 'category-' || substr(id::text, 1, 8)
        WHERE code IS NULL OR btrim(code) = '';

        UPDATE product_category
        SET label = code
        WHERE label IS NULL OR btrim(label) = '';

        ALTER TABLE product_category
            ALTER COLUMN code SET NOT NULL,
            ALTER COLUMN label SET NOT NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_product_category_code ON product_category(code);

        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'fk_products_images_product'
                  AND table_name = 'products_images'
            ) THEN
                ALTER TABLE products_images
                    ADD CONSTRAINT fk_products_images_product
                    FOREIGN KEY (product_id)
                    REFERENCES products(id)
                    ON DELETE CASCADE;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'fk_vendor_products_product'
                  AND table_name = 'vendor_products'
            ) THEN
                ALTER TABLE vendor_products
                    ADD CONSTRAINT fk_vendor_products_product
                    FOREIGN KEY (product_id)
                    REFERENCES products(id)
                    ON DELETE CASCADE;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'fk_vendor_products_vendor'
                  AND table_name = 'vendor_products'
            ) THEN
                ALTER TABLE vendor_products
                    ADD CONSTRAINT fk_vendor_products_vendor
                    FOREIGN KEY (vendor_id)
                    REFERENCES vendors(id)
                    ON DELETE CASCADE;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'fk_addresses_user'
                  AND table_name = 'addresses'
            ) THEN
                ALTER TABLE addresses
                    ADD CONSTRAINT fk_addresses_user
                    FOREIGN KEY (user_id)
                    REFERENCES users(id)
                    ON DELETE CASCADE;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'fk_client_user'
                  AND table_name = 'client'
            ) THEN
                ALTER TABLE client
                    ADD CONSTRAINT fk_client_user
                    FOREIGN KEY (user_id)
                    REFERENCES users(id)
                    ON DELETE CASCADE;
            END IF;
        END $$;

        CREATE TABLE IF NOT EXISTS payments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            amount NUMERIC(12, 2) NOT NULL,
            currency VARCHAR(10) DEFAULT 'INR',
            status VARCHAR(50) DEFAULT 'pending',
            payment_method VARCHAR(50) DEFAULT 'razorpay',
            razorpay_order_id VARCHAR(255) UNIQUE,
            razorpay_payment_id VARCHAR(255),
            razorpay_signature TEXT,
            order_ids UUID[] DEFAULT '{}',
            quotation_request_id UUID REFERENCES quotation_requests(id) ON DELETE SET NULL,
            split_number INTEGER DEFAULT 1,
            split_percentage NUMERIC(5, 2) DEFAULT 100.00,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
        CREATE INDEX IF NOT EXISTS idx_payments_razorpay_order_id ON payments(razorpay_order_id);

        CREATE INDEX IF NOT EXISTS idx_vendor_products_product_id ON vendor_products(product_id);
        CREATE INDEX IF NOT EXISTS idx_vendor_categories_vendor_id ON vendor_categories(vendor_id);
        CREATE INDEX IF NOT EXISTS idx_vendor_categories_category_id ON vendor_categories(category_id);
        DROP INDEX IF EXISTS idx_carts_user_type_status;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_user_type_status
            ON carts(user_id, cart_type) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_products_images_product_id ON products_images(product_id);
        CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
        CREATE INDEX IF NOT EXISTS idx_products_product_type ON products(product_type);
        CREATE INDEX IF NOT EXISTS idx_vendors_rating ON vendors(rating DESC) WHERE is_active = TRUE;
        CREATE INDEX IF NOT EXISTS idx_wishlists_user_id ON wishlists(user_id);
        CREATE INDEX IF NOT EXISTS idx_wishlist_items_wishlist_id ON wishlist_items(wishlist_id);
        CREATE INDEX IF NOT EXISTS idx_wishlist_items_product_id ON wishlist_items(product_id);
        CREATE INDEX IF NOT EXISTS idx_abandoned_reminder_logs_user_id ON abandoned_reminder_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_abandoned_reminder_logs_source ON abandoned_reminder_logs(source_type, source_item_id);
        CREATE INDEX IF NOT EXISTS idx_order_item_reviews_order_id ON order_item_reviews(order_id);
        CREATE INDEX IF NOT EXISTS idx_order_item_reviews_user_id ON order_item_reviews(user_id);
        CREATE INDEX IF NOT EXISTS idx_order_item_reviews_product_id ON order_item_reviews(product_id);
        CREATE INDEX IF NOT EXISTS idx_order_item_reviews_vendor_id ON order_item_reviews(vendor_id);
        CREATE INDEX IF NOT EXISTS idx_vendor_reviews_order_id ON vendor_reviews(order_id);
        CREATE INDEX IF NOT EXISTS idx_vendor_reviews_user_id ON vendor_reviews(user_id);
        CREATE INDEX IF NOT EXISTS idx_vendor_reviews_vendor_id ON vendor_reviews(vendor_id);
        CREATE INDEX IF NOT EXISTS idx_quotation_requests_vendor_id ON quotation_requests(vendor_id);
        CREATE INDEX IF NOT EXISTS idx_quotation_requests_user_id ON quotation_requests(user_id);
        CREATE INDEX IF NOT EXISTS idx_quotation_requests_status ON quotation_requests(status);
        CREATE INDEX IF NOT EXISTS idx_quotation_requests_product_id ON quotation_requests(product_id);
        CREATE INDEX IF NOT EXISTS idx_quotation_messages_quotation_id ON quotation_messages(quotation_id, created_at ASC);

        UPDATE products
        SET approval_status = 'approved'
        WHERE approval_status IS NULL OR approval_status::TEXT = '';

        UPDATE vendors
        SET approval_status = 'approved'
        WHERE approval_status IS NULL OR approval_status::TEXT = '';

        UPDATE orders
        SET source = 'client'
        WHERE source IS NULL OR source::TEXT = '';

        -- V2 schema updates
        ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_product_type;
        ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS gst_percentage NUMERIC(5,2) DEFAULT 0.00;
        ALTER TABLE products_images ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'image';
        ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS pending_price NUMERIC(12,2) DEFAULT NULL CHECK (pending_price >= 0);
        ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS discounted_price NUMERIC(12,2) DEFAULT NULL CHECK (discounted_price >= 0);
        ALTER TABLE order_items ADD COLUMN IF NOT EXISTS original_price NUMERIC(12,2) DEFAULT NULL;
        ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS name TEXT;
        ALTER TABLE products_images ADD COLUMN IF NOT EXISTS product_variant_id UUID;

        UPDATE product_variants
        SET name = (
            SELECT COALESCE(string_agg(key || ': ' || value, ', '), 'Default Variation')
            FROM jsonb_each_text(properties)
        )
        WHERE name IS NULL AND properties IS NOT NULL AND properties != '{}'::jsonb;

        UPDATE product_variants
        SET name = 'Default Variation'
        WHERE name IS NULL AND (properties IS NULL OR properties = '{}'::jsonb);


        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'fk_products_images_product_variant'
                  AND table_name = 'products_images'
            ) THEN
                ALTER TABLE products_images
                    ADD CONSTRAINT fk_products_images_product_variant
                    FOREIGN KEY (product_variant_id)
                    REFERENCES product_variants(id)
                    ON DELETE CASCADE;
            END IF;
        END $$;

        CREATE INDEX IF NOT EXISTS idx_products_images_variant_id ON products_images(product_variant_id);

        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'chk_products_images_media_type'
                  AND table_name = 'products_images'
            ) THEN
                ALTER TABLE products_images
                    ADD CONSTRAINT chk_products_images_media_type
                    CHECK (media_type IN ('image', 'video'));
            END IF;
        END $$;

        -- Drop obsolete uniqueness constraints that block multiple variants of the same product
        ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS idx_unique_cart_product_vendor;
        DROP INDEX IF EXISTS idx_unique_cart_product_vendor;
        ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS unique_cart_product_vendor;
        DROP INDEX IF EXISTS unique_cart_product_vendor;

        -- Drop legacy vendor product constraints/indexes that block multiple variants
        ALTER TABLE vendor_products DROP CONSTRAINT IF EXISTS unique_vendor_product;
        ALTER TABLE vendor_products DROP CONSTRAINT IF EXISTS idx_unique_vendor_product;
        DROP INDEX IF EXISTS idx_unique_vendor_product;

        -- Ensure unique_cart_product_variant_vendor is added
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'unique_cart_product_variant_vendor'
                  AND table_name = 'cart_items'
            ) THEN
                ALTER TABLE cart_items
                    ADD CONSTRAINT unique_cart_product_variant_vendor
                    UNIQUE (cart_id, product_variant_id, vendor_id);
            END IF;
        END $$;
    `);
}
