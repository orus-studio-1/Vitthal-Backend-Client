// import { Router } from "express";
// import { authMiddleware } from "../Middleware/AuthMiddleware";
// import {
//     browseCandidatesController,
//     getCandidateDetailController,
//     selfRegisterCandidateController,
//     selfUploadDocumentController,
//     createHireRequestController,
//     getMyHireRequestsController,
//     getWorkerHireRequestsController,
//     updateWorkerHireRequestController,
//     getHireConversationController,
//     sendHireMessageController,
//     proposeHireAmountController,
//     acceptHireOfferController,
//     createHirePaymentOrderController,
//     verifyHirePaymentController,
//     getWorkerPaymentHistoryController,
//     confirmHireContractCompletionController,
//     getMyCandidateProfileController,
//     updateMyCandidateProfileController,
// } from "../Controllers/Hiring.controller";

// const hiringRouter = Router();

// // Public routes (no auth required)
// hiringRouter.get("/candidates", browseCandidatesController);
// hiringRouter.get("/candidates/:id", getCandidateDetailController);

// // Auth-protected routes
// hiringRouter.use(authMiddleware);

// // Self-registration (client portal: "Become an Employee / Find a Job")
// hiringRouter.post("/register", selfRegisterCandidateController);
// hiringRouter.post("/register/documents", selfUploadDocumentController);
// hiringRouter.get("/my-profile", getMyCandidateProfileController);
// hiringRouter.patch("/my-profile", updateMyCandidateProfileController);

// // Hire requests: clients create/view requests; workers respond to incoming requests.
// hiringRouter.post("/requests", createHireRequestController);
// hiringRouter.get("/my-requests", getMyHireRequestsController);
// hiringRouter.get("/worker-requests", getWorkerHireRequestsController);
// hiringRouter.patch("/worker-requests/:id", updateWorkerHireRequestController);
// hiringRouter.get("/requests/:id/conversation", getHireConversationController);
// hiringRouter.post("/requests/:id/messages", sendHireMessageController);
// hiringRouter.post("/requests/:id/negotiate", proposeHireAmountController);
// hiringRouter.post("/requests/:id/negotiate/accept", acceptHireOfferController);
// hiringRouter.post("/requests/:id/payment/order", createHirePaymentOrderController);
// hiringRouter.post("/requests/:id/payment/verify", verifyHirePaymentController);
// hiringRouter.get("/worker-payments", getWorkerPaymentHistoryController);
// hiringRouter.post("/requests/:id/complete", confirmHireContractCompletionController);

// export default hiringRouter;


import { Router } from "express";
import { authMiddleware } from "../Middleware/AuthMiddleware";

import {
    browseCandidatesController,
    getCandidateDetailController,
    selfRegisterCandidateController,
    selfUploadDocumentController,
    getMyHireRequestsController,
    getWorkerHireRequestsController,
    getWorkerPaymentHistoryController,
    getMyCandidateProfileController,
    updateMyCandidateProfileController,
} from "../Controllers/Hiring.controller";

import {
    createHireRequestController,
    updateWorkerHireRequestController,
    getHireConversationController,
    sendHireMessageController,
    proposeHireAmountController,
    acceptHireOfferController,
    createHirePaymentOrderController,
    verifyHirePaymentController,
    reconcileHirePaymentController,
    confirmHireContractCompletionController,
    cancelHireRequestController,
    getHiringAccessStatusController,
    createHiringAccessPaymentOrderController,
    verifyHiringAccessPaymentController,
} from "../Controllers/HiringLifecycle.controller";

const hiringRouter = Router();

// Public
hiringRouter.get("/candidates", browseCandidatesController);

// Protected
hiringRouter.use(authMiddleware);

hiringRouter.get(
    "/access",
    getHiringAccessStatusController
);

hiringRouter.post(
    "/access/payment/order",
    createHiringAccessPaymentOrderController
);

hiringRouter.post(
    "/access/payment/verify",
    verifyHiringAccessPaymentController
);

hiringRouter.get("/candidates/:id", getCandidateDetailController);

// Worker profile
hiringRouter.post("/register", selfRegisterCandidateController);
hiringRouter.post("/register/documents", selfUploadDocumentController);
hiringRouter.get("/my-profile", getMyCandidateProfileController);
hiringRouter.patch("/my-profile", updateMyCandidateProfileController);

// Hiring
hiringRouter.post("/requests", createHireRequestController);
hiringRouter.post("/requests/:id/cancel",cancelHireRequestController);
hiringRouter.get(
    "/my-requests",
    getMyHireRequestsController
);

hiringRouter.get(
    "/worker-requests",
    getWorkerHireRequestsController
);

hiringRouter.patch(
    "/worker-requests/:id",
    updateWorkerHireRequestController
);

hiringRouter.get(
    "/requests/:id/conversation",
    getHireConversationController
);

hiringRouter.post(
    "/requests/:id/messages",
    sendHireMessageController
);

hiringRouter.post(
    "/requests/:id/negotiate",
    proposeHireAmountController
);

hiringRouter.post(
    "/requests/:id/negotiate/accept",
    acceptHireOfferController
);

hiringRouter.post(
    "/requests/:id/payment/order",
    createHirePaymentOrderController
);

hiringRouter.post(
    "/requests/:id/payment/verify",
    verifyHirePaymentController
);

hiringRouter.post(
    "/requests/:id/payment/reconcile",
    reconcileHirePaymentController
);

hiringRouter.get(
    "/worker-payments",
    getWorkerPaymentHistoryController
);

hiringRouter.post(
    "/requests/:id/complete",
    confirmHireContractCompletionController
);

export default hiringRouter;