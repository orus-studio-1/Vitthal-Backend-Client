import { Router } from "express";
import multer from "multer";
import { addProductController, deleteProduct, getAllProducts, getProductById, getProductByName, getProductsByCategory, getCategories, updateProduct, addVendorProductController, getVendorProductsController, addProductSpecificationsController, getRankedVendors, getRelatedProducts, getVendorProductByIdController, updateVendorProductController, getVendorProductAnalyticsController, getProductReviewsController, uploadProductImagesController, getPublicProductReviewsController, getProductTypes, addProductVariantController, getProductVariantsController } from "../Controllers/Product.controller";

import { authMiddleware } from "../Middleware/AuthMiddleware";
import { requireApprovedVendor } from "../Middleware/VendorApprovalMiddleware";

const productRouter = Router();

// Configure Multer for memory storage (set limits higher for videos)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB limit for video
  },
});
// Public routes
productRouter.get("/getAllProducts", getAllProducts);
productRouter.get("/getCategories", getCategories);
productRouter.get("/getProductTypes", getProductTypes);
productRouter.get("/getProductById/:productId", getProductById);
productRouter.get("/getProductVariants/:productId", getProductVariantsController);
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
productRouter.post("/addProductVariant", addProductVariantController);
productRouter.post("/addProductSpecifications", addProductSpecificationsController);
productRouter.post("/uploadProductImages", upload.fields([{ name: "images", maxCount: 3 }, { name: "video", maxCount: 1 }]), uploadProductImagesController);
productRouter.delete("/deleteProduct", deleteProduct);
productRouter.put("/updateProduct", updateProduct);

export default productRouter;