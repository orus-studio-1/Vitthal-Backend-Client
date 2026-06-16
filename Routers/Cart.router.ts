import { Router } from "express";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import {
    addCartItemController,
    getCartDataController,
    updateCartItemController,
    removeCartItemController,
    clearCartController,
    shareCartController,
    getSharedCartController
} from "../Controllers/Cart.Controller";

const cartRouter = Router();

cartRouter.get("/", authMiddleware, getCartDataController);
cartRouter.post("/", authMiddleware, addCartItemController);
cartRouter.patch("/item", authMiddleware, updateCartItemController);
cartRouter.delete("/item", authMiddleware, removeCartItemController);
cartRouter.delete("/", authMiddleware, clearCartController);

// Shareable cart endpoints
cartRouter.post("/share", authMiddleware, shareCartController);
cartRouter.get("/share/:id", getSharedCartController);

export default cartRouter;