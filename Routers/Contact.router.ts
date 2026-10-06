import { Router } from "express";
import { clientEnquiryController } from "../Controllers/Contact.controller";

const contactRouter = Router();

contactRouter.post("/", clientEnquiryController) 

export default contactRouter;