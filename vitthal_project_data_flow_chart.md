# Vitthal Project — Architecture, System Overview & Data Flow Diagrams

---

## 1. Executive Summary & About the Project

**Vitthal Project** is an enterprise-grade, multi-role digital ecosystem engineered for unified B2C/B2B E-Commerce, On-Demand Professional Services, Asset & Ticket Management, B2B Price Negotiation (RFQ), and End-to-End Logistics & Fulfillment.

The ecosystem connects four distinct primary stakeholders—**Clients (Customers)**, **Vendors**, **Delivery Agents (Riders)**, and **System Administrators / Fulfillment Center Managers**—across mobile apps, web dashboards, microservice-oriented backend APIs, and real-time messaging hubs.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                               VITTHAL ECOSYSTEM                                 │
├───────────────┬────────────────┬──────────────────────┬─────────────────────────┤
│  Client Apps  │  Vendor Apps   │  Delivery Agent App  │       Admin Portal      │
│ (Web & Mobile)│ (Web & Mobile) │    (Mobile App)      │      (Web & Backend)    │
└───────┬───────┴───────┬────────┴──────────┬───────────┴────────────┬────────────┘
        │               │                   │                        │
        └───────────────┴─────────┬─────────┴────────────────────────┘
                                  ▼
                ┌──────────────────────────────────┐
                │  API Gateway & Security Proxies  │
                └─────────────────┬────────────────┘
                                  ▼
                ┌──────────────────────────────────┐
                │ Backend Microservices & Socket.io│
                └─────────────────┬────────────────┘
                                  ▼
                ┌──────────────────────────────────┐
                │ PostgreSQL DB & AWS S3 Storage   │
                └──────────────────────────────────┘
