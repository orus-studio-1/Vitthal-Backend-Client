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
} from "../Controllers/Order.Controller";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import { requireApprovedVendor } from "../Middleware/VendorApprovalMiddleware";

const orderRouter = Router();

orderRouter.use(authMiddleware);

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

export default orderRouter;
