import { Router } from "express";
import multer from "multer";
import { loginUser, logoutUser, registerUser, getCurrentUser, OTPSendingController, OTPVerificationController, verifyRegisteredUser, resetPasswordController, updateUserNameController } from "../Controllers/Auth.controller";
import { authMiddleware } from "../Middleware/AuthMiddleware";

const authRouter = Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
});

// Register, Login, Logout routes
authRouter.post("/register", registerUser);
authRouter.post("/login", loginUser);
authRouter.post("/logout", logoutUser);
authRouter.post("/reset-password", resetPasswordController)

//OTP ROUTES : 
authRouter.post("/otp/send", OTPSendingController);
authRouter.post("/otp/verify", OTPVerificationController);

// Registration verification route
authRouter.post("/verify-registration", upload.fields([
    { name: "gstCertificate", maxCount: 1 },
    { name: "signatureImage", maxCount: 1 },
]), verifyRegisteredUser);

// Protected route - get current user
authRouter.get("/me", authMiddleware, getCurrentUser);
authRouter.patch("/update-name", authMiddleware, updateUserNameController);

export default authRouter;
