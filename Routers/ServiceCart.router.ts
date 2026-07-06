import { Router } from "express";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import {
    getServiceCartController,
    addServiceCartItemController,
    updateServiceCartItemController,
    removeServiceCartItemController,
    clearServiceCartController,
} from "../Controllers/ServiceCart.controller";

const serviceCartRouter = Router();

serviceCartRouter.use(authMiddleware);

serviceCartRouter.get("/", getServiceCartController);
serviceCartRouter.post("/", addServiceCartItemController);
serviceCartRouter.patch("/item/:id", updateServiceCartItemController);
serviceCartRouter.delete("/item/:id", removeServiceCartItemController);
serviceCartRouter.delete("/", clearServiceCartController);

export default serviceCartRouter;
