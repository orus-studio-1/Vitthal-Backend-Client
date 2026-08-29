import { Router } from "express";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import {
    browseCandidatesController,
    getCandidateDetailController,
    selfRegisterCandidateController,
    selfUploadDocumentController,
    createHireRequestController,
    getMyHireRequestsController,
    getMyCandidateProfileController,
} from "../Controllers/Hiring.controller";

const hiringRouter = Router();

// Public routes (no auth required)
hiringRouter.get("/candidates", browseCandidatesController);
hiringRouter.get("/candidates/:id", getCandidateDetailController);

// Auth-protected routes
hiringRouter.use(authMiddleware);

// Self-registration (client portal: "Become an Employee / Find a Job")
hiringRouter.post("/register", selfRegisterCandidateController);
hiringRouter.post("/register/documents", selfUploadDocumentController);
hiringRouter.get("/my-profile", getMyCandidateProfileController);

// Hire requests
hiringRouter.post("/requests", createHireRequestController);
hiringRouter.get("/my-requests", getMyHireRequestsController);

export default hiringRouter;
