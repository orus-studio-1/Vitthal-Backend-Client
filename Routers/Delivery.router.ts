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
    postRiderDeliverController,
    postRelocateItemController,
    postRiderFailDeliveryController,
    getRiderDashboardStatsController,
    getRiderCompletedDeliveriesController,
    getPendingPickupsController,
    postAssignPickupController,
    postRiderConfirmPickupController,
    getRiderPickupTasksController,
    patchRiderLocationController,
    getRiderLiveDetailsController,
    verifyPickupController,
    verifyDeliveryController
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
deliveryRouter.post("/hub/relocate", authMiddleware, postRelocateItemController);
deliveryRouter.get("/hub/pending-pickups", authMiddleware, getPendingPickupsController);
deliveryRouter.post("/hub/assign-pickup", authMiddleware, postAssignPickupController);

// Rider CRUD / management for Hub Manager
deliveryRouter.get("/riders", authMiddleware, getRidersController);
deliveryRouter.post("/riders", authMiddleware, createRiderController);
deliveryRouter.patch("/riders/:riderId", authMiddleware, patchRiderController);

// Rider dashboard operations (used by delivery agent role)
deliveryRouter.patch("/rider/status", authMiddleware, patchRiderStatusController);
deliveryRouter.patch("/rider/location", authMiddleware, patchRiderLocationController);
deliveryRouter.get("/rider/stats", authMiddleware, getRiderDashboardStatsController);
deliveryRouter.get("/rider/tasks", authMiddleware, getRiderTasksController);
deliveryRouter.get("/rider/completed-deliveries", authMiddleware, getRiderCompletedDeliveriesController);
deliveryRouter.get("/rider/pickup-tasks", authMiddleware, getRiderPickupTasksController);
deliveryRouter.post("/rider/deliver", authMiddleware, postRiderDeliverController);
deliveryRouter.post("/rider/confirm-pickup", authMiddleware, postRiderConfirmPickupController);
deliveryRouter.post("/rider/fail-delivery", authMiddleware, postRiderFailDeliveryController);

deliveryRouter.post("/rider/verify-pickup", authMiddleware, verifyPickupController);
deliveryRouter.post("/rider/verify-delivery", authMiddleware, verifyDeliveryController);

// Hub/Admin Live tracking query
deliveryRouter.get("/riders/:riderId/live", authMiddleware, getRiderLiveDetailsController);

export default deliveryRouter;
