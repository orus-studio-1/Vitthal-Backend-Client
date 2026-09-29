import type { Request, Response, NextFunction } from "express";
import { generateAccessToken, verifyToken } from "../helpers/jwt.helper";
import { COOKIE_OPTIONS } from "../shared/CokkieSetting.shared";
import pool from "../DbConnect";

const generateNewAccessToken = (refreshToken: string) => {
    try {
        const decoded = verifyToken(refreshToken, "refresh", { logErrors: false });
        const { userId, username, email, role, vendorType } = decoded;
        const newAccessToken = generateAccessToken(userId, username, email, role, vendorType);
        return newAccessToken;
    }
    catch (error) {
        console.error("Error generating new access token:", error);
        throw new Error("Failed to generate new access token", { cause: error });
    }
}

const handleRoleTokens = async (
    role: string,
    accessToken: string | undefined,
    refreshToken: string | undefined,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        if (accessToken) {
            try {
                const decoded = verifyToken(accessToken, "access", { logErrors: false });
                
                // Verify the decoded role matches the requested role
                if (decoded.role !== role) {
                    throw new Error("Token role mismatch");
                }

                // Query database to verify if user's session is still active (refresh_token is not null/revoked)
                const userResult = await pool.query("SELECT refresh_token, is_active, deletion_requested_at FROM users WHERE id = $1", [decoded.userId]);
                if (userResult.rows.length === 0 || !userResult.rows[0].refresh_token || (!userResult.rows[0].is_active && !userResult.rows[0].deletion_requested_at)) {
                    throw new Error("Session has been logged out or is invalid");
                }

                (req as any).user = decoded;
                return next();
            } catch (error) {
                if (!refreshToken) throw error;
            }
        }

        if (refreshToken) {
            const decoded = verifyToken(refreshToken, "refresh", { logErrors: false });
            
            if (decoded.role !== role) {
                throw new Error("Token role mismatch");
            }

            // Query database to verify if user's session is still active (refresh_token is not null/revoked)
            const userResult = await pool.query("SELECT refresh_token, is_active, deletion_requested_at FROM users WHERE id = $1", [decoded.userId]);
            if (userResult.rows.length === 0 || !userResult.rows[0].refresh_token || (!userResult.rows[0].is_active && !userResult.rows[0].deletion_requested_at)) {
                throw new Error("Session has been logged out or is invalid");
            }

            const newAccessToken = generateNewAccessToken(refreshToken);
            res.cookie(`${role}AccessToken`, newAccessToken, { ...COOKIE_OPTIONS, maxAge: 30 * 60 * 1000 });
            res.setHeader("x-access-token", newAccessToken);
            (req as any).user = decoded;
            return next();
        }

        // No valid tokens found - clear any lingering auth cookies
        res.clearCookie(`${role}AccessToken`, COOKIE_OPTIONS);
        res.clearCookie(`${role}RefreshToken`, COOKIE_OPTIONS);
        return res.status(401).json({ message: "Unauthorized! No valid tokens provided." });

    }
    catch (_error) {
        // Invalid or expired sessions are an expected authentication outcome.
        try { res.clearCookie(`${role}AccessToken`, COOKIE_OPTIONS); } catch { };
        try { res.clearCookie(`${role}RefreshToken`, COOKIE_OPTIONS); } catch { };
        return res.status(401).json({ message: "Session expired or invalid. Please sign in again." });
    }
}

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const requestFrom = req.headers["x-request-from"];
        const authorization = req.headers.authorization;
        const usesHeaderAuth = typeof authorization === "string";
        const headerRefreshToken = typeof req.headers["x-refresh-token"] === "string"
            ? req.headers["x-refresh-token"]
            : undefined;
        const bearerToken = authorization?.startsWith("Bearer ")
            ? authorization.slice(7).trim()
            : undefined;

        const validMiddlewareRoles = new Set(["client", "worker", "vendor", "fulfillment_center", "delivery_agent", "admin", "super_admin"]);

        if (typeof requestFrom === "string" && validMiddlewareRoles.has(requestFrom)) {
            const role = requestFrom;
            const accessToken = usesHeaderAuth ? bearerToken : req.cookies[`${role}AccessToken`];
            const refreshToken = usesHeaderAuth ? headerRefreshToken : req.cookies[`${role}RefreshToken`];
            return await handleRoleTokens(role, accessToken, refreshToken, req, res, next);
        } else {
            return res.status(400).json({ message: "Bad Request! Missing or invalid 'x-request-from' header." });
        }

    } catch (error) {
        console.error("Error verifying tokens:", error);
        return res.status(401).json({ message: "Unauthorized! Failed to verify Tokens." });
    }
}
