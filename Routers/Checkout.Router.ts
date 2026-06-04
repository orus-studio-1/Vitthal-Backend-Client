import { Router } from "express";
import { 
    placeOrderController, 
    createPaymentOrderController, 
    verifyPaymentController 
} from "../Controllers/Checkout.controller";
import { authMiddleware } from "../Middleware/AuthMiddleware";

const checkoutRouter = Router();

checkoutRouter.use(authMiddleware);

checkoutRouter.post("/placeOrder", placeOrderController);
checkoutRouter.post("/create-payment-order", createPaymentOrderController);
checkoutRouter.post("/verify-payment", verifyPaymentController);

export default checkoutRouter;