import cookieParser from 'cookie-parser';
import express from 'express';
import dotenv from 'dotenv';
import cors, { type CorsOptions } from 'cors';
import pool from './DbConnect';
import { ensureMarketplaceSchema } from './DbSetup';
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
import { startAbandonedReminderJob } from './jobs/abandonedReminder.job';
import { startAccountDeletionJob } from './jobs/accountDeletion.job';
import { createServer } from 'http';
import { initSocket } from './socket';

dotenv.config();

// Create an Express application
const app = express();
const httpServer = createServer(app);
initSocket(httpServer);
const PORT = 9000;


//cors configuration
const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:8081',
    'http://localhost:4000',
    'http://localhost:4001',
    'http://192.168.29.150:4000',
    'http://192.168.1.11:3000',
    'http://192.168.1.11:3001',
    'https://mtwo.in',
    'https://vendor.mtwo.in',
    'https://admin.mtwo.in',
]);

const corsOptions: CorsOptions = {
    origin(origin, callback) {
        if (!origin) {
            callback(null, true);
            return;
        }

        const isLocalhost = /^http:\/\/localhost:\d+$/.test(origin);
        const isLanIp = /^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin);
        const isVercelPreview = /^https:\/\/.*\.vercel\.app$/.test(origin);

        if (allowedOrigins.has(origin) || isLocalhost || isLanIp || isVercelPreview) {
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
app.use("/api", uploadRouter);

async function startServer() {
    try {
        await pool.connect()
            .then((client) => {
                client.release();
                console.log('Connected to the database successfully!');
            });

        try {
            await ensureMarketplaceSchema();
        } catch (schemaError) {
            console.warn("Non-fatal: Schema sync bypassed or completed concurrently in another process:", schemaError);
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
