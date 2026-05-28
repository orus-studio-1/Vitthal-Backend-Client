import { Router } from "express";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import {
    createQuotationFromCartController,
    getClientQuotationsController,
    getClientQuotationByIdController,
    respondClientQuotationController,
    getVendorQuotationsController,
    getVendorQuotationByIdController,
    respondVendorQuotationController,
    respondToAdminConfirmationController
} from "../Controllers/Quotation.controller";
import { requireApprovedVendor } from "../Middleware/VendorApprovalMiddleware";

const quotationRouter = Router();

quotationRouter.use(authMiddleware);

// Client routes
quotationRouter.post("/", createQuotationFromCartController);
quotationRouter.get("/", getClientQuotationsController);
quotationRouter.get("/:id", getClientQuotationByIdController);
quotationRouter.post("/:id/respond", respondClientQuotationController);
quotationRouter.post("/:id/admin-respond", respondToAdminConfirmationController);
quotationRouter.post("/:id/admin-response", respondToAdminConfirmationController);

// Vendor routes
quotationRouter.get("/vendor/list", requireApprovedVendor, getVendorQuotationsController);
quotationRouter.get("/vendor/:id", requireApprovedVendor, getVendorQuotationByIdController);
quotationRouter.post("/vendor/:id/respond", requireApprovedVendor, respondVendorQuotationController);

export default quotationRouter;