```

### Core Business Pillars & Modules

1. **B2C & B2B Product E-Commerce**:
   - Multi-vendor product catalog with categories, subcategories, variants, specifications, and SKU tracking.
   - Dynamic carts, wishlist, coupon/commission engine, inventory tracking, and split payment handling.

2. **On-Demand Services & Ticket Management**:
   - Booking of professional services (installation, maintenance, ritual/puja services, on-site assistance).
   - Ticket management pipeline allowing clients to register assets, open service tickets, request vendor quotations, track ticket statuses, and submit verified reviews.

3. **B2B RFQ & Negotiation Engine**:
   - Custom bulk purchasing workflows where clients issue Requests for Quotation (RFQ).
   - Integrated negotiation system allowing clients, admins, and vendors to submit counter-offers, adjust minimum order quantities (MOQ), issue token payment invoices, and convert agreed quotes into binding orders.

4. **Multi-Stop Logistics & Fulfillment**:
   - Route planning module (`order_route_plan`) calculating delivery sequences across multiple Fulfillment Centers.
   - Dispatching system assigning riders (`delivery_agents`) based on geographic proximity, active load, and vehicle type.
   - Dual OTP and QR Code security verification for item Pickups and Final Deliveries.

5. **Financial Operations & Settlements**:
   - Integrated Razorpay Payment Gateway supporting full payments, split payments, and token deposits.
   - Automated financial split engine generating rider earnings and vendor payouts after order fulfillment.

---

## 2. Technology Stack & Subsystems Overview

The codebase consists of **8 interconnected modules**:

| Module Directory | Type | Primary Tech Stack | Primary Responsibilities |
| :--- | :--- | :--- | :--- |
| `vitthal-mobile` | Mobile App | React Native (Expo), TypeScript, React Navigation, TanStack Query, Zustand | Customer Mobile Experience: Product discovery, service booking, ticket management, cart, live tracking, order history. |
| `vitthal-frontend` | Web App | Next.js, React, Tailwind CSS / Vanilla CSS | Customer Web Portal: Responsive e-commerce frontend, service booking portal, account management. |
| `Vitthal-Vendor-App` | Mobile App | React Native (Expo), TypeScript | Vendor Mobile Application: Real-time order alerts, RFQ negotiations, inventory updates, mobile order processing. |
| `vitthal-vendor-frontend` | Web Dashboard | Next.js, React | Vendor Web Portal: Comprehensive catalog management, B2B quotation desk, order fulfillment dashboard, payout reports. |
| `MTWO_Delivery_app` | Mobile App | React Native (Expo), Expo Location | Delivery Rider Mobile App: Order assignment alerts, navigation, pickup/delivery OTP/QR scanning, earnings ledger. |
| `Vitthal-frontend-Admin` | Web Dashboard | Next.js, React | Super Admin & Manager Portal: Platform governance, vendor approvals, product approval workflows, route plan monitoring, financial reports. |
| `Vitthal Backend Client` | Backend API | Node.js, Express.js 5.x, TypeScript, Native `pg`, Socket.io, Razorpay, S3 Presigner | Client & Socket Server: Customer API endpoints, cart handling, direct checkout, real-time chat, S3 presigned URL generation. |
| `Vitthal-Backend-Admin` | Backend API | Node.js, Express.js 5.x, Prisma ORM, Node-Cron, PDFMake | Admin & Operations Service: Database migration hub, admin governance endpoints, route planning engine, payout calculation, PDF generation. |
| `proxy.ts` / `proxy2.ts` | Edge Middleware | Next.js Middleware, JWT Decoder | Authentication Guard: Token validation, role-based route protection (`vendor`, `admin`, `super_admin`), cookie handling. |

---

## 3. Comprehensive Data Flow Charts

### Chart 1: System-Wide Architecture & Data Flow

This chart illustrates how data flows between user interfaces, gateway proxies, microservice backends, the database, and third-party integrations.

```mermaid
graph TD
    %% User Interfaces
    subgraph Client_Layer ["Client Interfaces"]
        C_Mob["Client Mobile App (vitthal-mobile)"]
        C_Web["Client Web App (vitthal-frontend)"]
    end

    subgraph Vendor_Layer ["Vendor Interfaces"]
        V_Mob["Vendor Mobile App (Vitthal-Vendor-App)"]
        V_Web["Vendor Web Portal (vitthal-vendor-frontend)"]
    end

    subgraph Operations_Layer ["Operations Interfaces"]
        D_App["Delivery Rider App (MTWO_Delivery_app)"]
        A_Web["Admin Dashboard (Vitthal-frontend-Admin)"]
    end

    %% Security Gateway / Proxies
    subgraph Gateway_Layer ["Gateway & Middleware"]
        EdgeProxy["Next.js Edge Proxy (proxy.ts / proxy2.ts)\nJWT Verification & Role Access Control"]
    end

    %% Backend Microservices
    subgraph Service_Layer ["Backend Microservices Layer"]
        Client_API["Vitthal Backend Client\n(Express + Socket.io + Native pg)"]
        Admin_API["Vitthal Backend Admin\n(Express + Prisma ORM + Cron)"]
    end

    %% Storage & Database
    subgraph Data_Layer ["Data & Media Storage"]
        PG_DB[("PostgreSQL Database\n(Users, Products, Orders, RFQs,\nRoutes, Tickets, Payments)")]
        AWS_S3[("AWS S3 Bucket\n(Product Media, Presigned KYC Docs,\nSignatures, Invoices)")]
    end

    %% External Systems
    subgraph External_Services ["External Services"]
        Razorpay["Razorpay Payment Gateway"]
        SMTP["Nodemailer SMTP Server"]
    end

    %% Flow Connections
    C_Mob -->|HTTP REST / Presigned S3| Client_API
    C_Web -->|HTTP Requests| EdgeProxy
    EdgeProxy -->|Forward Authorized Requests| Client_API

    V_Mob -->|HTTP REST / Socket.io| Client_API
    V_Web -->|HTTP Requests| EdgeProxy
    EdgeProxy -->|Forward Authorized Requests| Admin_API

    D_App -->|REST / Location Updates| Admin_API
    A_Web -->|HTTP Requests| EdgeProxy
    EdgeProxy -->|Forward Admin Actions| Admin_API

    Client_API <-->|Socket.io Realtime Chat| V_Mob
    Client_API <-->|Socket.io Realtime Chat| C_Mob

    Client_API -->|Direct Queries / Transactions| PG_DB
    Admin_API -->|Prisma ORM Queries & Migrations| PG_DB

    Client_API -->|Generate Upload / Download URLs| AWS_S3
    Admin_API -->|Store Generated PDF Reports| AWS_S3

    Client_API -->|Order Payment Creation & Verification| Razorpay
    Client_API -->|Trigger Transactional Emails| SMTP
    Admin_API -->|Trigger Account & Order Emails| SMTP
