import { Router } from "express";
import multer from "multer";

import {
  addVendorController,
  createVendorAddress,
  getVendorCategoriesController,
  getVendorDetailsController,
  updateVendorAddress,
  updateVendorBasicDetailsController,
  completeVendorSetupController,
  getVendorIdStatusController,
  checkVendorSetupStatus,
  lookupPincodeController,
  getVendorPayoutBankDetailsController,
  updateVendorPayoutBankDetailsController,
} from "../Controllers/Vendors.Controller";
import {
  getVendorDashboardController,
  getVendorAnalyticsController,
} from "../Controllers/VendorDashboard.Controller";
import {
  getVendorProductByIdController,
  updateVendorProductController,
  deleteVendorProductController,
} from "../Controllers/Product.controller";
import {
  createLogisticsVehicle,
  deactivateLogisticsVehicle,
  getMyLogisticsVehicles,
} from "../Controllers/LogisticsVehicles.controller";

import { authMiddleware } from "../Middleware/AuthMiddleware";
import { requireApprovedVendor } from "../Middleware/VendorApprovalMiddleware";

const vendorsRouter = Router();
const payoutChequeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
vendorsRouter.get("/pincode/:pincode", lookupPincodeController);
vendorsRouter.use(authMiddleware);

vendorsRouter.post("/createVendor", addVendorController);
vendorsRouter.post("/completeSetup", completeVendorSetupController);
vendorsRouter.put(
  "/updateVendorBasicDetails",
  updateVendorBasicDetailsController,
);
vendorsRouter.post("/createVendorAddress", createVendorAddress);
vendorsRouter.put("/updateVendorAddress", updateVendorAddress);

vendorsRouter.get("/getVendorCategories", getVendorCategoriesController);
vendorsRouter.get("/getVendorDetails", getVendorDetailsController);
vendorsRouter.get("/payout-bank-details", getVendorPayoutBankDetailsController);
vendorsRouter.put(
  "/payout-bank-details",
  payoutChequeUpload.single("cancelledCheque"),
  updateVendorPayoutBankDetailsController,
);
vendorsRouter.get(
  "/logistics-vehicles",
  requireApprovedVendor,
  getMyLogisticsVehicles,
);
vendorsRouter.post(
  "/logistics-vehicles",
  requireApprovedVendor,
  createLogisticsVehicle,
);
vendorsRouter.delete(
  "/logistics-vehicles/:id",
  requireApprovedVendor,
  deactivateLogisticsVehicle,
);
vendorsRouter.get("/checkSetupStatus", checkVendorSetupStatus);
vendorsRouter.get("/vendorIdStatus", getVendorIdStatusController);
vendorsRouter.get(
  "/dashboard",
  requireApprovedVendor,
  getVendorDashboardController,
);
vendorsRouter.get(
  "/analytics",
  requireApprovedVendor,
  getVendorAnalyticsController,
);
vendorsRouter.get(
  "/product/:productId",
  requireApprovedVendor,
  getVendorProductByIdController,
);
vendorsRouter.put(
  "/product/:productId",
  requireApprovedVendor,
  updateVendorProductController,
);
vendorsRouter.delete(
  "/product/:productId",
  requireApprovedVendor,
  deleteVendorProductController,
);

export default vendorsRouter;
