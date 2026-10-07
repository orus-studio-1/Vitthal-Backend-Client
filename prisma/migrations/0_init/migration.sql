-- Baseline: full schema as of commit 15544d6 (legacy/schema.sql + legacy/DbSetup.ts + legacy/migrations/*.sql),
-- captured in the steady state an existing database reaches after repeated boots.
-- Generated with pg_dump so CHECK constraints, partial indexes and triggers are preserved.
-- Existing databases are marked as having applied this (not re-run) by DbMigrate.ts: see prisma/README.md.

--
-- PostgreSQL database dump
--

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- Name: cart_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cart_type AS ENUM (
    'direct',
    'quotation'
);

--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status AS ENUM (
    'pending',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded',
    'handed_over',
    'received',
    'dispatched',
    'pending_dispatch'
);

--
-- Name: quotation_message_action; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.quotation_message_action AS ENUM (
    'request',
    'offer',
    'counter',
    'accept',
    'reject',
    'note',
    'admin_confirm_request',
    'admin_confirmed',
    'admin_rejected',
    'token_paid',
    'dispatch_requested',
    'dispatch_paid',
    'dispatched'
);

--
-- Name: quotation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.quotation_status AS ENUM (
    'pending_vendor',
    'vendor_offered',
    'vendor_countered',
    'client_countered',
    'client_accepted',
    'client_rejected',
    'vendor_rejected',
    'cancelled',
    'expired',
    'admin_confirmation_pending',
    'admin_confirmed',
    'admin_confirmation_rejected',
    'token_paid',
    'dispatch_requested',
    'dispatched'
);

--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'client',
    'worker',
    'vendor',
    'admin',
    'super_admin',
    'fulfillment_center',
    'delivery_agent'
);

--
-- Name: vendor_approval_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.vendor_approval_status AS ENUM (
    'pending',
    'agreement_sent',
    'approved',
    'rejected'
);

--
-- Name: vendor_product_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.vendor_product_status AS ENUM (
    'active',
    'inactive',
    'out_of_stock',
    'discontinued',
    'waiting'
);

--
-- Name: enforce_vendor_category_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_vendor_category_limit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    category_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO category_count
    FROM vendor_categories
    WHERE vendor_id = NEW.vendor_id;

    IF category_count >= 3 THEN
        RAISE EXCEPTION 'A vendor can select up to 3 categories only';
    END IF;

    RETURN NEW;
END;
$$;

--
-- Name: abandoned_reminder_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.abandoned_reminder_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_type text NOT NULL,
    source_item_id uuid NOT NULL,
    reminder_type text DEFAULT '24h_abandoned_reminder'::text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT abandoned_reminder_logs_source_type_check CHECK ((source_type = ANY (ARRAY['cart'::text, 'wishlist'::text])))
);

--
-- Name: addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    address text NOT NULL,
    address_line1 text,
    address_line2 text,
    landmark text,
    address_phone text,
    city text NOT NULL,
    state text NOT NULL,
    country text NOT NULL,
    pincode character varying(6) NOT NULL,
    latitude double precision,
    longitude double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT addresses_latitude_check CHECK (((latitude >= ('-90'::integer)::double precision) AND (latitude <= (90)::double precision))),
    CONSTRAINT addresses_longitude_check CHECK (((longitude >= ('-180'::integer)::double precision) AND (longitude <= (180)::double precision))),
    CONSTRAINT addresses_pincode_check CHECK (((pincode)::text ~ '^[0-9]{6}$'::text))
);

--
-- Name: cart_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cart_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cart_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_variant_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    quantity integer NOT NULL,
    price_at_added numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cart_items_quantity_check CHECK ((quantity > 0))
);

--
-- Name: carts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.carts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    cart_type public.cart_type DEFAULT 'direct'::public.cart_type NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    total_amount numeric(12,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: client; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: client_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    category_id uuid,
    subcategory_id uuid,
    asset_name text NOT NULL,
    asset_code character varying(100),
    brand text,
    model_number text,
    serial_number text,
    installation_year integer,
    specs jsonb DEFAULT '{}'::jsonb NOT NULL,
    location_details jsonb DEFAULT '{}'::jsonb NOT NULL,
    documents jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: contact_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_queries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email public.citext NOT NULL,
    company text,
    phone text,
    subject text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: delivery_agent_kyc; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_agent_kyc (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    delivery_agent_id uuid NOT NULL,
    kyc_status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    id_doc_type character varying(50) NOT NULL,
    id_doc_number character varying(100) NOT NULL,
    id_doc_image_url text,
    bank_name character varying(100) NOT NULL,
    account_number character varying(50) NOT NULL,
    ifsc_code character varying(20) NOT NULL,
    account_holder_name character varying(100) NOT NULL,
    rejection_reason text,
    submitted_at timestamp with time zone DEFAULT now(),
    reviewed_at timestamp with time zone,
    reviewed_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

--
-- Name: delivery_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    fulfillment_center_id uuid NOT NULL,
    special_rider_id text NOT NULL,
    contact_phone text,
    vehicle_type text,
    vehicle_number text,
    status text DEFAULT 'active'::text NOT NULL,
    is_online boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    current_latitude double precision,
    current_longitude double precision,
    last_located_at timestamp with time zone,
    kyc_status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    push_token text
);

--
-- Name: employee_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    email text,
    phone character varying(20) NOT NULL,
    city text,
    state text,
    pincode character varying(10),
    address_line text,
    designation text,
    experience_years numeric(4,1) DEFAULT 0,
    skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    photo_url text,
    verification_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    rejection_reason text,
    verified_at timestamp with time zone,
    verified_by_user_id uuid,
    is_available boolean DEFAULT true NOT NULL,
    commission_percentage numeric(5,2) DEFAULT 0.00 NOT NULL,
    registered_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: employee_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid NOT NULL,
    doc_type character varying(50) NOT NULL,
    doc_number character varying(100),
    doc_url text NOT NULL,
    doc_name text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    uploaded_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: fulfillment_centers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_centers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    contact_phone text,
    contact_email public.citext,
    manager_name text,
    address text NOT NULL,
    city text NOT NULL,
    state text NOT NULL,
    country text NOT NULL,
    pincode character varying(6) NOT NULL,
    latitude double precision,
    longitude double precision,
    total_area_sqft numeric(10,2),
    capacity_packages integer,
    storage_type text,
    operating_hours text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fulfillment_centers_latitude_check CHECK (((latitude >= ('-90'::integer)::double precision) AND (latitude <= (90)::double precision))),
    CONSTRAINT fulfillment_centers_longitude_check CHECK (((longitude >= ('-180'::integer)::double precision) AND (longitude <= (180)::double precision))),
    CONSTRAINT fulfillment_centers_pincode_check CHECK (((pincode)::text ~ '^[0-9]{6}$'::text))
);

--
-- Name: hire_request_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hire_request_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hire_request_id uuid NOT NULL,
    sender_user_id uuid NOT NULL,
    sender_role character varying(20) NOT NULL,
    message_type character varying(50) DEFAULT 'message'::character varying NOT NULL,
    body text NOT NULL,
    proposed_amount numeric(12,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: hire_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hire_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid NOT NULL,
    requested_by_user_id uuid NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    request_details jsonb DEFAULT '{}'::jsonb NOT NULL,
    admin_notes text,
    reviewed_by_user_id uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    proposed_amount numeric(12,2),
    agreed_amount numeric(12,2),
    negotiation_status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    negotiation_proposed_by uuid,
    contract_status character varying(20) DEFAULT 'pending_payment'::character varying NOT NULL,
    client_completed_at timestamp with time zone,
    worker_completed_at timestamp with time zone,
    completed_at timestamp with time zone,
    latest_offer_id uuid,
    agreed_at timestamp with time zone,
    paid_at timestamp with time zone
);

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    reference_type text,
    reference_id uuid,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_notification_reference_type CHECK (((reference_type IS NULL) OR (reference_type = ANY (ARRAY['quotation'::text, 'order'::text, 'product'::text, 'service'::text, 'service_quotation'::text, 'service_booking'::text, 'service_ticket'::text])))),
    CONSTRAINT chk_notification_type CHECK ((type = ANY (ARRAY['quotation_request_received'::text, 'quotation_offer_received'::text, 'quotation_counter_received'::text, 'quotation_accepted'::text, 'quotation_rejected'::text, 'service_completed'::text, 'admin_confirmation_sent'::text, 'admin_confirmation_accepted'::text, 'admin_confirmation_rejected'::text, 'product_approved'::text, 'product_rejected'::text, 'image_approved'::text, 'image_rejected'::text, 'vendor_product_approved'::text, 'vendor_product_rejected'::text, 'general'::text])))
);

--
-- Name: order_fulfillment_tracking; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_fulfillment_tracking (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    fulfillment_center_id uuid,
    delivery_agent_id uuid,
    status public.order_status NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    stop_sequence integer,
    location_label text
);

--
-- Name: order_item_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    user_id uuid NOT NULL,
    product_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    rating integer NOT NULL,
    review_title text,
    review_text text,
    is_verified_purchase boolean DEFAULT true NOT NULL,
    images text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_item_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);

--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_variant_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    quantity integer NOT NULL,
    price numeric(12,2) NOT NULL,
    original_price numeric(12,2) DEFAULT NULL::numeric,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT order_items_quantity_check CHECK ((quantity > 0))
);

--
-- Name: order_route_plan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_route_plan (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    fulfillment_center_id uuid NOT NULL,
    stop_sequence integer NOT NULL,
    center_name text NOT NULL,
    center_city text NOT NULL,
    center_state text NOT NULL,
    center_pincode character varying(6),
    center_latitude double precision,
    center_longitude double precision,
    estimated_arrival timestamp with time zone,
    actual_arrival timestamp with time zone,
    status text DEFAULT 'upcoming'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    pickup_rider_id uuid,
    CONSTRAINT chk_orp_status CHECK ((status = ANY (ARRAY['upcoming'::text, 'pickup_pending'::text, 'pickup_assigned'::text, 'in_transit'::text, 'arrived'::text, 'departed'::text])))
);

--
-- Name: order_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_status_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    status public.order_status NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    cart_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    payment_status text DEFAULT 'pending'::text,
    order_type text DEFAULT 'direct'::text NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    source text DEFAULT 'client'::text NOT NULL,
    order_reference text,
    order_notes text,
    customer_name text,
    customer_email text,
    customer_phone text,
    created_by_admin_id text,
    address_line text NOT NULL,
    city text NOT NULL,
    state text NOT NULL,
    country text NOT NULL,
    pincode character varying(6) NOT NULL,
    latitude text NOT NULL,
    langitude text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    vendor_city text,
    vendor_state text,
    vendor_latitude double precision,
    vendor_longitude double precision,
    pickup_otp character varying(6),
    pickup_qr_token character varying(255),
    delivery_otp character varying(6),
    delivery_qr_token character varying(255)
);

--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency character varying(10) DEFAULT 'INR'::character varying,
    status character varying(50) DEFAULT 'pending'::character varying,
    payment_method character varying(50) DEFAULT 'razorpay'::character varying,
    razorpay_order_id character varying(255),
    razorpay_payment_id character varying(255),
    razorpay_signature text,
    order_ids uuid[] DEFAULT '{}'::uuid[],
    booking_ids uuid[] DEFAULT '{}'::uuid[],
    quotation_request_id uuid,
    split_number integer DEFAULT 1,
    split_percentage numeric(5,2) DEFAULT 100.00,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    hire_request_id uuid,
    payment_type character varying(30) DEFAULT 'marketplace'::character varying NOT NULL
);

--
-- Name: product_category; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_category (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    description text,
    image text NOT NULL,
    min_commision_percentage integer DEFAULT 0 NOT NULL,
    max_commision_percentage integer DEFAULT 10 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category_type text DEFAULT 'product'::text,
    CONSTRAINT chk_category_type CHECK ((category_type = ANY (ARRAY['product'::text, 'service'::text, 'both'::text])))
);

--
-- Name: product_specification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_specification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    spec_key text NOT NULL,
    spec_value text,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    approval_notes text,
    created_by_user_id uuid NOT NULL,
    reviewed_by_user_id uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_product_specification_status CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

--
-- Name: product_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_variants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    sku text,
    properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    approval_status text DEFAULT 'approved'::text NOT NULL,
    approval_notes text,
    created_by_user_id uuid,
    reviewed_by_user_id uuid,
    reviewed_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    CONSTRAINT chk_product_variants_approval_status CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    category uuid NOT NULL,
    product_type text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    item_code text,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    approval_notes text,
    created_by_user_id uuid,
    is_active boolean DEFAULT false NOT NULL,
    quotation_limit integer,
    vendor_can_set_quotation_limit boolean DEFAULT false NOT NULL,
    rating numeric(2,1) DEFAULT 0 NOT NULL,
    review_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    subcategory_id uuid,
    specifications jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT products_quotation_limit_check CHECK ((quotation_limit > 0)),
    CONSTRAINT products_rating_check CHECK (((rating >= (0)::numeric) AND (rating <= (5)::numeric)))
);

--
-- Name: products_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products_images (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    image_url text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    is_approved boolean DEFAULT false NOT NULL,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    created_by_user_id uuid,
    reviewed_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    media_type text DEFAULT 'image'::text,
    product_variant_id uuid,
    CONSTRAINT chk_products_images_media_type CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text]))),
    CONSTRAINT chk_products_images_status CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

--
-- Name: quotation_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotation_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_group_id uuid NOT NULL,
    quotation_number text NOT NULL,
    document_url text NOT NULL,
    s3_key text NOT NULL,
    valid_until date NOT NULL,
    product_id uuid NOT NULL,
    user_id uuid NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: quotation_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotation_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_id uuid NOT NULL,
    sender_user_id uuid NOT NULL,
    sender_role text NOT NULL,
    action public.quotation_message_action NOT NULL,
    offer_price numeric(12,2),
    offer_quantity integer,
    note text,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_quotation_sender_role CHECK ((sender_role = ANY (ARRAY['client'::text, 'vendor'::text, 'admin'::text]))),
    CONSTRAINT quotation_messages_offer_price_check CHECK ((offer_price >= (0)::numeric)),
    CONSTRAINT quotation_messages_offer_quantity_check CHECK ((offer_quantity > 0))
);

--
-- Name: quotation_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quotation_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: quotation_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotation_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_variant_id uuid NOT NULL,
    requested_quantity integer NOT NULL,
    requested_price numeric(12,2),
    status public.quotation_status DEFAULT 'pending_vendor'::public.quotation_status NOT NULL,
    request_note text,
    buyer_city text,
    buyer_state text,
    buyer_country text,
    buyer_pincode character varying(6),
    current_offer_price numeric(12,2),
    current_offer_quantity integer,
    current_offer_by text,
    accepted_price numeric(12,2),
    accepted_quantity integer,
    rejection_reason text,
    order_id uuid,
    admin_confirmation_status text,
    admin_confirmation_message text,
    admin_confirmed_at timestamp with time zone,
    admin_user_id uuid,
    quotation_group_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_days integer,
    token_percentage numeric(5,2),
    token_amount numeric(12,2),
    vendor_document_url text,
    vendor_document_s3_key text,
    CONSTRAINT chk_admin_confirmation_status CHECK (((admin_confirmation_status IS NULL) OR (admin_confirmation_status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text])))),
    CONSTRAINT chk_quotation_offer_by CHECK (((current_offer_by IS NULL) OR (current_offer_by = ANY (ARRAY['client'::text, 'vendor'::text])))),
    CONSTRAINT quotation_requests_accepted_price_check CHECK ((accepted_price >= (0)::numeric)),
    CONSTRAINT quotation_requests_accepted_quantity_check CHECK ((accepted_quantity > 0)),
    CONSTRAINT quotation_requests_current_offer_price_check CHECK ((current_offer_price >= (0)::numeric)),
    CONSTRAINT quotation_requests_current_offer_quantity_check CHECK ((current_offer_quantity > 0)),
    CONSTRAINT quotation_requests_delivery_days_check CHECK ((delivery_days > 0)),
    CONSTRAINT quotation_requests_requested_price_check CHECK ((requested_price >= (0)::numeric)),
    CONSTRAINT quotation_requests_requested_quantity_check CHECK ((requested_quantity > 0)),
    CONSTRAINT quotation_requests_token_amount_check CHECK ((token_amount >= (0)::numeric)),
    CONSTRAINT quotation_requests_token_percentage_check CHECK (((token_percentage >= (0)::numeric) AND (token_percentage <= (100)::numeric)))
);

--
-- Name: rider_earnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rider_earnings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    delivery_agent_id uuid NOT NULL,
    order_id uuid,
    order_reference character varying(100),
    leg_type character varying(50) NOT NULL,
    amount numeric(10,2) NOT NULL,
    status character varying(50) DEFAULT 'credited'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    id integer NOT NULL,
    filename character varying(255) NOT NULL,
    executed_at timestamp with time zone DEFAULT now()
);

--
-- Name: schema_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schema_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: schema_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schema_migrations_id_seq OWNED BY public.schema_migrations.id;

--
-- Name: service_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    vendor_service_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payment_status text DEFAULT 'pending'::text NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    scheduled_start timestamp with time zone,
    scheduled_end timestamp with time zone,
    booking_notes text,
    completion_otp_hash character varying(64) DEFAULT NULL::character varying,
    completion_otp_failed_attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completion_otp_expires_at timestamp with time zone,
    CONSTRAINT chk_bookings_payment CHECK ((payment_status = ANY (ARRAY['pending'::text, 'paid'::text, 'refunded'::text]))),
    CONSTRAINT chk_bookings_status CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text])))
);

--
-- Name: service_cart_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_cart_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cart_id uuid NOT NULL,
    service_id uuid NOT NULL,
    vendor_service_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    price_at_added numeric(12,2) NOT NULL,
    pricing_type text DEFAULT 'flat'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_cart_items_quantity_check CHECK ((quantity > 0))
);

--
-- Name: service_quotation_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_quotation_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_quotation_id uuid NOT NULL,
    quotation_number text NOT NULL,
    document_url text NOT NULL,
    s3_key text NOT NULL,
    valid_until date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: service_quotation_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_quotation_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_id uuid NOT NULL,
    sender_user_id uuid NOT NULL,
    sender_role text NOT NULL,
    action public.quotation_message_action NOT NULL,
    offer_price numeric(12,2),
    note text,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_service_quotation_sender_role CHECK ((sender_role = ANY (ARRAY['client'::text, 'vendor'::text, 'admin'::text]))),
    CONSTRAINT service_quotation_messages_offer_price_check CHECK ((offer_price >= (0)::numeric))
);

--
-- Name: service_quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_quotations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    service_id uuid NOT NULL,
    scope_of_work text NOT NULL,
    requested_price numeric(12,2),
    status text DEFAULT 'pending_vendor'::text NOT NULL,
    agreed_price numeric(12,2),
    booking_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    vendor_document_url text,
    vendor_document_s3_key text,
    delivery_days integer,
    token_percentage numeric(5,2),
    token_amount numeric(12,2),
    current_offer_price numeric(12,2),
    current_offer_by text,
    broadcast_group_id uuid,
    CONSTRAINT service_quotations_agreed_price_check CHECK ((agreed_price >= (0)::numeric)),
    CONSTRAINT service_quotations_current_offer_by_check CHECK ((current_offer_by = ANY (ARRAY['client'::text, 'vendor'::text]))),
    CONSTRAINT service_quotations_requested_price_check CHECK ((requested_price >= (0)::numeric))
);

--
-- Name: service_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    user_id uuid NOT NULL,
    service_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    rating integer NOT NULL,
    review_title text,
    review_text text,
    images text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);

--
-- Name: service_subcategories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_subcategories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: service_ticket_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_ticket_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    doc_type character varying(50) NOT NULL,
    doc_name text,
    doc_url text NOT NULL,
    uploaded_by_user_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: service_ticket_quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_ticket_quotations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    status character varying(20) DEFAULT 'submitted'::character varying NOT NULL,
    quote_breakdown jsonb DEFAULT '{}'::jsonb NOT NULL,
    total_price numeric(12,2) NOT NULL,
    token_percentage numeric(5,2) DEFAULT 0.00,
    token_amount numeric(12,2) DEFAULT 0.00,
    valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: service_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_number character varying(50) NOT NULL,
    category_id uuid NOT NULL,
    subcategory_id uuid,
    client_user_id uuid NOT NULL,
    vendor_id uuid,
    assigned_agent_id uuid,
    asset_id uuid,
    status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    ticket_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    quotation_breakdown jsonb DEFAULT '{}'::jsonb NOT NULL,
    total_amount numeric(12,2) DEFAULT 0.00,
    advance_paid numeric(12,2) DEFAULT 0.00,
    completion_otp character varying(6),
    otp_verified_at timestamp with time zone,
    timeline_logs jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    category_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by_user_id uuid,
    is_active boolean DEFAULT false NOT NULL,
    rating numeric(2,1) DEFAULT 0 NOT NULL,
    review_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    subcategory_id uuid,
    CONSTRAINT chk_services_status CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT services_rating_check CHECK (((rating >= (0)::numeric) AND (rating <= (5)::numeric)))
);

--
-- Name: services_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.services_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_id uuid NOT NULL,
    media_url text NOT NULL,
    media_type text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    is_approved boolean DEFAULT false NOT NULL,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    created_by_user_id uuid,
    reviewed_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    s3_key text,
    CONSTRAINT chk_services_media_status CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT chk_services_media_type CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text])))
);

--
-- Name: subcategories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subcategories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    form_schema jsonb DEFAULT '[]'::jsonb
);

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email public.citext NOT NULL,
    password_hash text NOT NULL,
    role public.user_role DEFAULT 'client'::public.user_role NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    otp text,
    refresh_token text,
    otp_expiry timestamp with time zone,
    is_verified boolean DEFAULT false NOT NULL,
    deletion_requested_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: vendor_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    category_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: vendor_chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    sender_user_id uuid NOT NULL,
    sender_role text NOT NULL,
    body text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_vendor_chat_sender_role CHECK ((sender_role = ANY (ARRAY['vendor'::text, 'admin'::text, 'super_admin'::text])))
);

--
-- Name: vendor_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    payout_percentage numeric(5,2) DEFAULT 0.00 NOT NULL,
    payout_amount numeric(12,2) DEFAULT 0.00 NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    delivered_at timestamp with time zone,
    due_date timestamp with time zone,
    last_paid_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

--
-- Name: vendor_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    product_variant_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    price numeric(12,2) NOT NULL,
    moq integer NOT NULL,
    stock_quantity integer DEFAULT 0 NOT NULL,
    quotation_enabled boolean DEFAULT false NOT NULL,
    quotation_min_qty integer,
    commision_percentage integer DEFAULT 0,
    is_active boolean DEFAULT false NOT NULL,
    status public.vendor_product_status DEFAULT 'waiting'::public.vendor_product_status NOT NULL,
    gst_percentage numeric(5,2) DEFAULT 0.00,
    pending_price numeric(12,2) DEFAULT NULL::numeric,
    discounted_price numeric(12,2) DEFAULT NULL::numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vendor_products_commision_percentage_check CHECK (((commision_percentage >= 0) AND (commision_percentage <= 100))),
    CONSTRAINT vendor_products_discounted_price_check CHECK ((discounted_price >= (0)::numeric)),
    CONSTRAINT vendor_products_moq_check CHECK ((moq > 0)),
    CONSTRAINT vendor_products_pending_price_check CHECK ((pending_price >= (0)::numeric)),
    CONSTRAINT vendor_products_price_check CHECK ((price >= (0)::numeric)),
    CONSTRAINT vendor_products_quotation_min_qty_check CHECK ((quotation_min_qty > 0)),
    CONSTRAINT vendor_products_stock_quantity_check CHECK ((stock_quantity >= 0))
);

--
-- Name: vendor_quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_quotations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_number text NOT NULL,
    vendor_id uuid NOT NULL,
    created_by_admin_id uuid NOT NULL,
    sent_to_email public.citext NOT NULL,
    title text NOT NULL,
    quantity numeric(12,2) NOT NULL,
    unit text NOT NULL,
    target_price numeric(12,2),
    requested_moq integer,
    request_notes text,
    validity_date timestamp with time zone,
    status text DEFAULT 'sent'::text NOT NULL,
    vendor_price numeric(12,2),
    vendor_moq integer,
    vendor_notes text,
    admin_signature_data text NOT NULL,
    vendor_signature_data text,
    token_hash text NOT NULL,
    token_expires_at timestamp with time zone NOT NULL,
    vendor_opened_at timestamp with time zone,
    vendor_responded_at timestamp with time zone,
    vendor_response_ip text,
    vendor_response_user_agent text,
    admin_reviewed_at timestamp with time zone,
    reviewed_by_admin_id uuid,
    admin_review_notes text,
    vendor_rejection_reason text,
    email_sent_at timestamp with time zone,
    email_last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_vendor_quotation_status CHECK ((status = ANY (ARRAY['sent'::text, 'vendor_opened'::text, 'vendor_approved'::text, 'vendor_rejected'::text, 'admin_approved'::text, 'admin_rejected'::text]))),
    CONSTRAINT vendor_quotations_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT vendor_quotations_requested_moq_check CHECK ((requested_moq > 0)),
    CONSTRAINT vendor_quotations_target_price_check CHECK ((target_price >= (0)::numeric)),
    CONSTRAINT vendor_quotations_vendor_moq_check CHECK ((vendor_moq > 0)),
    CONSTRAINT vendor_quotations_vendor_price_check CHECK ((vendor_price >= (0)::numeric))
);

--
-- Name: vendor_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    user_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    rating integer NOT NULL,
    review_title text,
    review_text text,
    is_verified_purchase boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vendor_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);

--
-- Name: vendor_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    pricing_type text DEFAULT 'flat'::text NOT NULL,
    price numeric(12,2) NOT NULL,
    moq integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_days integer,
    token_percentage numeric(5,2),
    CONSTRAINT chk_vendor_services_pricing CHECK ((pricing_type = ANY (ARRAY['hourly'::text, 'project'::text, 'milestone'::text, 'flat'::text]))),
    CONSTRAINT vendor_services_moq_check CHECK ((moq > 0)),
    CONSTRAINT vendor_services_price_check CHECK ((price >= (0)::numeric))
);

--
-- Name: vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    company_name text NOT NULL,
    gst_number text,
    gst_certificate_link text,
    vendor_signature_image_link text,
    business_type text,
    company_website text,
    phone text,
    alternative_number text,
    designation text,
    business_description text,
    credit_cycle text,
    minimum_commision_percentage integer DEFAULT 0,
    maximum_commision_percentage integer DEFAULT 0,
    application_number text,
    rating numeric(2,1) DEFAULT 0 NOT NULL,
    review_count integer DEFAULT 0 NOT NULL,
    is_approved boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_blocked boolean DEFAULT false NOT NULL,
    approval_status public.vendor_approval_status DEFAULT 'pending'::public.vendor_approval_status NOT NULL,
    approval_notes text,
    vendor_type text DEFAULT 'product'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reconsideration_notes text,
    CONSTRAINT vendors_rating_check CHECK (((rating >= (0)::numeric) AND (rating <= (5)::numeric))),
    CONSTRAINT vendors_vendor_type_check CHECK ((vendor_type = ANY (ARRAY['product'::text, 'service'::text, 'both'::text])))
);

--
-- Name: wishlist_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wishlist_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wishlist_id uuid NOT NULL,
    product_id uuid,
    product_variant_id uuid,
    service_id uuid,
    vendor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_wishlist_item_type CHECK ((((product_id IS NOT NULL) AND (product_variant_id IS NOT NULL) AND (service_id IS NULL)) OR ((service_id IS NOT NULL) AND (product_id IS NULL) AND (product_variant_id IS NULL))))
);

--
-- Name: wishlists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wishlists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: schema_migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations ALTER COLUMN id SET DEFAULT nextval('public.schema_migrations_id_seq'::regclass);

--
-- Name: abandoned_reminder_logs abandoned_reminder_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abandoned_reminder_logs
    ADD CONSTRAINT abandoned_reminder_logs_pkey PRIMARY KEY (id);

--
-- Name: addresses addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_pkey PRIMARY KEY (id);

--
-- Name: cart_items cart_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_pkey PRIMARY KEY (id);

--
-- Name: carts carts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_pkey PRIMARY KEY (id);

--
-- Name: client_assets client_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_assets
    ADD CONSTRAINT client_assets_pkey PRIMARY KEY (id);

--
-- Name: client client_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_pkey PRIMARY KEY (id);

--
-- Name: client client_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_user_id_key UNIQUE (user_id);

--
-- Name: contact_queries contact_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_queries
    ADD CONSTRAINT contact_queries_pkey PRIMARY KEY (id);

--
-- Name: delivery_agent_kyc delivery_agent_kyc_delivery_agent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_agent_kyc
    ADD CONSTRAINT delivery_agent_kyc_delivery_agent_id_key UNIQUE (delivery_agent_id);

--
-- Name: delivery_agent_kyc delivery_agent_kyc_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_agent_kyc
    ADD CONSTRAINT delivery_agent_kyc_pkey PRIMARY KEY (id);

--
-- Name: delivery_agents delivery_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_agents
    ADD CONSTRAINT delivery_agents_pkey PRIMARY KEY (id);

--
-- Name: delivery_agents delivery_agents_special_rider_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_agents
    ADD CONSTRAINT delivery_agents_special_rider_id_key UNIQUE (special_rider_id);

--
-- Name: delivery_agents delivery_agents_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_agents
    ADD CONSTRAINT delivery_agents_user_id_key UNIQUE (user_id);

--
-- Name: employee_candidates employee_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_candidates
    ADD CONSTRAINT employee_candidates_pkey PRIMARY KEY (id);

--
-- Name: employee_documents employee_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_pkey PRIMARY KEY (id);

--
-- Name: fulfillment_centers fulfillment_centers_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_centers
    ADD CONSTRAINT fulfillment_centers_code_key UNIQUE (code);

--
-- Name: fulfillment_centers fulfillment_centers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_centers
    ADD CONSTRAINT fulfillment_centers_pkey PRIMARY KEY (id);

--
-- Name: fulfillment_centers fulfillment_centers_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_centers
    ADD CONSTRAINT fulfillment_centers_user_id_key UNIQUE (user_id);

--
-- Name: hire_request_messages hire_request_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hire_request_messages
    ADD CONSTRAINT hire_request_messages_pkey PRIMARY KEY (id);

--
-- Name: hire_requests hire_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hire_requests
    ADD CONSTRAINT hire_requests_pkey PRIMARY KEY (id);

--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

--
-- Name: order_fulfillment_tracking order_fulfillment_tracking_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_fulfillment_tracking
    ADD CONSTRAINT order_fulfillment_tracking_pkey PRIMARY KEY (id);

--
-- Name: order_item_reviews order_item_reviews_order_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_reviews
    ADD CONSTRAINT order_item_reviews_order_item_id_key UNIQUE (order_item_id);

--
-- Name: order_item_reviews order_item_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_reviews
    ADD CONSTRAINT order_item_reviews_pkey PRIMARY KEY (id);

--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);

--
-- Name: order_route_plan order_route_plan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_route_plan
    ADD CONSTRAINT order_route_plan_pkey PRIMARY KEY (id);

--
-- Name: order_status_history order_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_status_history
    ADD CONSTRAINT order_status_history_pkey PRIMARY KEY (id);

--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

--
-- Name: payments payments_razorpay_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_razorpay_order_id_key UNIQUE (razorpay_order_id);

--
-- Name: product_category product_category_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_category
    ADD CONSTRAINT product_category_code_key UNIQUE (code);

--
-- Name: product_category product_category_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_category
    ADD CONSTRAINT product_category_pkey PRIMARY KEY (id);

--
-- Name: product_specification product_specification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_specification
    ADD CONSTRAINT product_specification_pkey PRIMARY KEY (id);

--
-- Name: product_variants product_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_pkey PRIMARY KEY (id);

--
-- Name: products_images products_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products_images
    ADD CONSTRAINT products_images_pkey PRIMARY KEY (id);

--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

--
-- Name: quotation_documents quotation_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_documents
    ADD CONSTRAINT quotation_documents_pkey PRIMARY KEY (id);

--
-- Name: quotation_documents quotation_documents_quotation_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_documents
    ADD CONSTRAINT quotation_documents_quotation_number_key UNIQUE (quotation_number);

--
-- Name: quotation_messages quotation_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_messages
    ADD CONSTRAINT quotation_messages_pkey PRIMARY KEY (id);

--
-- Name: quotation_requests quotation_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_requests
    ADD CONSTRAINT quotation_requests_pkey PRIMARY KEY (id);

--
-- Name: rider_earnings rider_earnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_earnings
    ADD CONSTRAINT rider_earnings_pkey PRIMARY KEY (id);

--
-- Name: schema_migrations schema_migrations_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_filename_key UNIQUE (filename);

--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);

--
-- Name: service_bookings service_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_bookings
    ADD CONSTRAINT service_bookings_pkey PRIMARY KEY (id);

--
-- Name: service_cart_items service_cart_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_cart_items
    ADD CONSTRAINT service_cart_items_pkey PRIMARY KEY (id);

--
-- Name: service_quotation_documents service_quotation_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotation_documents
    ADD CONSTRAINT service_quotation_documents_pkey PRIMARY KEY (id);

--
-- Name: service_quotation_documents service_quotation_documents_quotation_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotation_documents
    ADD CONSTRAINT service_quotation_documents_quotation_number_key UNIQUE (quotation_number);

--
-- Name: service_quotation_messages service_quotation_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotation_messages
    ADD CONSTRAINT service_quotation_messages_pkey PRIMARY KEY (id);

--
-- Name: service_quotations service_quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotations
    ADD CONSTRAINT service_quotations_pkey PRIMARY KEY (id);

--
-- Name: service_reviews service_reviews_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_reviews
    ADD CONSTRAINT service_reviews_booking_id_key UNIQUE (booking_id);

--
-- Name: service_reviews service_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_reviews
    ADD CONSTRAINT service_reviews_pkey PRIMARY KEY (id);

--
-- Name: service_subcategories service_subcategories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_subcategories
    ADD CONSTRAINT service_subcategories_pkey PRIMARY KEY (id);

--
-- Name: service_ticket_documents service_ticket_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_ticket_documents
    ADD CONSTRAINT service_ticket_documents_pkey PRIMARY KEY (id);

--
-- Name: service_ticket_quotations service_ticket_quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_ticket_quotations
    ADD CONSTRAINT service_ticket_quotations_pkey PRIMARY KEY (id);

--
-- Name: service_tickets service_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_tickets
    ADD CONSTRAINT service_tickets_pkey PRIMARY KEY (id);

--
-- Name: service_tickets service_tickets_ticket_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_tickets
    ADD CONSTRAINT service_tickets_ticket_number_key UNIQUE (ticket_number);

--
-- Name: services_media services_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services_media
    ADD CONSTRAINT services_media_pkey PRIMARY KEY (id);

--
-- Name: services services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);

--
-- Name: subcategories subcategories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subcategories
    ADD CONSTRAINT subcategories_pkey PRIMARY KEY (id);

--
-- Name: abandoned_reminder_logs unique_abandoned_reminder_source; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abandoned_reminder_logs
    ADD CONSTRAINT unique_abandoned_reminder_source UNIQUE (source_type, source_item_id, reminder_type);

--
-- Name: cart_items unique_cart_product_variant_vendor; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT unique_cart_product_variant_vendor UNIQUE (cart_id, product_variant_id, vendor_id);

--
-- Name: service_cart_items unique_cart_vendor_service; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_cart_items
    ADD CONSTRAINT unique_cart_vendor_service UNIQUE (cart_id, vendor_service_id);

--
-- Name: subcategories unique_category_subcategory_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subcategories
    ADD CONSTRAINT unique_category_subcategory_name UNIQUE (category_id, name);

--
-- Name: service_subcategories unique_subcategory_name_per_category; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_subcategories
    ADD CONSTRAINT unique_subcategory_name_per_category UNIQUE (category_id, name);

--
-- Name: vendor_categories unique_vendor_category_selection; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_categories
    ADD CONSTRAINT unique_vendor_category_selection UNIQUE (vendor_id, category_id);

--
-- Name: vendor_products unique_vendor_product_variant; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_products
    ADD CONSTRAINT unique_vendor_product_variant UNIQUE (vendor_id, product_variant_id);

--
-- Name: vendor_reviews unique_vendor_review_per_order; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_reviews
    ADD CONSTRAINT unique_vendor_review_per_order UNIQUE (order_id, vendor_id);

--
-- Name: vendor_services unique_vendor_service; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_services
    ADD CONSTRAINT unique_vendor_service UNIQUE (vendor_id, service_id);

--
-- Name: wishlist_items unique_wishlist_product_variant; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT unique_wishlist_product_variant UNIQUE (wishlist_id, product_variant_id);

--
-- Name: wishlist_items unique_wishlist_service; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT unique_wishlist_service UNIQUE (wishlist_id, service_id);

--
-- Name: order_route_plan uq_orp_order_sequence; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_route_plan
    ADD CONSTRAINT uq_orp_order_sequence UNIQUE (order_id, stop_sequence);

--
-- Name: product_variants uq_product_id_properties; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT uq_product_id_properties UNIQUE (product_id, properties);

--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: vendor_categories vendor_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_categories
    ADD CONSTRAINT vendor_categories_pkey PRIMARY KEY (id);

--
-- Name: vendor_chat_messages vendor_chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_chat_messages
    ADD CONSTRAINT vendor_chat_messages_pkey PRIMARY KEY (id);

--
-- Name: vendor_payouts vendor_payouts_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payouts
    ADD CONSTRAINT vendor_payouts_order_id_key UNIQUE (order_id);

--
-- Name: vendor_payouts vendor_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payouts
    ADD CONSTRAINT vendor_payouts_pkey PRIMARY KEY (id);

--
-- Name: vendor_products vendor_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_products
    ADD CONSTRAINT vendor_products_pkey PRIMARY KEY (id);

--
-- Name: vendor_quotations vendor_quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_quotations
    ADD CONSTRAINT vendor_quotations_pkey PRIMARY KEY (id);

--
-- Name: vendor_quotations vendor_quotations_quotation_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_quotations
    ADD CONSTRAINT vendor_quotations_quotation_number_key UNIQUE (quotation_number);

--
-- Name: vendor_quotations vendor_quotations_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_quotations
    ADD CONSTRAINT vendor_quotations_token_hash_key UNIQUE (token_hash);

--
-- Name: vendor_reviews vendor_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_reviews
    ADD CONSTRAINT vendor_reviews_pkey PRIMARY KEY (id);

--
-- Name: vendor_services vendor_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_services
    ADD CONSTRAINT vendor_services_pkey PRIMARY KEY (id);

--
-- Name: vendors vendors_application_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_application_number_key UNIQUE (application_number);

--
-- Name: vendors vendors_gst_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_gst_number_key UNIQUE (gst_number);

--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);

--
-- Name: vendors vendors_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_user_id_key UNIQUE (user_id);

--
-- Name: wishlist_items wishlist_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT wishlist_items_pkey PRIMARY KEY (id);

--
-- Name: wishlists wishlists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlists
    ADD CONSTRAINT wishlists_pkey PRIMARY KEY (id);

--
-- Name: wishlists wishlists_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlists
    ADD CONSTRAINT wishlists_user_id_key UNIQUE (user_id);

--
-- Name: idx_abandoned_reminder_logs_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_abandoned_reminder_logs_source ON public.abandoned_reminder_logs USING btree (source_type, source_item_id);

--
-- Name: idx_abandoned_reminder_logs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_abandoned_reminder_logs_user_id ON public.abandoned_reminder_logs USING btree (user_id);

--
-- Name: idx_addresses_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_addresses_user_id ON public.addresses USING btree (user_id);

--
-- Name: idx_bookings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_status ON public.service_bookings USING btree (status);

--
-- Name: idx_bookings_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_user_id ON public.service_bookings USING btree (user_id);

--
-- Name: idx_bookings_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_vendor_id ON public.service_bookings USING btree (vendor_id);

--
-- Name: idx_cart_items_cart_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cart_items_cart_id ON public.cart_items USING btree (cart_id);

--
-- Name: idx_cart_items_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cart_items_product_id ON public.cart_items USING btree (product_id);

--
-- Name: idx_carts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_carts_user_id ON public.carts USING btree (user_id);

--
-- Name: idx_carts_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_carts_user_type ON public.carts USING btree (user_id, cart_type);

--
-- Name: idx_carts_user_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_carts_user_type_status ON public.carts USING btree (user_id, cart_type) WHERE (status = 'active'::text);

--
-- Name: idx_client_assets_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_assets_category ON public.client_assets USING btree (category_id);

--
-- Name: idx_client_assets_specs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_assets_specs ON public.client_assets USING gin (specs);

--
-- Name: idx_client_assets_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_assets_user ON public.client_assets USING btree (user_id);

--
-- Name: idx_delivery_agent_kyc_rider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_agent_kyc_rider ON public.delivery_agent_kyc USING btree (delivery_agent_id);

--
-- Name: idx_delivery_agents_fc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_agents_fc ON public.delivery_agents USING btree (fulfillment_center_id);

--
-- Name: idx_emp_cand_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emp_cand_available ON public.employee_candidates USING btree (is_available) WHERE (is_available = true);

--
-- Name: idx_emp_cand_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emp_cand_city ON public.employee_candidates USING btree (city);

--
-- Name: idx_emp_cand_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emp_cand_phone ON public.employee_candidates USING btree (phone);

--
-- Name: idx_emp_cand_skills; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emp_cand_skills ON public.employee_candidates USING gin (skills);

--
-- Name: idx_emp_cand_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emp_cand_status ON public.employee_candidates USING btree (verification_status);

--
-- Name: idx_emp_doc_candidate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emp_doc_candidate ON public.employee_documents USING btree (candidate_id);

--
-- Name: idx_emp_doc_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emp_doc_type ON public.employee_documents USING btree (doc_type);

--
-- Name: idx_fulfillment_centers_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fulfillment_centers_code ON public.fulfillment_centers USING btree (code);

--
-- Name: idx_fulfillment_centers_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fulfillment_centers_user_id ON public.fulfillment_centers USING btree (user_id);

--
-- Name: idx_hire_req_candidate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hire_req_candidate ON public.hire_requests USING btree (candidate_id);

--
-- Name: idx_hire_req_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hire_req_status ON public.hire_requests USING btree (status);

--
-- Name: idx_hire_req_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hire_req_user ON public.hire_requests USING btree (requested_by_user_id);

--
-- Name: idx_hire_request_messages_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hire_request_messages_request ON public.hire_request_messages USING btree (hire_request_id, created_at);

--
-- Name: idx_notifications_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_created_at ON public.notifications USING btree (created_at DESC);

--
-- Name: idx_notifications_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_reference ON public.notifications USING btree (reference_type, reference_id);

--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);

--
-- Name: idx_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id, is_read) WHERE (is_read = false);

--
-- Name: idx_oft_order_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oft_order_sequence ON public.order_fulfillment_tracking USING btree (order_id, stop_sequence);

--
-- Name: idx_order_item_reviews_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_item_reviews_order_id ON public.order_item_reviews USING btree (order_id);

--
-- Name: idx_order_item_reviews_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_item_reviews_product_id ON public.order_item_reviews USING btree (product_id);

--
-- Name: idx_order_item_reviews_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_item_reviews_user_id ON public.order_item_reviews USING btree (user_id);

--
-- Name: idx_order_item_reviews_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_item_reviews_vendor_id ON public.order_item_reviews USING btree (vendor_id);

--
-- Name: idx_order_route_plan_fc_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_route_plan_fc_id ON public.order_route_plan USING btree (fulfillment_center_id);

--
-- Name: idx_order_route_plan_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_route_plan_order_id ON public.order_route_plan USING btree (order_id);

--
-- Name: idx_order_route_plan_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_route_plan_status ON public.order_route_plan USING btree (status);

--
-- Name: idx_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status ON public.orders USING btree (status);

--
-- Name: idx_orders_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_user_id ON public.orders USING btree (user_id);

--
-- Name: idx_orp_pickup_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orp_pickup_status ON public.order_route_plan USING btree (fulfillment_center_id, status) WHERE (status = ANY (ARRAY['pickup_pending'::text, 'pickup_assigned'::text]));

--
-- Name: idx_payments_hire_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_hire_request_id ON public.payments USING btree (hire_request_id);

--
-- Name: idx_payments_razorpay_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_razorpay_order_id ON public.payments USING btree (razorpay_order_id);

--
-- Name: idx_payments_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_user_id ON public.payments USING btree (user_id);

--
-- Name: idx_product_specification_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_specification_product_id ON public.product_specification USING btree (product_id);

--
-- Name: idx_product_specification_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_specification_status ON public.product_specification USING btree (approval_status);

--
-- Name: idx_product_variants_approval_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_variants_approval_status ON public.product_variants USING btree (approval_status);

--
-- Name: idx_product_variants_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_variants_product_id ON public.product_variants USING btree (product_id);

--
-- Name: idx_products_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_category ON public.products USING btree (category);

--
-- Name: idx_products_images_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_images_product_id ON public.products_images USING btree (product_id);

--
-- Name: idx_products_images_variant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_images_variant_id ON public.products_images USING btree (product_variant_id);

--
-- Name: idx_products_product_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_product_type ON public.products USING btree (product_type);

--
-- Name: idx_products_subcategory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_subcategory_id ON public.products USING btree (subcategory_id);

--
-- Name: idx_qd_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qd_group_id ON public.quotation_documents USING btree (quotation_group_id);

--
-- Name: idx_qd_quotation_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qd_quotation_number ON public.quotation_documents USING btree (quotation_number);

--
-- Name: idx_quotation_messages_quotation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_messages_quotation_id ON public.quotation_messages USING btree (quotation_id, created_at);

--
-- Name: idx_quotation_requests_admin_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_requests_admin_status ON public.quotation_requests USING btree (admin_confirmation_status) WHERE (admin_confirmation_status IS NOT NULL);

--
-- Name: idx_quotation_requests_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_requests_group_id ON public.quotation_requests USING btree (quotation_group_id) WHERE (quotation_group_id IS NOT NULL);

--
-- Name: idx_quotation_requests_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_requests_product_id ON public.quotation_requests USING btree (product_id);

--
-- Name: idx_quotation_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_requests_status ON public.quotation_requests USING btree (status);

--
-- Name: idx_quotation_requests_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_requests_user_id ON public.quotation_requests USING btree (user_id);

--
-- Name: idx_quotation_requests_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_requests_vendor_id ON public.quotation_requests USING btree (vendor_id);

--
-- Name: idx_rider_earnings_rider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rider_earnings_rider ON public.rider_earnings USING btree (delivery_agent_id);

--
-- Name: idx_service_quotation_documents_quote_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_quotation_documents_quote_id ON public.service_quotation_documents USING btree (service_quotation_id);

--
-- Name: idx_service_quotation_messages_quotation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_quotation_messages_quotation_id ON public.service_quotation_messages USING btree (quotation_id);

--
-- Name: idx_service_quotations_broadcast_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_quotations_broadcast_group ON public.service_quotations USING btree (broadcast_group_id) WHERE (broadcast_group_id IS NOT NULL);

--
-- Name: idx_service_quotes_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_quotes_user_id ON public.service_quotations USING btree (user_id);

--
-- Name: idx_service_quotes_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_quotes_vendor_id ON public.service_quotations USING btree (vendor_id);

--
-- Name: idx_service_reviews_service_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_reviews_service_id ON public.service_reviews USING btree (service_id);

--
-- Name: idx_service_reviews_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_reviews_user_id ON public.service_reviews USING btree (user_id);

--
-- Name: idx_service_reviews_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_reviews_vendor_id ON public.service_reviews USING btree (vendor_id);

--
-- Name: idx_services_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_services_category_id ON public.services USING btree (category_id);

--
-- Name: idx_services_media_service_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_services_media_service_id ON public.services_media USING btree (service_id);

--
-- Name: idx_services_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_services_status ON public.services USING btree (status);

--
-- Name: idx_srv_ticket_docs_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_srv_ticket_docs_ticket ON public.service_ticket_documents USING btree (ticket_id);

--
-- Name: idx_srv_ticket_quotes_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_srv_ticket_quotes_ticket ON public.service_ticket_quotations USING btree (ticket_id);

--
-- Name: idx_srv_ticket_quotes_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_srv_ticket_quotes_vendor ON public.service_ticket_quotations USING btree (vendor_id);

--
-- Name: idx_srv_tickets_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_srv_tickets_cat ON public.service_tickets USING btree (category_id);

--
-- Name: idx_srv_tickets_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_srv_tickets_client ON public.service_tickets USING btree (client_user_id);

--
-- Name: idx_srv_tickets_payload; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_srv_tickets_payload ON public.service_tickets USING gin (ticket_payload);

--
-- Name: idx_srv_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_srv_tickets_status ON public.service_tickets USING btree (status);

--
-- Name: idx_srv_tickets_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_srv_tickets_vendor ON public.service_tickets USING btree (vendor_id);

--
-- Name: idx_subcategories_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subcategories_category_id ON public.subcategories USING btree (category_id);

--
-- Name: idx_vendor_categories_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_categories_category_id ON public.vendor_categories USING btree (category_id);

--
-- Name: idx_vendor_categories_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_categories_vendor_id ON public.vendor_categories USING btree (vendor_id);

--
-- Name: idx_vendor_chat_messages_is_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_chat_messages_is_read ON public.vendor_chat_messages USING btree (vendor_id, is_read);

--
-- Name: idx_vendor_chat_messages_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_chat_messages_vendor_id ON public.vendor_chat_messages USING btree (vendor_id, created_at);

--
-- Name: idx_vendor_payouts_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payouts_order_id ON public.vendor_payouts USING btree (order_id);

--
-- Name: idx_vendor_payouts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payouts_status ON public.vendor_payouts USING btree (status);

--
-- Name: idx_vendor_payouts_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payouts_vendor_id ON public.vendor_payouts USING btree (vendor_id);

--
-- Name: idx_vendor_products_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_products_product_id ON public.vendor_products USING btree (product_id);

--
-- Name: idx_vendor_products_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_products_status ON public.vendor_products USING btree (status);

--
-- Name: idx_vendor_quotations_created_by_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_quotations_created_by_admin_id ON public.vendor_quotations USING btree (created_by_admin_id);

--
-- Name: idx_vendor_quotations_number_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_vendor_quotations_number_unique ON public.vendor_quotations USING btree (quotation_number);

--
-- Name: idx_vendor_quotations_reviewed_by_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_quotations_reviewed_by_admin_id ON public.vendor_quotations USING btree (reviewed_by_admin_id);

--
-- Name: idx_vendor_quotations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_quotations_status ON public.vendor_quotations USING btree (status);

--
-- Name: idx_vendor_quotations_token_hash_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_vendor_quotations_token_hash_unique ON public.vendor_quotations USING btree (token_hash);

--
-- Name: idx_vendor_quotations_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_quotations_vendor_id ON public.vendor_quotations USING btree (vendor_id);

--
-- Name: idx_vendor_reviews_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_reviews_order_id ON public.vendor_reviews USING btree (order_id);

--
-- Name: idx_vendor_reviews_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_reviews_user_id ON public.vendor_reviews USING btree (user_id);

--
-- Name: idx_vendor_reviews_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_reviews_vendor_id ON public.vendor_reviews USING btree (vendor_id);

--
-- Name: idx_vendor_services_service_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_services_service_id ON public.vendor_services USING btree (service_id);

--
-- Name: idx_vendor_services_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_services_vendor_id ON public.vendor_services USING btree (vendor_id);

--
-- Name: idx_vendors_rating; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendors_rating ON public.vendors USING btree (rating DESC) WHERE (is_active = true);

--
-- Name: idx_wishlist_items_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wishlist_items_product_id ON public.wishlist_items USING btree (product_id);

--
-- Name: idx_wishlist_items_wishlist_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wishlist_items_wishlist_id ON public.wishlist_items USING btree (wishlist_id);

--
-- Name: idx_wishlists_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wishlists_user_id ON public.wishlists USING btree (user_id);

--
-- Name: unique_video_per_service; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unique_video_per_service ON public.services_media USING btree (service_id) WHERE (media_type = 'video'::text);

--
-- Name: vendor_categories trg_vendor_category_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vendor_category_limit BEFORE INSERT ON public.vendor_categories FOR EACH ROW EXECUTE FUNCTION public.enforce_vendor_category_limit();

--
-- Name: client_assets client_assets_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_assets
    ADD CONSTRAINT client_assets_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_category(id) ON DELETE SET NULL;

--
-- Name: client_assets client_assets_subcategory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_assets
    ADD CONSTRAINT client_assets_subcategory_id_fkey FOREIGN KEY (subcategory_id) REFERENCES public.subcategories(id) ON DELETE SET NULL;

--
-- Name: client_assets client_assets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_assets
    ADD CONSTRAINT client_assets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: delivery_agent_kyc delivery_agent_kyc_delivery_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_agent_kyc
    ADD CONSTRAINT delivery_agent_kyc_delivery_agent_id_fkey FOREIGN KEY (delivery_agent_id) REFERENCES public.delivery_agents(id) ON DELETE CASCADE;

--
-- Name: delivery_agent_kyc delivery_agent_kyc_reviewed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_agent_kyc
    ADD CONSTRAINT delivery_agent_kyc_reviewed_by_user_id_fkey FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: delivery_agents delivery_agents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_agents
    ADD CONSTRAINT delivery_agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: employee_candidates employee_candidates_registered_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_candidates
    ADD CONSTRAINT employee_candidates_registered_by_user_id_fkey FOREIGN KEY (registered_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: employee_candidates employee_candidates_verified_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_candidates
    ADD CONSTRAINT employee_candidates_verified_by_user_id_fkey FOREIGN KEY (verified_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: employee_documents employee_documents_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.employee_candidates(id) ON DELETE CASCADE;

--
-- Name: employee_documents employee_documents_uploaded_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_uploaded_by_user_id_fkey FOREIGN KEY (uploaded_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: abandoned_reminder_logs fk_abandoned_reminder_logs_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abandoned_reminder_logs
    ADD CONSTRAINT fk_abandoned_reminder_logs_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: addresses fk_addresses_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: service_bookings fk_bookings_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_bookings
    ADD CONSTRAINT fk_bookings_user FOREIGN KEY (user_id) REFERENCES public.users(id);

--
-- Name: service_bookings fk_bookings_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_bookings
    ADD CONSTRAINT fk_bookings_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);

--
-- Name: service_bookings fk_bookings_vendor_service; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_bookings
    ADD CONSTRAINT fk_bookings_vendor_service FOREIGN KEY (vendor_service_id) REFERENCES public.vendor_services(id);

--
-- Name: cart_items fk_cart_items_cart; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT fk_cart_items_cart FOREIGN KEY (cart_id) REFERENCES public.carts(id) ON DELETE CASCADE;

--
-- Name: cart_items fk_cart_items_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT fk_cart_items_product FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: cart_items fk_cart_items_variant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT fk_cart_items_variant FOREIGN KEY (product_variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

--
-- Name: cart_items fk_cart_items_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT fk_cart_items_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: carts fk_carts_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT fk_carts_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: client fk_client_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client
    ADD CONSTRAINT fk_client_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: notifications fk_notifications_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: order_fulfillment_tracking fk_oft_center; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_fulfillment_tracking
    ADD CONSTRAINT fk_oft_center FOREIGN KEY (fulfillment_center_id) REFERENCES public.fulfillment_centers(id) ON DELETE SET NULL;

--
-- Name: order_fulfillment_tracking fk_oft_delivery_agent; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_fulfillment_tracking
    ADD CONSTRAINT fk_oft_delivery_agent FOREIGN KEY (delivery_agent_id) REFERENCES public.delivery_agents(id) ON DELETE SET NULL;

--
-- Name: order_fulfillment_tracking fk_oft_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_fulfillment_tracking
    ADD CONSTRAINT fk_oft_order FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--
-- Name: order_item_reviews fk_order_item_reviews_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_reviews
    ADD CONSTRAINT fk_order_item_reviews_order FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--
-- Name: order_item_reviews fk_order_item_reviews_order_item; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_reviews
    ADD CONSTRAINT fk_order_item_reviews_order_item FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE CASCADE;

--
-- Name: order_item_reviews fk_order_item_reviews_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_reviews
    ADD CONSTRAINT fk_order_item_reviews_product FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: order_item_reviews fk_order_item_reviews_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_reviews
    ADD CONSTRAINT fk_order_item_reviews_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: order_item_reviews fk_order_item_reviews_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_reviews
    ADD CONSTRAINT fk_order_item_reviews_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: order_items fk_order_items_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--
-- Name: order_items fk_order_items_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES public.products(id);

--
-- Name: order_items fk_order_items_variant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT fk_order_items_variant FOREIGN KEY (product_variant_id) REFERENCES public.product_variants(id) ON DELETE RESTRICT;

--
-- Name: order_items fk_order_items_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT fk_order_items_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);

--
-- Name: order_status_history fk_order_status_history_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_status_history
    ADD CONSTRAINT fk_order_status_history_order FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--
-- Name: orders fk_orders_cart; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_orders_cart FOREIGN KEY (cart_id) REFERENCES public.carts(id);

--
-- Name: orders fk_orders_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES public.users(id);

--
-- Name: orders fk_orders_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_orders_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);

--
-- Name: order_route_plan fk_orp_fc; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_route_plan
    ADD CONSTRAINT fk_orp_fc FOREIGN KEY (fulfillment_center_id) REFERENCES public.fulfillment_centers(id) ON DELETE CASCADE;

--
-- Name: order_route_plan fk_orp_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_route_plan
    ADD CONSTRAINT fk_orp_order FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--
-- Name: product_specification fk_product_specifications_created_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_specification
    ADD CONSTRAINT fk_product_specifications_created_by FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: product_specification fk_product_specifications_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_specification
    ADD CONSTRAINT fk_product_specifications_product FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: product_specification fk_product_specifications_reviewed_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_specification
    ADD CONSTRAINT fk_product_specifications_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: product_variants fk_product_variants_created_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT fk_product_variants_created_by FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: product_variants fk_product_variants_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT fk_product_variants_product FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: product_variants fk_product_variants_reviewed_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT fk_product_variants_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: products fk_products_category; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT fk_products_category FOREIGN KEY (category) REFERENCES public.product_category(id);

--
-- Name: products_images fk_products_images_created_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products_images
    ADD CONSTRAINT fk_products_images_created_by FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: products_images fk_products_images_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products_images
    ADD CONSTRAINT fk_products_images_product FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: products_images fk_products_images_product_variant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products_images
    ADD CONSTRAINT fk_products_images_product_variant FOREIGN KEY (product_variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

--
-- Name: products_images fk_products_images_reviewed_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products_images
    ADD CONSTRAINT fk_products_images_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: products fk_products_subcategory; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT fk_products_subcategory FOREIGN KEY (subcategory_id) REFERENCES public.subcategories(id) ON DELETE SET NULL;

--
-- Name: quotation_messages fk_quotation_messages_quotation; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_messages
    ADD CONSTRAINT fk_quotation_messages_quotation FOREIGN KEY (quotation_id) REFERENCES public.quotation_requests(id) ON DELETE CASCADE;

--
-- Name: quotation_messages fk_quotation_messages_sender; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_messages
    ADD CONSTRAINT fk_quotation_messages_sender FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: quotation_requests fk_quotation_requests_admin_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_requests
    ADD CONSTRAINT fk_quotation_requests_admin_user FOREIGN KEY (admin_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: quotation_requests fk_quotation_requests_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_requests
    ADD CONSTRAINT fk_quotation_requests_order FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

--
-- Name: quotation_requests fk_quotation_requests_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_requests
    ADD CONSTRAINT fk_quotation_requests_product FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: quotation_requests fk_quotation_requests_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_requests
    ADD CONSTRAINT fk_quotation_requests_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: quotation_requests fk_quotation_requests_variant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_requests
    ADD CONSTRAINT fk_quotation_requests_variant FOREIGN KEY (product_variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

--
-- Name: quotation_requests fk_quotation_requests_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_requests
    ADD CONSTRAINT fk_quotation_requests_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: service_quotation_messages fk_service_quotation_messages_quotation; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotation_messages
    ADD CONSTRAINT fk_service_quotation_messages_quotation FOREIGN KEY (quotation_id) REFERENCES public.service_quotations(id) ON DELETE CASCADE;

--
-- Name: service_quotation_messages fk_service_quotation_messages_sender; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotation_messages
    ADD CONSTRAINT fk_service_quotation_messages_sender FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: service_quotations fk_service_quotes_service; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotations
    ADD CONSTRAINT fk_service_quotes_service FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;

--
-- Name: service_quotations fk_service_quotes_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotations
    ADD CONSTRAINT fk_service_quotes_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: service_quotations fk_service_quotes_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotations
    ADD CONSTRAINT fk_service_quotes_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: service_reviews fk_service_reviews_booking; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_reviews
    ADD CONSTRAINT fk_service_reviews_booking FOREIGN KEY (booking_id) REFERENCES public.service_bookings(id) ON DELETE CASCADE;

--
-- Name: service_reviews fk_service_reviews_service; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_reviews
    ADD CONSTRAINT fk_service_reviews_service FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;

--
-- Name: service_reviews fk_service_reviews_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_reviews
    ADD CONSTRAINT fk_service_reviews_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: service_reviews fk_service_reviews_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_reviews
    ADD CONSTRAINT fk_service_reviews_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: services fk_services_category; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT fk_services_category FOREIGN KEY (category_id) REFERENCES public.product_category(id) ON DELETE RESTRICT;

--
-- Name: services fk_services_created_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT fk_services_created_by FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: services_media fk_services_media_created_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services_media
    ADD CONSTRAINT fk_services_media_created_by FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: services_media fk_services_media_reviewed_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services_media
    ADD CONSTRAINT fk_services_media_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: services_media fk_services_media_service; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services_media
    ADD CONSTRAINT fk_services_media_service FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;

--
-- Name: vendor_categories fk_vendor_categories_category; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_categories
    ADD CONSTRAINT fk_vendor_categories_category FOREIGN KEY (category_id) REFERENCES public.product_category(id) ON DELETE CASCADE;

--
-- Name: vendor_categories fk_vendor_categories_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_categories
    ADD CONSTRAINT fk_vendor_categories_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: vendor_chat_messages fk_vendor_chat_messages_sender; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_chat_messages
    ADD CONSTRAINT fk_vendor_chat_messages_sender FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: vendor_chat_messages fk_vendor_chat_messages_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_chat_messages
    ADD CONSTRAINT fk_vendor_chat_messages_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: vendor_products fk_vendor_products_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_products
    ADD CONSTRAINT fk_vendor_products_product FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: vendor_products fk_vendor_products_variant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_products
    ADD CONSTRAINT fk_vendor_products_variant FOREIGN KEY (product_variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

--
-- Name: vendor_products fk_vendor_products_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_products
    ADD CONSTRAINT fk_vendor_products_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: vendor_quotations fk_vendor_quotations_admin; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_quotations
    ADD CONSTRAINT fk_vendor_quotations_admin FOREIGN KEY (created_by_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: vendor_quotations fk_vendor_quotations_reviewed_by_admin; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_quotations
    ADD CONSTRAINT fk_vendor_quotations_reviewed_by_admin FOREIGN KEY (reviewed_by_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: vendor_quotations fk_vendor_quotations_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_quotations
    ADD CONSTRAINT fk_vendor_quotations_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: vendor_reviews fk_vendor_reviews_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_reviews
    ADD CONSTRAINT fk_vendor_reviews_order FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--
-- Name: vendor_reviews fk_vendor_reviews_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_reviews
    ADD CONSTRAINT fk_vendor_reviews_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: vendor_reviews fk_vendor_reviews_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_reviews
    ADD CONSTRAINT fk_vendor_reviews_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: vendor_services fk_vendor_services_service; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_services
    ADD CONSTRAINT fk_vendor_services_service FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;

--
-- Name: vendor_services fk_vendor_services_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_services
    ADD CONSTRAINT fk_vendor_services_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: vendors fk_vendors_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT fk_vendors_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: wishlist_items fk_wishlist_items_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT fk_wishlist_items_product FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: wishlist_items fk_wishlist_items_variant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT fk_wishlist_items_variant FOREIGN KEY (product_variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

--
-- Name: wishlist_items fk_wishlist_items_vendor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT fk_wishlist_items_vendor FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;

--
-- Name: wishlist_items fk_wishlist_items_wishlist; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT fk_wishlist_items_wishlist FOREIGN KEY (wishlist_id) REFERENCES public.wishlists(id) ON DELETE CASCADE;

--
-- Name: wishlists fk_wishlists_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlists
    ADD CONSTRAINT fk_wishlists_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: fulfillment_centers fulfillment_centers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_centers
    ADD CONSTRAINT fulfillment_centers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: hire_request_messages hire_request_messages_hire_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hire_request_messages
    ADD CONSTRAINT hire_request_messages_hire_request_id_fkey FOREIGN KEY (hire_request_id) REFERENCES public.hire_requests(id) ON DELETE CASCADE;

--
-- Name: hire_request_messages hire_request_messages_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hire_request_messages
    ADD CONSTRAINT hire_request_messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: hire_requests hire_requests_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hire_requests
    ADD CONSTRAINT hire_requests_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.employee_candidates(id) ON DELETE CASCADE;

--
-- Name: hire_requests hire_requests_latest_offer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hire_requests
    ADD CONSTRAINT hire_requests_latest_offer_id_fkey FOREIGN KEY (latest_offer_id) REFERENCES public.hire_request_messages(id) ON DELETE SET NULL;

--
-- Name: hire_requests hire_requests_negotiation_proposed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hire_requests
    ADD CONSTRAINT hire_requests_negotiation_proposed_by_fkey FOREIGN KEY (negotiation_proposed_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: hire_requests hire_requests_requested_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hire_requests
    ADD CONSTRAINT hire_requests_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: hire_requests hire_requests_reviewed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hire_requests
    ADD CONSTRAINT hire_requests_reviewed_by_user_id_fkey FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: order_route_plan order_route_plan_pickup_rider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_route_plan
    ADD CONSTRAINT order_route_plan_pickup_rider_id_fkey FOREIGN KEY (pickup_rider_id) REFERENCES public.delivery_agents(id) ON DELETE SET NULL;

--
-- Name: payments payments_hire_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_hire_request_id_fkey FOREIGN KEY (hire_request_id) REFERENCES public.hire_requests(id) ON DELETE SET NULL;

--
-- Name: payments payments_quotation_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_quotation_request_id_fkey FOREIGN KEY (quotation_request_id) REFERENCES public.quotation_requests(id) ON DELETE SET NULL;

--
-- Name: payments payments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: quotation_documents quotation_documents_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_documents
    ADD CONSTRAINT quotation_documents_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: quotation_documents quotation_documents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_documents
    ADD CONSTRAINT quotation_documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: rider_earnings rider_earnings_delivery_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_earnings
    ADD CONSTRAINT rider_earnings_delivery_agent_id_fkey FOREIGN KEY (delivery_agent_id) REFERENCES public.delivery_agents(id) ON DELETE CASCADE;

--
-- Name: rider_earnings rider_earnings_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_earnings
    ADD CONSTRAINT rider_earnings_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

--
-- Name: service_cart_items service_cart_items_cart_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_cart_items
    ADD CONSTRAINT service_cart_items_cart_id_fkey FOREIGN KEY (cart_id) REFERENCES public.carts(id) ON DELETE CASCADE;

--
-- Name: service_cart_items service_cart_items_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_cart_items
    ADD CONSTRAINT service_cart_items_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;

--
-- Name: service_cart_items service_cart_items_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_cart_items
    ADD CONSTRAINT service_cart_items_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: service_cart_items service_cart_items_vendor_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_cart_items
    ADD CONSTRAINT service_cart_items_vendor_service_id_fkey FOREIGN KEY (vendor_service_id) REFERENCES public.vendor_services(id) ON DELETE CASCADE;

--
-- Name: service_quotation_documents service_quotation_documents_service_quotation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotation_documents
    ADD CONSTRAINT service_quotation_documents_service_quotation_id_fkey FOREIGN KEY (service_quotation_id) REFERENCES public.service_quotations(id) ON DELETE CASCADE;

--
-- Name: service_quotations service_quotations_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_quotations
    ADD CONSTRAINT service_quotations_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.service_bookings(id) ON DELETE SET NULL;

--
-- Name: service_subcategories service_subcategories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_subcategories
    ADD CONSTRAINT service_subcategories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_category(id) ON DELETE CASCADE;

--
-- Name: service_ticket_documents service_ticket_documents_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_ticket_documents
    ADD CONSTRAINT service_ticket_documents_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.service_tickets(id) ON DELETE CASCADE;

--
-- Name: service_ticket_documents service_ticket_documents_uploaded_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_ticket_documents
    ADD CONSTRAINT service_ticket_documents_uploaded_by_user_id_fkey FOREIGN KEY (uploaded_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: service_ticket_quotations service_ticket_quotations_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_ticket_quotations
    ADD CONSTRAINT service_ticket_quotations_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.service_tickets(id) ON DELETE CASCADE;

--
-- Name: service_ticket_quotations service_ticket_quotations_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_ticket_quotations
    ADD CONSTRAINT service_ticket_quotations_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: service_tickets service_tickets_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_tickets
    ADD CONSTRAINT service_tickets_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.client_assets(id) ON DELETE SET NULL;

--
-- Name: service_tickets service_tickets_assigned_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_tickets
    ADD CONSTRAINT service_tickets_assigned_agent_id_fkey FOREIGN KEY (assigned_agent_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: service_tickets service_tickets_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_tickets
    ADD CONSTRAINT service_tickets_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_category(id) ON DELETE RESTRICT;

--
-- Name: service_tickets service_tickets_client_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_tickets
    ADD CONSTRAINT service_tickets_client_user_id_fkey FOREIGN KEY (client_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: service_tickets service_tickets_subcategory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_tickets
    ADD CONSTRAINT service_tickets_subcategory_id_fkey FOREIGN KEY (subcategory_id) REFERENCES public.subcategories(id) ON DELETE SET NULL;

--
-- Name: service_tickets service_tickets_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_tickets
    ADD CONSTRAINT service_tickets_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;

--
-- Name: services services_subcategory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_subcategory_id_fkey FOREIGN KEY (subcategory_id) REFERENCES public.service_subcategories(id) ON DELETE SET NULL;

--
-- Name: subcategories subcategories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subcategories
    ADD CONSTRAINT subcategories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_category(id) ON DELETE CASCADE;

--
-- Name: vendor_payouts vendor_payouts_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payouts
    ADD CONSTRAINT vendor_payouts_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--
-- Name: vendor_payouts vendor_payouts_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payouts
    ADD CONSTRAINT vendor_payouts_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;

--
-- Name: wishlist_items wishlist_items_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT wishlist_items_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;

--
-- PostgreSQL database dump complete
--