```

---

### Chart 2: Customer B2C Shopping, Cart & Order Checkout Flow

Shows the exact flow from product selection to payment verification and order status creation.

```mermaid
sequenceDiagram
    autonumber
    actor Customer as Customer (Web / Mobile)
    participant ClientAPI as Vitthal Backend Client
    participant DB as PostgreSQL DB
    participant Razorpay as Razorpay API
    participant VendorApp as Vendor App / Portal

    Customer->>ClientAPI: GET /products (browse catalog & filter variants)
    ClientAPI->>DB: Query active & approved products/variants
    DB-->>ClientAPI: Return product details & stock quantity
    ClientAPI-->>Customer: Render product list

    Customer->>ClientAPI: POST /cart/add (Product ID, Variant ID, Qty, Vendor ID)
    ClientAPI->>DB: Upsert Cart & CartItems (calculate price_at_added)
    DB-->>ClientAPI: Cart updated
    ClientAPI-->>Customer: Return active cart summary

    Customer->>ClientAPI: POST /checkout/initiate (Address ID, Cart ID)
    ClientAPI->>DB: Create pending Payment entry & lock stock items
    ClientAPI->>Razorpay: Create Razorpay Order (Amount, Currency)
    Razorpay-->>ClientAPI: Return razorpay_order_id
    ClientAPI-->>Customer: Return Razorpay credentials & Order ID

    Customer->>Razorpay: Perform Payment (UPI, Card, Netbanking)
    Razorpay-->>Customer: Payment success response (payment_id, signature)

    Customer->>ClientAPI: POST /payments/verify (razorpay_order_id, razorpay_payment_id, signature)
    ClientAPI->>ClientAPI: Validate HMAC SHA256 Signature
    alt Signature Valid
        ClientAPI->>DB: Update Payment status = 'completed'
        ClientAPI->>DB: Convert Cart -> Create Order & OrderItems (Status = 'pending')
        ClientAPI->>DB: Clear Active Cart
        ClientAPI->>VendorApp: Emit Socket/Push Notification: "New Order Received"
        ClientAPI-->>Customer: Order Confirmation (order_reference)
    else Signature Invalid
        ClientAPI->>DB: Update Payment status = 'failed'
        ClientAPI-->>Customer: Return Payment Error
    end
```

---

### Chart 3: B2B RFQ (Request For Quotation) & Price Negotiation Flow

Illustrates how custom bulk orders undergo negotiation between the Client, Admin, and Vendor before turning into a confirmed payment order.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client / Buyer
    participant Admin as Admin Dashboard
    participant Vendor as Vendor Portal / App
    participant Backend as Vitthal Backend (Client & Admin)
    participant DB as PostgreSQL Database
    participant Payment as Razorpay Gateway

    Client->>Backend: POST /quotations (Product, Variant, Requested Qty, Target Price, Address)
    Backend->>DB: Insert into `quotation_requests` (Status = 'pending_vendor')
    Backend-->>Admin: Notify Admin of new B2B RFQ

    Admin->>Backend: PUT /quotations/:id/confirm (Set admin_confirmation_status = 'approved')
    Backend->>DB: Update RFQ status
    Backend-->>Vendor: Alert Vendor of approved RFQ

    loop B2B Price & Quantity Negotiation
        alt Vendor Counter-Offers
            Vendor->>Backend: POST /quotations/:id/negotiate (Offer Price, Offer Qty, Note)
            Backend->>DB: Record in `quotation_messages` & update RFQ current_offer
            Backend-->>Client: Alert Client of Vendor Counter-Offer
        else Client Counter-Offers
            Client->>Backend: POST /quotations/:id/negotiate (Offer Price, Offer Qty, Note)
            Backend->>DB: Record in `quotation_messages` & update RFQ current_offer
            Backend-->>Vendor: Alert Vendor of Client Counter-Offer
        end
    end

    Client->>Backend: POST /quotations/:id/accept
    Backend->>DB: Set RFQ Status = 'accepted', calculate token_amount (e.g. 20%)
    Backend-->>Client: Return Token Invoice & Payment Link

    Client->>Payment: Pay Token Amount
    Payment-->>Backend: Token Payment Success Callback
    Backend->>DB: Create Order linked to RFQ (`order_type` = 'quotation')
    Backend->>DB: Update RFQ status = 'converted_to_order'
    Backend-->>Vendor: Trigger Fulfillment & Order Production Notice
```

