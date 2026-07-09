import { Router } from "express";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import { requireApprovedVendor } from "../Middleware/VendorApprovalMiddleware";
import {
    browseServicesController,
    getServiceDetailController,
    createServiceBookingController,
    getMyBookingsController,
    generateCompletionOtpController,
    createServiceQuotationController,
    getMyServiceQuotationsController,
    getServiceQuotationDetailController,
    respondServiceQuotationController,
    submitServiceReviewController,
    getVendorServiceBookingsController,
    getVendorServiceBookingByIdController,
    vendorCompleteBookingController,
    getVendorServiceQuotationsController,
} from "../Controllers/Service.controller";

const serviceRouter = Router();

serviceRouter.get("/", browseServicesController);
serviceRouter.get("/:id", getServiceDetailController);

serviceRouter.use(authMiddleware);

serviceRouter.post("/bookings", createServiceBookingController);
serviceRouter.get("/client/bookings", getMyBookingsController);
serviceRouter.post("/client/bookings/:id/otp", generateCompletionOtpController);

serviceRouter.post("/quotations", createServiceQuotationController);
serviceRouter.get("/client/quotations", getMyServiceQuotationsController);
serviceRouter.get("/quotations/:id", getServiceQuotationDetailController);
serviceRouter.post("/quotations/:id/respond", respondServiceQuotationController);

serviceRouter.post("/reviews", submitServiceReviewController);

serviceRouter.get("/vendor/bookings", requireApprovedVendor, getVendorServiceBookingsController);
serviceRouter.get("/vendor/bookings/:id", requireApprovedVendor, getVendorServiceBookingByIdController);
serviceRouter.post("/vendor/bookings/:id/complete", requireApprovedVendor, vendorCompleteBookingController);
serviceRouter.get("/vendor/quotations", requireApprovedVendor, getVendorServiceQuotationsController);
serviceRouter.get("/vendor/quotations/:id", requireApprovedVendor, getServiceQuotationDetailController);
serviceRouter.post("/vendor/quotations/:id/respond", requireApprovedVendor, respondServiceQuotationController);

export default serviceRouter;
