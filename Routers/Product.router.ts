import { Router } from "express";
import multer from "multer";
import { addProductController, deleteProduct, getAllProducts, getProductById, getProductByName, getProductsByCategory, getCategories, updateProduct, addVendorProductController, getVendorProductsController, addProductSpecificationsController, getRankedVendors, getRelatedProducts, getVendorProductByIdController, updateVendorProductController, getVendorProductAnalyticsController, getProductReviewsController, uploadProductImagesController, getPublicProductReviewsController } from "../Controllers/Product.controller";

import { authMiddleware } from "../Middleware/AuthMiddleware";
import { requireApprovedVendor } from "../Middleware/VendorApprovalMiddleware";

const productRouter = Router();

// Configure Multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB limit
  },
});
// Public routes
productRouter.get("/getAllProducts", getAllProducts);
productRouter.get("/getCategories", getCategories);
productRouter.get("/getProductById/:productId", getProductById);
productRouter.get("/getProductsByCategory/:category", getProductsByCategory);
productRouter.get("/getProductByName", getProductByName);
productRouter.get("/getRankedVendors/:productId", getRankedVendors);
productRouter.get("/getRelatedProducts/:productId", getRelatedProducts);
productRouter.get("/getProductReviews/:productId", getPublicProductReviewsController);

// Secured routes
productRouter.use(authMiddleware);
productRouter.use(requireApprovedVendor);

productRouter.get("/getVendorProducts", getVendorProductsController);
productRouter.get("/vendor/product/:productId", getVendorProductByIdController);
productRouter.put("/vendor/product/:productId", updateVendorProductController);
productRouter.get("/vendor/product/:productId/analytics", getVendorProductAnalyticsController);
productRouter.get("/vendor/product/:productId/reviews", getProductReviewsController);
productRouter.post("/addProduct", addProductController);
productRouter.post("/addVendorProduct", addVendorProductController);
productRouter.post("/addProductSpecifications", addProductSpecificationsController);
productRouter.post("/uploadProductImages", upload.array("images", 5), uploadProductImagesController);
productRouter.delete("/deleteProduct", deleteProduct);
productRouter.put("/updateProduct", updateProduct);

export default productRouter;