---

### Chart 4: Multi-Stop Logistics, Route Planning & Delivery Agent Flow

Details how approved orders are routed through fulfillment centers, assigned to delivery agents, verified via OTP/QR codes, and settled upon delivery.

```mermaid
flowchart TD
    Start([Order Created & Verified]) --> RoutePlan[Admin / Backend Route Planner Engine]
    
    RoutePlan --> GenStops[Generate Route Plan in `order_route_plan`\nSequence: Vendor Pickup -> Fulfillment Center -> Customer Delivery]
    GenStops --> AssignFC[Assign Nearest Fulfillment Center]
    
    AssignFC --> FindRider[Scan Available Online Riders in `delivery_agents`\nMatching Vehicle Type & Location]
    FindRider --> AssignRider[Set `pickup_rider_id` & Emit Task Notification to Delivery App]
    
    AssignRider --> RiderAccept{Rider Accepts Job?}
    RiderAccept -- No --> FindRider
    RiderAccept -- Yes --> RiderToVendor[Rider Travels to Vendor Pickup Location]
    
    RiderToVendor --> PickupVerification{Pickup Verification}
    PickupVerification -->|Rider Scans Vendor QR Code OR Inputs Vendor Pickup OTP| VendorOTPCheck[Backend Validates `pickup_otp` / `pickup_qr_token`]
    
    VendorOTPCheck -- Valid --> StatusPickup[Update Order Status = 'picked_up'\nRecord Event in `order_fulfillment_tracking`]
    
    StatusPickup --> TransitToFC[Rider Delivers Package to Fulfillment Center]
    TransitToFC --> HubInward[Fulfillment Center Scan & Inward Processing]
    
    HubInward --> DispatchLastMile[Assign Last-Mile Delivery Rider]
    DispatchLastMile --> TransitToCustomer[Rider Travels to Customer Address]
    
    TransitToCustomer --> CustomerVerification{Delivery Verification}
    CustomerVerification -->|Customer Shares Delivery OTP OR Scans Rider QR| CustomerOTPCheck[Backend Validates `delivery_otp` / `delivery_qr_token`]
    
    CustomerOTPCheck -- Valid --> StatusDelivered[Update Order Status = 'delivered'\nMark Tracking Complete]
    
    StatusDelivered --> FinancialSettlement[Calc Rider Earnings in `rider_earnings`\nCalc Vendor Payout in `vendor_payouts`]
    FinancialSettlement --> End([Order Fulfillment Completed])
```

---

### Chart 5: On-Demand Service & Ticket Lifecycle Data Flow

Shows how clients log service tickets or asset requests, how vendors are assigned, and how services are fulfilled and reviewed.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client / Customer
    participant System as Vitthal Backend Client
    participant Admin as Admin / Vendor
    participant DB as Database

    Client->>System: POST /client-assets (Register Equipment / Asset Details)
    System->>DB: Store Asset in `client_assets`
    System-->>Client: Return Asset Confirmation

    Client->>System: POST /service-tickets (Select Asset, Issue Category, Description)
    System->>DB: Create Ticket in `service_tickets` (Status = 'open')
    System-->>Admin: Alert Admin / Service Vendor of New Ticket

    Admin->>System: POST /service-tickets/:id/assign-vendor (Assign Vendor ID)
    System->>DB: Link Vendor to Ticket & set status = 'assigned'
    System-->>Client: Notify Client of Service Technician Assignment

    Vendor->>System: POST /service-tickets/:id/quotation (Estimated Parts/Labor Cost)
    System->>DB: Create `service_ticket_quotation`
    System-->>Client: Request Quotation Approval

    Client->>System: POST /service-tickets/:id/approve-quotation
    System->>DB: Update Ticket Status = 'in_progress'

    Vendor->>System: PUT /service-tickets/:id/status (Status = 'resolved', Upload Job Document)
    System->>DB: Store Work Completion Document in S3 & update Ticket
    System-->>Client: Notify Service Resolution

    Client->>System: POST /service-tickets/:id/review (Rating, Review Text)
    System->>DB: Insert into `service_reviews` & update Vendor Rating
    System-->>Client: Ticket Closed
