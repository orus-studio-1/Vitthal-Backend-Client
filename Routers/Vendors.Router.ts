import { Router } from "express";

import { addVendorController, createVendorAddress, getVendorCategoriesController, getVendorDetailsController, updateVendorAddress, updateVendorBasicDetailsController, completeVendorSetupController, getVendorIdStatusController, checkVendorSetupStatus, lookupPincodeController } from "../Controllers/Vendors.Controller";
import { getVendorDashboardController, getVendorAnalyticsController } from "../Controllers/VendorDashboard.Controller";
import { getVendorProductByIdController, updateVendorProductController, deleteVendorProductController } from "../Controllers/Product.controller";

import { authMiddleware } from "../Middleware/AuthMiddleware";
import { requireApprovedVendor } from "../Middleware/VendorApprovalMiddleware";

const vendorsRouter = Router();
vendorsRouter.get("/pincode/:pincode", lookupPincodeController);
vendorsRouter.use(authMiddleware);

vendorsRouter.post("/createVendor", addVendorController);
vendorsRouter.post("/completeSetup", completeVendorSetupController);
vendorsRouter.put("/updateVendorBasicDetails", updateVendorBasicDetailsController);
vendorsRouter.post("/createVendorAddress", createVendorAddress);
vendorsRouter.put("/updateVendorAddress", updateVendorAddress);

vendorsRouter.get("/getVendorCategories", getVendorCategoriesController);
vendorsRouter.get("/getVendorDetails", getVendorDetailsController);
vendorsRouter.get("/checkSetupStatus", checkVendorSetupStatus);
vendorsRouter.get("/vendorIdStatus", getVendorIdStatusController);
vendorsRouter.get("/dashboard", requireApprovedVendor, getVendorDashboardController);
vendorsRouter.get("/analytics", requireApprovedVendor, getVendorAnalyticsController);
vendorsRouter.get("/product/:productId", requireApprovedVendor, getVendorProductByIdController);
vendorsRouter.put("/product/:productId", requireApprovedVendor, updateVendorProductController);
vendorsRouter.delete("/product/:productId", requireApprovedVendor, deleteVendorProductController);

export default vendorsRouter;
