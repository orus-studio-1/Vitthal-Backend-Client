import { Router } from "express";
import {
    getServiceCategoriesWithSchema,
    getMyAssets,
    createClientAsset,
    updateClientAsset,
    deleteClientAsset,
    createServiceTicket,
    getMyServiceTickets,
    getServiceTicketDetail,
    acceptTicketQuote,
    verifyTicketOtp,
} from "../Controllers/ServiceHub.controller";
import { authMiddleware } from "../Middleware/AuthMiddleware";

const router = Router();

// Public: Service Categories & Dynamic form schema
router.get("/categories", getServiceCategoriesWithSchema);

// Auth-protected routes
router.use(authMiddleware);

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
router.post("/tickets/:id/complete-otp", verifyTicketOtp);

export default router;