```

---

### Chart 6: Authentication, Real-Time Socket Messaging & File Storage Flow

Illustrates secure user sessions via JWT refresh rotation, WebSocket real-time chat, and AWS S3 direct upload presigning.

```mermaid
sequenceDiagram
    autonumber
    actor User as User (Client / Vendor / Rider)
    participant Proxy as Next.js Edge Middleware
    participant Backend as Backend API Server
    participant Socket as Socket.io Server
    participant S3 as AWS S3 Storage Service

    %% Part 1: Authentication
    Note over User, Backend: 1. Authentication & Cookie Handling
    User->>Backend: POST /auth/login (Email, Password)
    Backend->>Backend: Verify Hash with bcrypt
    Backend-->>User: Return Access Token & Set HttpOnly `vendorRefreshToken` Cookie

    User->>Proxy: Request Protected Route (/dashboard, /orders)
    Proxy->>Proxy: Decode & Verify Refresh Token (`decodeJwt`)
    alt Token Valid & Role Authorized
        Proxy-->>User: Allow Access to Requested Page
    else Token Expired / Invalid Role
        Proxy-->>User: Clear Cookie & Redirect to /login
    end

    %% Part 2: Real-time Socket Communication
    Note over User, Socket: 2. Real-Time Socket.io Connection & Chat
    User->>Socket: Connect to Socket Server (Pass JWT Handshake)
    Socket->>Socket: Verify Token & Register Client Socket ID
    User->>Socket: Emit "send_message" (Receiver ID, Room ID, Text)
    Socket->>Backend: Persist in `vendor_chat_messages`
    Socket-->>User: Broadcast Message to Receiver Room

    %% Part 3: AWS S3 Media Uploads
    Note over User, S3: 3. Secure AWS S3 Media Uploads
    User->>Backend: POST /media/presigned-url (File Name, File Type, Folder)
    Backend->>Backend: Call AWS S3 Presigner (@aws-sdk/s3-request-presigner)
    Backend-->>User: Return Upload Presigned URL & Final Image URL
    User->>S3: PUT File Binary directly to S3 Presigned URL
    S3-->>User: 200 OK Upload Successful
    User->>Backend: Save Final Image URL in Product/Ticket Entity
```

---

## 4. Key Summary Table of Database Entities

| Entity / Table Name | Primary Role in Ecosystem | Key Relational Foreign Keys |
| :--- | :--- | :--- |
| `users` | Master accounts for Clients, Vendors, Delivery Agents, Admins. | Base user record linked to `client`, `vendors`, `delivery_agents`. |
| `products` / `product_variants` | Product catalog items and customizable variants. | `category`, `subcategory_id`, `created_by_user_id`. |
| `vendor_products` | Vendor-specific stock levels, pricing, MOQ, and quotation triggers. | `product_id`, `product_variant_id`, `vendor_id`. |
| `carts` / `cart_items` | Shopping basket for direct product & service purchases. | `user_id`, `product_variant_id`, `vendor_id`. |
| `orders` / `order_items` | Finalized binding orders (direct sales or converted RFQs). | `user_id`, `vendor_id`, `cart_id`. |
| `quotation_requests` | B2B negotiation requests (RFQ) with custom pricing & token terms. | `user_id`, `vendor_id`, `product_id`, `order_id`. |
| `order_route_plan` | Multi-stop transit legs connecting vendors, FC hubs, and riders. | `order_id`, `fulfillment_center_id`, `pickup_rider_id`. |
| `delivery_agents` | Rider profiles, vehicle registration, KYC status, push tokens, live GPS. | `user_id`, `fulfillment_center_id`. |
| `service_tickets` | Customer maintenance and support tickets. | `client_user_id`, `assigned_vendor_id`, `asset_id`. |
| `payments` | Razorpay transactions, token splits, and payment verification records. | `user_id`, `quotation_request_id`, `order_ids`. |

---
*Document generated for Vitthal Project Architecture & Workflow Documentation.*
