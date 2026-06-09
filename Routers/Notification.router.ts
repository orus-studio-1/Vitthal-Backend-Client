import { Router } from "express";
import { authMiddleware } from "../Middleware/AuthMiddleware";
import {
    getNotificationsController,
    getUnreadCountController,
    markNotificationReadController,
    markAllNotificationsReadController,
} from "../Controllers/Notification.controller";

const notificationRouter = Router();

notificationRouter.use(authMiddleware);

notificationRouter.get("/", getNotificationsController);
notificationRouter.get("/unread-count", getUnreadCountController);
notificationRouter.put("/read-all", markAllNotificationsReadController);
notificationRouter.put("/:id/read", markNotificationReadController);

export default notificationRouter;
