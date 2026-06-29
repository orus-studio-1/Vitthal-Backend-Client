import { Router } from "express";
import multer from "multer";

import { addVendorController, createVendorAddress, getVendorCategoriesController, getVendorDetailsController, updateVendorAddress, updateVendorBasicDetailsController, completeVendorSetupController, getVendorIdStatusController, checkVendorSetupStatus, lookupPincodeController } from "../Controllers/Vendors.Controller";
import { getVendorDashboardController, getVendorAnalyticsController } from "../Controllers/VendorDashboard.Controller";
import { getVendorProductByIdController, updateVendorProductController, deleteVendorProductController } from "../Controllers/Product.controller";

import { authMiddleware } from "../Middleware/AuthMiddleware";
import { requireApprovedVendor } from "../Middleware/VendorApprovalMiddleware";

const vendorsRouter = Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
});
vendorsRouter.get("/pincode/:pincode", lookupPincodeController);
vendorsRouter.use(authMiddleware);

vendorsRouter.post("/createVendor", addVendorController);
vendorsRouter.post("/completeSetup", upload.fields([{ name: "signatureImage", maxCount: 1 }]), completeVendorSetupController);
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
