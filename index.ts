import cookieParser from 'cookie-parser';
import express from 'express';
import dotenv from 'dotenv';
import dns from 'dns';
import cors, { type CorsOptions } from 'cors';

try {
    dns.setDefaultResultOrder('ipv4first');
} catch (err) {
    // Ignore if not supported in older node
}

import pool from './DbConnect';
import { runDatabaseMigrations } from './DbMigrate';
import { ensureDispatchColumnsOptional, ensureEmailUniquePerRole, ensureNotificationRules } from './services/notificationRules.service';
import productRouter from './Routers/Product.router';
import clientRouter from './Routers/ClientRouter';
import checkoutRouter from './Routers/Checkout.Router';
import authRouter from './Routers/Auth.router';
import vendorsRouter from './Routers/Vendors.Router';
import cartRouter from './Routers/Cart.router';
import wishlistRouter from './Routers/Wishlist.router';
import orderRouter from './Routers/Order.router';
import reviewRouter from './Routers/Review.router';
import serviceRouter from './Routers/Service.router';
import serviceCartRouter from './Routers/ServiceCart.router';
import quotationRouter from './Routers/Quotation.router';
import notificationRouter from './Routers/Notification.router';
import uploadRouter from './Routers/Upload.router';
import deliveryRouter from './Routers/Delivery.router';
import hiringRouter from './Routers/Hiring.router';
import serviceHubRouter from './Routers/ServiceHub.router';
import { startAbandonedReminderJob } from './jobs/abandonedReminder.job';
import { startAccountDeletionJob } from './jobs/accountDeletion.job';
import { createServer } from 'http';
import { initSocket } from './socket';
import contactRouter from './Routers/Contact.router';
import { isAllowedOrigin } from './shared/CorsOrigins.shared';

dotenv.config();

// Create an Express application
const app = express();
const httpServer = createServer(app);
initSocket(httpServer);
const PORT = process.env.PORT || 9000;


//cors configuration
const corsOptions: CorsOptions = {
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
            callback(null, true);
            return;
        }
        if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
            console.log("Blocked CORS origin:", origin);
        }

        return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Accept',
        'Authorization',
        'Content-Type',
        'x-request-from',
        'x-refresh-token',
    ],
    exposedHeaders: ['x-access-token'],
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

//using Middleware
app.use(cookieParser());
app.use(express.json({ limit: '5' + 'mb' }));
app.use(express.urlencoded({ limit: '5' + 'mb', extended: true }));

app.use("/api/auth", authRouter);
app.use("/api/delivery", deliveryRouter);
app.use("/api/products", productRouter);
app.use("/api/vendors", vendorsRouter);
app.use("/api/client", clientRouter);
app.use("/api/cart", cartRouter);
app.use("/api/wishlist", wishlistRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/orders", orderRouter);
app.use("/api/reviews", reviewRouter);
app.use("/api/services", serviceRouter);
app.use("/api/service-cart", serviceCartRouter);
app.use("/api/quotations", quotationRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/hiring", hiringRouter);
app.use("/api/service-hub", serviceHubRouter);
app.use("/api", uploadRouter);
app.use("/api/contact",contactRouter)

async function startServer() {
    try {
        await pool.connect()
            .then((client) => {
                client.release();
                console.log('Connected to the database successfully!');
            });

        // Set RUN_MIGRATIONS_ON_START=false once the deploy pipeline runs `npm run db:deploy`,
        // so multiple instances don't race each other applying migrations at boot.
        if (process.env.RUN_MIGRATIONS_ON_START !== 'false') {
            try {
                await runDatabaseMigrations();
            } catch (schemaError) {
                console.error("Database migration failed; the server will start but the schema may be out of date:", schemaError);
            }
        } else {
            console.log("Skipping database migrations on start (RUN_MIGRATIONS_ON_START=false).");
        }
        try {
            await ensureNotificationRules();
        } catch (rulesError) {
            console.error("[NotificationRules] Could not update the notification rules:", rulesError);
        }
        try {
            await ensureDispatchColumnsOptional();
        } catch (columnsError) {
            console.error("[DispatchColumns] Could not update the dispatch columns:", columnsError);
        }
        try {
            await ensureEmailUniquePerRole();
        } catch (emailIndexError) {
            console.error("[UsersEmail] Could not allow one account per role for an email:", emailIndexError);
        }
        startAbandonedReminderJob();
        startAccountDeletionJob();

        httpServer.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}🚀🚀`);
        });
    } catch (error) {
        console.error("Failed to start backend client server:", error);
        process.exit(1);
    }
}

void startServer();
