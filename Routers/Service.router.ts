import { Router } from "express";
import multer from "multer";
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
    getSubcategoriesController,
    adminListPendingServicesController,
    adminApproveServiceController,
    adminRejectServiceController,
    reviewServiceController,
    broadcastServiceCategoryRequestController,
    getVendorServiceOfferingsController,
    createServiceAndOfferingController,
    createVendorServiceOfferingController,
    uploadServiceMediaController,
} from "../Controllers/Service.controller";

const serviceRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit for videos & high-res photos
  },
});

serviceRouter.get("/subcategories", getSubcategoriesController);
serviceRouter.get("/", browseServicesController);
serviceRouter.get("/admin/list", adminListPendingServicesController);
serviceRouter.get("/:id", getServiceDetailController);

serviceRouter.use(authMiddleware);

serviceRouter.post("/", createServiceAndOfferingController);
serviceRouter.post("/:id/media", upload.single("file"), uploadServiceMediaController);
serviceRouter.post("/broadcast-request", broadcastServiceCategoryRequestController);
serviceRouter.post("/admin/approve/:id", adminApproveServiceController);
serviceRouter.post("/admin/reject/:id", adminRejectServiceController);
serviceRouter.put("/:id/review", reviewServiceController);

serviceRouter.post("/bookings", createServiceBookingController);
serviceRouter.get("/client/bookings", getMyBookingsController);
serviceRouter.post("/client/bookings/:id/otp", generateCompletionOtpController);

serviceRouter.post("/quotations", createServiceQuotationController);
serviceRouter.get("/client/quotations", getMyServiceQuotationsController);
serviceRouter.get("/quotations/:id", getServiceQuotationDetailController);
serviceRouter.post("/quotations/:id/respond", respondServiceQuotationController);

serviceRouter.post("/reviews", submitServiceReviewController);

serviceRouter.get("/vendor/offerings", requireApprovedVendor, getVendorServiceOfferingsController);
serviceRouter.post("/vendor/offerings", requireApprovedVendor, createVendorServiceOfferingController);
serviceRouter.get("/vendor/bookings", requireApprovedVendor, getVendorServiceBookingsController);
serviceRouter.get("/vendor/bookings/:id", requireApprovedVendor, getVendorServiceBookingByIdController);
serviceRouter.post("/vendor/bookings/:id/complete", requireApprovedVendor, vendorCompleteBookingController);
serviceRouter.get("/vendor/quotations", requireApprovedVendor, getVendorServiceQuotationsController);
serviceRouter.get("/vendor/quotations/:id", requireApprovedVendor, getServiceQuotationDetailController);
serviceRouter.post("/vendor/quotations/:id/respond", requireApprovedVendor, respondServiceQuotationController);

export default serviceRouter;
