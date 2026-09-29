import { Server as HttpServer } from "http";
import { Server, Namespace } from "socket.io";
import pool from "./DbConnect";
import { verifyToken } from "./helpers/jwt.helper";

let io: Server | null = null;
let notificationNamespace: Namespace | null = null;
let hireChatNamespace: Namespace | null = null;

export function initSocket(server: HttpServer) {
    io = new Server(server, {
        cors: {
            origin: (origin, callback) => {
                // Allow all for simplicity, or we can restrict as needed
                callback(null, true);
            },
            credentials: true
        }
    });

    // Create a dedicated namespace strictly for notifications to optimize scalability
    notificationNamespace = io.of("/notifications");
    hireChatNamespace = io.of("/hire-chat");

    hireChatNamespace.use((socket, next) => {
        try {
            const cookies = socket.handshake.headers.cookie || "";
            const cookieMap = Object.fromEntries(cookies.split(";").map((part) => {
                const [key, ...value] = part.trim().split("=");
                return [key, decodeURIComponent(value.join("="))];
            }).filter(([key]) => Boolean(key)));
            const token = cookieMap.workerAccessToken || cookieMap.clientAccessToken;
            if (!token) return next(new Error("Unauthorized"));
            (socket.data as any).user = verifyToken(token, "access", { logErrors: false });
            return next();
        } catch {
            return next(new Error("Unauthorized"));
        }
    });

    hireChatNamespace.on("connection", (socket) => {
        socket.on("join_request", async (requestId: string) => {
            const user = (socket.data as any).user as { userId: string; role: string };
            if (!requestId || !user) return;
            const result = await pool.query(
                `SELECT hr.id FROM hire_requests hr
                 JOIN employee_candidates ec ON ec.id = hr.candidate_id
                 WHERE hr.id = $1 AND hr.status = 'accepted' AND (
                   ($2 = 'client' AND hr.requested_by_user_id = $3)
                   OR ($2 = 'worker' AND ec.registered_by_user_id = $3)
                 )`,
                [requestId, user.role, user.userId]
            );
            if (result.rows.length > 0) socket.join(`hire-request:${requestId}`);
        });
    });

    notificationNamespace.on("connection", (socket) => {

        socket.on("join", (userId: string) => {
            if (userId) {
                socket.join(userId);
            }
        });

        // Admin Backend connects as an emitter to forward notifications to vendors
        socket.on("join_as_admin_emitter", () => {
            socket.join("__admin_emitters__");
        });

        // Handle forwarded notifications from the Admin Backend
        socket.on("forward_notification", (payload: { targetUserId: string; notification: any }) => {
            if (payload?.targetUserId && payload?.notification) {
                notificationNamespace!.to(payload.targetUserId).emit("notification", payload.notification);
            }
        });

        socket.on("disconnect", () => {
        });
    });

    return io;
}

export function getIO(): Server {
    if (!io) {
        throw new Error("Socket.io not initialized!");
    }
    return io;
}

export function sendNotificationToUser(userId: string, notification: any) {
    if (notificationNamespace) {
        notificationNamespace.to(userId).emit("notification", notification);
    } else {
    }
}

export function emitHireChatMessage(requestId: string, message: any) {
    hireChatNamespace?.to(`hire-request:${requestId}`).emit("hire_message", message);
}

export function emitHireRequestUpdated(
    requestId: string,
    userIds: string[] = []
) {
    hireChatNamespace
        ?.to(`hire-request:${requestId}`)
        .emit("hire_request_updated", {
            requestId,
            userIds,
        });
}