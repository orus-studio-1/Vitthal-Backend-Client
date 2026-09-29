import fs from "fs";
import path from "path";
import pool from "./DbConnect";

export async function ensureMarketplaceSchema() {
    try {
        const { rows } = await pool.query(`SELECT to_regclass('public.users') as has_users;`);
        if (!rows[0] || !rows[0].has_users) {
            console.log("Base schema missing. Running schema.sql initialization...");
            const schemaPath = path.join(process.cwd(), "schema.sql");
            if (fs.existsSync(schemaPath)) {
                const schemaSql = fs.readFileSync(schemaPath, "utf8");
                await pool.query(schemaSql);
                console.log("Base schema.sql successfully executed!");
            } else {
                console.warn("schema.sql not found at path:", schemaPath);
            }
        }
    } catch (err) {
        console.warn("Initial schema existence check failed, continuing with migration patch:", err);
    }

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
        ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'delivery_agent';

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

        ALTER TYPE quotation_status ADD VALUE IF NOT EXISTS 'token_paid';
        ALTER TYPE quotation_status ADD VALUE IF NOT EXISTS 'dispatch_requested';
        ALTER TYPE quotation_status ADD VALUE IF NOT EXISTS 'dispatched';

        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quotation_message_action') THEN
                CREATE TYPE quotation_message_action AS ENUM ('request', 'offer', 'counter', 'accept', 'reject', 'note');
            END IF;
        END $$;

        ALTER TYPE quotation_message_action ADD VALUE IF NOT EXISTS 'token_paid';
        ALTER TYPE quotation_message_action ADD VALUE IF NOT EXISTS 'dispatch_requested';
        ALTER TYPE quotation_message_action ADD VALUE IF NOT EXISTS 'dispatch_paid';
        ALTER TYPE quotation_message_action ADD VALUE IF NOT EXISTS 'dispatched';

        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
                ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'pending_dispatch';
            END IF;
        END $$;

        DO $$
        BEGIN
            ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notification_reference_type;
            ALTER TABLE notifications
                ADD CONSTRAINT chk_notification_reference_type
                CHECK (reference_type IS NULL OR reference_type IN ('quotation', 'order', 'product', 'service', 'service_quotation', 'service_booking', 'service_ticket'));

            ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notification_type;
            ALTER TABLE notifications
                ADD CONSTRAINT chk_notification_type
                CHECK (type IN (
                    'quotation_request_received',
                    'quotation_offer_received',
                    'quotation_counter_received',
                    'quotation_accepted',
                    'quotation_rejected',
                    'service_completed',
                    'admin_confirmation_sent',
                    'admin_confirmation_accepted',
                    'admin_confirmation_rejected',
                    'product_approved',
                    'product_rejected',
                    'image_approved',
                    'image_rejected',
                    'vendor_product_approved',
                    'vendor_product_rejected',
                    'general'
                ));

            ALTER TABLE services_media ADD COLUMN IF NOT EXISTS s3_key TEXT;
        EXCEPTION
            WHEN OTHERS THEN NULL;
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
            product_id UUID,
            product_variant_id UUID,
            service_id UUID REFERENCES services(id) ON DELETE CASCADE,
            vendor_id UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT unique_wishlist_product_variant UNIQUE (wishlist_id, product_variant_id),
            CONSTRAINT unique_wishlist_service UNIQUE (wishlist_id, service_id),
            CONSTRAINT chk_wishlist_item_type CHECK (
                (product_id IS NOT NULL AND product_variant_id IS NOT NULL AND service_id IS NULL)
                OR
                (service_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL)
            ),
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

            CREATE TABLE IF NOT EXISTS delivery_agents (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                fulfillment_center_id UUID NOT NULL REFERENCES fulfillment_centers(id) ON DELETE CASCADE,
                special_rider_id TEXT NOT NULL UNIQUE,
                contact_phone TEXT,
                vehicle_type TEXT,
                vehicle_number TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                is_online BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_delivery_agents_fc ON delivery_agents(fulfillment_center_id);

            ALTER TABLE order_fulfillment_tracking 
                ADD COLUMN IF NOT EXISTS delivery_agent_id UUID REFERENCES delivery_agents(id) ON DELETE SET NULL;

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

        UPDATE orders o
        SET 
            customer_name = COALESCE(o.customer_name, u.name),
            customer_email = COALESCE(o.customer_email, u.email),
            customer_phone = COALESCE(o.customer_phone, c.phone)
        FROM users u
        LEFT JOIN client c ON u.id = c.user_id
        WHERE o.user_id = u.id
          AND (o.customer_name IS NULL OR o.customer_email IS NULL OR o.customer_phone IS NULL);

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

        CREATE SEQUENCE IF NOT EXISTS quotation_number_seq START WITH 1 INCREMENT BY 1;

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
            booking_ids UUID[] DEFAULT '{}',
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

        -- Service quotation S3 documents and signature updates
        ALTER TABLE service_quotations ADD COLUMN IF NOT EXISTS vendor_document_url TEXT;
        ALTER TABLE service_quotations ADD COLUMN IF NOT EXISTS vendor_document_s3_key TEXT;
        ALTER TABLE service_quotations ADD COLUMN IF NOT EXISTS delivery_days INTEGER;
        ALTER TABLE service_quotations ADD COLUMN IF NOT EXISTS token_percentage NUMERIC(5,2);
        ALTER TABLE service_quotations ADD COLUMN IF NOT EXISTS token_amount NUMERIC(12,2);
        ALTER TABLE service_quotations ADD COLUMN IF NOT EXISTS current_offer_price NUMERIC(12,2);
        ALTER TABLE service_quotations ADD COLUMN IF NOT EXISTS current_offer_by TEXT CHECK (current_offer_by IN ('client', 'vendor'));

        CREATE TABLE IF NOT EXISTS service_quotation_documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            service_quotation_id UUID NOT NULL REFERENCES service_quotations(id) ON DELETE CASCADE,
            quotation_number TEXT NOT NULL UNIQUE,
            document_url TEXT NOT NULL,
            s3_key TEXT NOT NULL,
            valid_until DATE NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_service_quotation_documents_quote_id ON service_quotation_documents(service_quotation_id);

        -- Add default timeline and token money to vendor service offerings
        ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS delivery_days INTEGER;
        ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS token_percentage NUMERIC(5,2);

        -- Add broadcast_group_id to service_quotations for 10-vendor broadcast matching
        ALTER TABLE service_quotations ADD COLUMN IF NOT EXISTS broadcast_group_id UUID;
        CREATE INDEX IF NOT EXISTS idx_service_quotations_broadcast_group ON service_quotations(broadcast_group_id) WHERE broadcast_group_id IS NOT NULL;

        -- Add booking_ids column to payments table
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS booking_ids UUID[] DEFAULT '{}';

        -- Wishlist items service support
        ALTER TABLE wishlist_items ALTER COLUMN product_id DROP NOT NULL;
        ALTER TABLE wishlist_items ALTER COLUMN product_variant_id DROP NOT NULL;
        ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES services(id) ON DELETE CASCADE;

        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'chk_wishlist_item_type'
                  AND table_name = 'wishlist_items'
            ) THEN
                ALTER TABLE wishlist_items
                    ADD CONSTRAINT chk_wishlist_item_type
                    CHECK (
                        (product_id IS NOT NULL AND product_variant_id IS NOT NULL AND service_id IS NULL)
                        OR
                        (service_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL)
                    );
            END IF;
        END $$;

        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.table_constraints
                WHERE constraint_name = 'unique_wishlist_service'
                  AND table_name = 'wishlist_items'
            ) THEN
                ALTER TABLE wishlist_items
                    ADD CONSTRAINT unique_wishlist_service
                    UNIQUE (wishlist_id, service_id);
            END IF;
        END $$;
    `);

    // Pickup flow migration (2026-07-04)
    await pool.query(`
        ALTER TABLE order_route_plan 
            DROP CONSTRAINT IF EXISTS chk_orp_status;

        ALTER TABLE order_route_plan 
            ADD CONSTRAINT chk_orp_status
            CHECK (status IN ('upcoming', 'pickup_pending', 'pickup_assigned', 'in_transit', 'arrived', 'departed'));

        ALTER TABLE order_route_plan 
            ADD COLUMN IF NOT EXISTS pickup_rider_id UUID REFERENCES delivery_agents(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS idx_orp_pickup_status 
            ON order_route_plan(fulfillment_center_id, status) 
            WHERE status IN ('pickup_pending', 'pickup_assigned');

        ALTER TABLE delivery_agents
            ADD COLUMN IF NOT EXISTS current_latitude DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS current_longitude DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS last_located_at TIMESTAMPTZ;

        ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ DEFAULT NULL;

        CREATE TABLE IF NOT EXISTS service_cart_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
            service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
            vendor_service_id UUID NOT NULL REFERENCES vendor_services(id) ON DELETE CASCADE,
            vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
            quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
            price_at_added NUMERIC(12, 2) NOT NULL,
            pricing_type TEXT NOT NULL DEFAULT 'flat',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT unique_cart_vendor_service UNIQUE (cart_id, vendor_service_id)
        );

        -- Unified Subcategories & Product Subcategory Migration (2026-08-25)
        CREATE TABLE IF NOT EXISTS subcategories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            category_id UUID NOT NULL REFERENCES product_category(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT unique_category_subcategory_name UNIQUE (category_id, name)
        );

        CREATE INDEX IF NOT EXISTS idx_subcategories_category_id ON subcategories(category_id);

        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'service_subcategories') THEN
                INSERT INTO subcategories (id, category_id, name, description, created_at, updated_at)
                SELECT id, category_id, name, description, created_at, updated_at
                FROM service_subcategories
                ON CONFLICT (category_id, name) DO NOTHING;
            END IF;
        END $$;

        ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory_id UUID;

        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints
                WHERE constraint_name = 'fk_products_subcategory'
                  AND table_name = 'products'
            ) THEN
                ALTER TABLE products
                    ADD CONSTRAINT fk_products_subcategory
                    FOREIGN KEY (subcategory_id)
                    REFERENCES subcategories(id)
                    ON DELETE SET NULL;
            END IF;
        END $$;

        CREATE INDEX IF NOT EXISTS idx_products_subcategory_id ON products(subcategory_id);

        -- ═══════════════════════════════════════════════════════════════
        -- Employee Hiring & Staffing Module (2026-08-29)
        -- ═══════════════════════════════════════════════════════════════

        CREATE TABLE IF NOT EXISTS employee_candidates (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            full_name           TEXT NOT NULL,
            email               TEXT,
            phone               VARCHAR(20) NOT NULL,
            city                TEXT,
            state               TEXT,
            pincode             VARCHAR(10),
            address_line        TEXT,
            designation         TEXT,
            experience_years    NUMERIC(4,1) DEFAULT 0,
            skills              JSONB NOT NULL DEFAULT '[]',
            metadata            JSONB NOT NULL DEFAULT '{}',
            photo_url           TEXT,
            verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
            rejection_reason    TEXT,
            verified_at         TIMESTAMPTZ,
            verified_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            is_available        BOOLEAN NOT NULL DEFAULT true,
            commission_percentage NUMERIC(5,2) NOT NULL DEFAULT 0.00,
            registered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_emp_cand_status ON employee_candidates(verification_status);
        CREATE INDEX IF NOT EXISTS idx_emp_cand_city ON employee_candidates(city);
        CREATE INDEX IF NOT EXISTS idx_emp_cand_skills ON employee_candidates USING GIN (skills);
        CREATE INDEX IF NOT EXISTS idx_emp_cand_phone ON employee_candidates(phone);

        CREATE TABLE IF NOT EXISTS employee_documents (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            candidate_id        UUID NOT NULL REFERENCES employee_candidates(id) ON DELETE CASCADE,
            doc_type            VARCHAR(50) NOT NULL,
            doc_number          VARCHAR(100),
            doc_url             TEXT NOT NULL,
            doc_name            TEXT,
            metadata            JSONB NOT NULL DEFAULT '{}',
            uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_emp_doc_candidate ON employee_documents(candidate_id);
        CREATE INDEX IF NOT EXISTS idx_emp_doc_type ON employee_documents(doc_type);

        CREATE TABLE IF NOT EXISTS hire_requests (
            id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            candidate_id            UUID NOT NULL REFERENCES employee_candidates(id) ON DELETE CASCADE,
            requested_by_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status                  VARCHAR(20) NOT NULL DEFAULT 'pending',
            request_details         JSONB NOT NULL DEFAULT '{}',
            admin_notes             TEXT,
            reviewed_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
            reviewed_at             TIMESTAMPTZ,
            created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_hire_req_candidate ON hire_requests(candidate_id);
        CREATE INDEX IF NOT EXISTS idx_hire_req_user ON hire_requests(requested_by_user_id);
        CREATE INDEX IF NOT EXISTS idx_hire_req_status ON hire_requests(status);

        -- ═══════════════════════════════════════════════════════════════
        -- Universal B2B Service Hub & Asset Registry (2026-08-29)
        -- ═══════════════════════════════════════════════════════════════

        ALTER TABLE subcategories 
            ADD COLUMN IF NOT EXISTS form_schema JSONB DEFAULT '[]';

        CREATE TABLE IF NOT EXISTS client_assets (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            category_id         UUID REFERENCES product_category(id) ON DELETE SET NULL,
            subcategory_id      UUID REFERENCES subcategories(id) ON DELETE SET NULL,
            asset_name          TEXT NOT NULL,
            asset_code          VARCHAR(100),
            brand               TEXT,
            model_number        TEXT,
            serial_number       TEXT,
            installation_year   INTEGER,
            specs               JSONB NOT NULL DEFAULT '{}',
            location_details    JSONB NOT NULL DEFAULT '{}',
            documents           JSONB NOT NULL DEFAULT '[]',
            is_active           BOOLEAN NOT NULL DEFAULT true,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_client_assets_user ON client_assets(user_id);
        CREATE INDEX IF NOT EXISTS idx_client_assets_category ON client_assets(category_id);
        CREATE INDEX IF NOT EXISTS idx_client_assets_specs ON client_assets USING GIN (specs);

        CREATE TABLE IF NOT EXISTS service_tickets (
            id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            ticket_number           VARCHAR(50) NOT NULL UNIQUE,
            category_id             UUID NOT NULL REFERENCES product_category(id) ON DELETE RESTRICT,
            subcategory_id          UUID REFERENCES subcategories(id) ON DELETE SET NULL,
            client_user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            vendor_id               UUID REFERENCES vendors(id) ON DELETE SET NULL,
            assigned_agent_id       UUID REFERENCES users(id) ON DELETE SET NULL,
            asset_id                UUID REFERENCES client_assets(id) ON DELETE SET NULL,
            status                  VARCHAR(30) NOT NULL DEFAULT 'draft',
            priority                VARCHAR(20) NOT NULL DEFAULT 'medium',
            ticket_payload          JSONB NOT NULL DEFAULT '{}',
            quotation_breakdown     JSONB NOT NULL DEFAULT '{}',
            total_amount            NUMERIC(12,2) DEFAULT 0.00,
            advance_paid            NUMERIC(12,2) DEFAULT 0.00,
            completion_otp          VARCHAR(6),
            otp_verified_at         TIMESTAMPTZ,
            timeline_logs           JSONB NOT NULL DEFAULT '[]',
            created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_srv_tickets_client ON service_tickets(client_user_id);
        CREATE INDEX IF NOT EXISTS idx_srv_tickets_vendor ON service_tickets(vendor_id);
        CREATE INDEX IF NOT EXISTS idx_srv_tickets_status ON service_tickets(status);
        CREATE INDEX IF NOT EXISTS idx_srv_tickets_cat ON service_tickets(category_id);
        CREATE INDEX IF NOT EXISTS idx_srv_tickets_payload ON service_tickets USING GIN (ticket_payload);

        CREATE TABLE IF NOT EXISTS service_ticket_quotations (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            ticket_id        UUID NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
            vendor_id        UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
            status           VARCHAR(20) NOT NULL DEFAULT 'submitted',
            quote_breakdown  JSONB NOT NULL DEFAULT '{}',
            total_price      NUMERIC(12,2) NOT NULL,
            token_percentage NUMERIC(5,2) DEFAULT 0.00,
            token_amount     NUMERIC(12,2) DEFAULT 0.00,
            valid_until      TIMESTAMPTZ,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_srv_ticket_quotes_ticket ON service_ticket_quotations(ticket_id);
        CREATE INDEX IF NOT EXISTS idx_srv_ticket_quotes_vendor ON service_ticket_quotations(vendor_id);

        CREATE TABLE IF NOT EXISTS service_ticket_documents (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            ticket_id           UUID NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
            doc_type            VARCHAR(50) NOT NULL,
            doc_name            TEXT,
            doc_url             TEXT NOT NULL,
            uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            metadata            JSONB NOT NULL DEFAULT '{}',
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_srv_ticket_docs_ticket ON service_ticket_documents(ticket_id);
    `);
}
