import { Server as HttpServer } from "http";
import { Server, Namespace } from "socket.io";

let io: Server | null = null;
let notificationNamespace: Namespace | null = null;

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
