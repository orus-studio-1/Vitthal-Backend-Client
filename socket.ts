import { Server as HttpServer } from "http";
import crypto from "crypto";
import { Server, Namespace, Socket } from "socket.io";
import pool from "./DbConnect";
import { verifyToken } from "./helpers/jwt.helper";
import { isAllowedOrigin } from "./shared/CorsOrigins.shared";

let io: Server | null = null;
let notificationNamespace: Namespace | null = null;
let hireChatNamespace: Namespace | null = null;

type SocketUser = { userId: string; role: string };

const ALL_ROLES = ["client", "worker", "vendor", "fulfillment_center", "delivery_agent", "admin", "super_admin"];
const HIRE_CHAT_ROLES = ["client", "worker"];

const parseCookies = (header: string | undefined): Record<string, string> => {
    if (!header) return {};
    return Object.fromEntries(header.split(";").map((part) => {
        const [key, ...value] = part.trim().split("=");
        return [key, decodeURIComponent(value.join("="))];
    }).filter(([key]) => Boolean(key)));
};

/**
 * Resolves the signed-in users for a socket from the role session cookies (web) or
 * `auth.token` / `auth.refreshToken` in the handshake (mobile apps), and confirms each session is still active.
 */
async function resolveSocketUsers(socket: Socket, roles: string[]): Promise<SocketUser[]> {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const candidates: Array<{ token: string; type: "access" | "refresh"; role?: string }> = [];

    const authToken = socket.handshake.auth?.token;
    if (typeof authToken === "string" && authToken) {
        candidates.push({ token: authToken.replace(/^Bearer\s+/i, ""), type: "access" });
    }
    // Lets long-lived mobile sockets reconnect after the 30-minute access token expires.
    const authRefreshToken = socket.handshake.auth?.refreshToken;
    if (typeof authRefreshToken === "string" && authRefreshToken) {
        candidates.push({ token: authRefreshToken, type: "refresh" });
    }
    for (const role of roles) {
        const accessToken = cookies[`${role}AccessToken`];
        const refreshToken = cookies[`${role}RefreshToken`];
        if (accessToken) candidates.push({ token: accessToken, type: "access", role });
        if (refreshToken) candidates.push({ token: refreshToken, type: "refresh", role });
    }

    const users = new Map<string, SocketUser>();
    for (const candidate of candidates) {
        try {
            const decoded = verifyToken(candidate.token, candidate.type, { logErrors: false });
            if (!roles.includes(decoded.role) || (candidate.role && candidate.role !== decoded.role)) continue;
            if (!users.has(decoded.userId)) users.set(decoded.userId, { userId: decoded.userId, role: decoded.role });
        } catch {
            // Expired or invalid token; try the next one.
        }
    }
    if (users.size === 0) return [];

    const { rows } = await pool.query(
        `SELECT id::text AS id FROM users
         WHERE id::text = ANY($1::text[])
           AND refresh_token IS NOT NULL
           AND (is_active OR deletion_requested_at IS NOT NULL)`,
        [[...users.keys()]]
    );
    const activeIds = new Set(rows.map((row) => row.id as string));
    return [...users.values()].filter((user) => activeIds.has(user.userId));
}

const isAdminEmitter = (socket: Socket): boolean => {
    const expected = process.env.SOCKET_ADMIN_EMITTER_KEY;
    const provided = socket.handshake.auth?.emitterKey;
    if (!expected || typeof provided !== "string") return false;
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
};

export function initSocket(server: HttpServer) {
    io = new Server(server, {
        cors: {
            origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
            credentials: true
        }
    });

    // Create a dedicated namespace strictly for notifications to optimize scalability
    notificationNamespace = io.of("/notifications");
    hireChatNamespace = io.of("/hire-chat");

    hireChatNamespace.use(async (socket, next) => {
        try {
            const users = await resolveSocketUsers(socket, HIRE_CHAT_ROLES);
            if (users.length === 0) return next(new Error("Unauthorized"));
            (socket.data as any).users = users;
            return next();
        } catch {
            return next(new Error("Unauthorized"));
        }
    });

    hireChatNamespace.on("connection", (socket) => {
        socket.on("join_request", async (requestId: string) => {
            const users = (socket.data as any).users as SocketUser[];
            if (!requestId || !users?.length) return;
            for (const user of users) {
                const result = await pool.query(
                    `SELECT hr.id FROM hire_requests hr
                     JOIN employee_candidates ec ON ec.id = hr.candidate_id
                     WHERE hr.id = $1 AND hr.status = 'accepted' AND (
                       ($2 = 'client' AND hr.requested_by_user_id = $3)
                       OR ($2 = 'worker' AND ec.registered_by_user_id = $3)
                     )`,
                    [requestId, user.role, user.userId]
                );
                if (result.rows.length > 0) {
                    socket.join(`hire-request:${requestId}`);
                    return;
                }
            }
        });
    });

    notificationNamespace.use(async (socket, next) => {
        try {
            // The Admin Backend connects with a shared secret to forward notifications.
            if (isAdminEmitter(socket)) {
                (socket.data as any).isAdminEmitter = true;
                return next();
            }
            const users = await resolveSocketUsers(socket, ALL_ROLES);
            if (users.length === 0) return next(new Error("Unauthorized"));
            (socket.data as any).users = users;
            return next();
        } catch {
            return next(new Error("Unauthorized"));
        }
    });

    notificationNamespace.on("connection", (socket) => {
        if ((socket.data as any).isAdminEmitter) {
            socket.join("__admin_emitters__");

            // Handle forwarded notifications from the Admin Backend
            socket.on("forward_notification", (payload: { targetUserId: string; notification: any }) => {
                if (payload?.targetUserId && payload?.notification) {
                    notificationNamespace!.to(payload.targetUserId).emit("notification", payload.notification);
                }
            });
            return;
        }

        // Rooms come from the authenticated session, never from the client. Clients still emit
        // "join" with their userId; that event is now ignored.
        for (const user of (socket.data as any).users as SocketUser[]) {
            socket.join(user.userId);
        }
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
