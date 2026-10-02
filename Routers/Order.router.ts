import { Router } from "express";
import {
    getOrdersController,
    getVendorOrdersController,
    getVendorOrderByIdController,
    getOrderTrackingController,
    getVendorOrderTrackingController,
    updateOrderStatusController,
    getVendorPayoutsController,
    getOrderInvoiceController,
    saveOrderDispatchDetailsController,
} from "../Controllers/Order.Controller";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import { requireApprovedVendor } from "../Middleware/VendorApprovalMiddleware";
import multer from "multer";

const orderRouter = Router();

orderRouter.use(authMiddleware);


const allowedMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
];

const uploadDocs = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        if (allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only PDF, JPG or PNG files are allowed"));
        }
    },
});

// Client routes
orderRouter.get("/", getOrdersController);
orderRouter.get("/track/:id", getOrderTrackingController);

// Vendor routes
orderRouter.get("/vendor/payouts", requireApprovedVendor, getVendorPayoutsController);
orderRouter.get("/vendor", requireApprovedVendor, getVendorOrdersController);
orderRouter.get("/vendor/:id/track", requireApprovedVendor, getVendorOrderTrackingController);
orderRouter.get("/vendor/:id", requireApprovedVendor, getVendorOrderByIdController);
orderRouter.put("/vendor/:id/status", requireApprovedVendor, updateOrderStatusController);
orderRouter.get("/:orderId/invoice", getOrderInvoiceController);
orderRouter.post("/vendor/orders/:id/dispatch-details", requireApprovedVendor, uploadDocs.fields([
        { name: "eway_bill", maxCount: 1 },
        { name: "delivery_challan", maxCount: 1 },
        { name: "invoice", maxCount: 1 },
        { name: "lr_document", maxCount: 1 },
    ]),
    saveOrderDispatchDetailsController
);

export default orderRouter;
