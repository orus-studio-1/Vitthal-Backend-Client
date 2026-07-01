import { Router } from "express";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import {
    getHubStatsController,
    getExpectedInboundController,
    postInboundScanController,
    getHubInventoryController,
    patchInventoryItemStatusController,
    getPendingOutboundController,
    postHandoverScanController,
    getRidersController,
    createRiderController,
    patchRiderController,
    patchRiderStatusController,
    getRiderTasksController,
    postRiderDeliverController
} from "../Controllers/Delivery.controller";

const deliveryRouter = Router();

// Hub operations
deliveryRouter.get("/hub/stats", authMiddleware, getHubStatsController);
deliveryRouter.get("/hub/expected-inbound", authMiddleware, getExpectedInboundController);
deliveryRouter.post("/hub/inbound-scan", authMiddleware, postInboundScanController);
deliveryRouter.get("/hub/inventory", authMiddleware, getHubInventoryController);
deliveryRouter.patch("/hub/inventory/:packageId/status", authMiddleware, patchInventoryItemStatusController);
deliveryRouter.get("/hub/pending-outbound", authMiddleware, getPendingOutboundController);
deliveryRouter.post("/hub/handover-scan", authMiddleware, postHandoverScanController);

// Rider CRUD / management for Hub Manager
deliveryRouter.get("/riders", authMiddleware, getRidersController);
deliveryRouter.post("/riders", authMiddleware, createRiderController);
deliveryRouter.patch("/riders/:riderId", authMiddleware, patchRiderController);

// Rider dashboard operations (used by delivery agent role)
deliveryRouter.patch("/rider/status", authMiddleware, patchRiderStatusController);
deliveryRouter.get("/rider/tasks", authMiddleware, getRiderTasksController);
deliveryRouter.post("/rider/deliver", authMiddleware, postRiderDeliverController);

export default deliveryRouter;
