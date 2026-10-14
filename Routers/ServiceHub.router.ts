import { Router } from "express";
import {
  getServiceCategoriesWithSchema,
  getVendorServiceCoverage,
  saveVendorServiceCoverage,
  getMyAssets,
  createClientAsset,
  updateClientAsset,
  deleteClientAsset,
  createServiceTicket,
  getMyServiceTickets,
  getServiceTicketDetail,
  acceptTicketQuote,
  createMaintenancePaymentOrder,
  verifyMaintenancePayment,
  createJobInquiryPaymentOrder,
  verifyJobInquiryPayment,
  verifyTicketOtp,
} from "../Controllers/ServiceHub.controller";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import { getAvailableLogisticsVehicleClasses } from "../Controllers/LogisticsVehicles.controller";

const router = Router();

// Public: Service Categories & Dynamic form schema
router.get("/categories", getServiceCategoriesWithSchema);

// Auth-protected routes
router.use(authMiddleware);
router.get("/logistics-vehicles", getAvailableLogisticsVehicleClasses);
router.get("/vendor/coverage", getVendorServiceCoverage);
router.put("/vendor/coverage", saveVendorServiceCoverage);

// Client Asset Registry
router.get("/assets", getMyAssets);
router.post("/assets", createClientAsset);
router.patch("/assets/:id", updateClientAsset);
router.delete("/assets/:id", deleteClientAsset);

// Universal Service Tickets
router.post("/tickets", createServiceTicket);
router.get("/tickets", getMyServiceTickets);
router.get("/tickets/:id", getServiceTicketDetail);
router.post("/tickets/:id/quotes/:quoteId/accept", acceptTicketQuote);
router.post(
  "/tickets/:id/quotes/:quoteId/payment-order",
  createMaintenancePaymentOrder,
);
router.post(
  "/tickets/:id/quotes/:quoteId/verify-payment",
  verifyMaintenancePayment,
);
router.post(
  "/tickets/:id/quotes/:quoteId/job-payment-order",
  createJobInquiryPaymentOrder,
);
router.post(
  "/tickets/:id/quotes/:quoteId/verify-job-payment",
  verifyJobInquiryPayment,
);
router.post("/tickets/:id/complete-otp", verifyTicketOtp);

export default router;
