import type { Request, Response, NextFunction } from "express";
import { generateAccessToken, verifyToken } from "../helpers/jwt.helper";
import { COOKIE_OPTIONS } from "../shared/CokkieSetting.shared";

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
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

        if (requestFrom === "client") {
            const accessToken = usesHeaderAuth ? bearerToken : req.cookies.clientAccessToken;
            const refreshToken = usesHeaderAuth ? headerRefreshToken : req.cookies.clientRefreshToken;
            return handleClientTokens(accessToken, refreshToken, req, res, next);
        }
        else if (requestFrom === "vendor") {
            const accessToken = usesHeaderAuth ? bearerToken : req.cookies.vendorAccessToken;
            const refreshToken = usesHeaderAuth ? headerRefreshToken : req.cookies.vendorRefreshToken;
            return handleVendorTokens(accessToken, refreshToken, req, res, next);
        }
        else {
            return res.status(400).json({ message: "Bad Request! Missing or invalid 'x-request-from' header." });
        }

    } catch (error) {
        console.error("Error verifying tokens:", error);
        return res.status(401).json({ message: "Unauthorized! Failed to verify Tokens." });
    }
}

//helpers : 
const generateNewAccessToken = (refreshToken: string) => {
    try {
        const decoded = verifyToken(refreshToken, "refresh", { logErrors: false });
        const { userId, username, email, role } = decoded;
        const newAccessToken = generateAccessToken(userId, username, email, role);
        return newAccessToken;
    }
    catch (error) {
        console.error("Error generating new access token:", error);
        throw new Error("Failed to generate new access token");
    }
}


const handleClientTokens = (accessToken: string | undefined, refreshToken: string | undefined, req: Request, res: Response, next: NextFunction) => {
    try {
        if (accessToken) {
            try {
                const decoded = verifyToken(accessToken, "access", { logErrors: false });
                (req as any).user = decoded;
                return next();
            } catch (error) {
                if (!refreshToken) throw error;
            }
        }

        if (refreshToken) {
            const decoded = verifyToken(refreshToken, "refresh", { logErrors: false });
            const newAccessToken = generateNewAccessToken(refreshToken);
            res.cookie("clientAccessToken", newAccessToken, { ...COOKIE_OPTIONS, maxAge: 30 * 60 * 1000 });
            res.setHeader("x-access-token", newAccessToken);
            (req as any).user = decoded;
            return next();
        }

        // No valid tokens found - clear any lingering auth cookies
        res.clearCookie("clientAccessToken", COOKIE_OPTIONS);
        res.clearCookie("clientRefreshToken", COOKIE_OPTIONS);
        return res.status(401).json({ message: "Unauthorized! No valid tokens provided." });

    }
    catch (error) {
        // Invalid or expired sessions are an expected authentication outcome.
        try { res.clearCookie("clientAccessToken", COOKIE_OPTIONS); } catch { };
        try { res.clearCookie("clientRefreshToken", COOKIE_OPTIONS); } catch { };
        return res.status(401).json({ message: "Session expired or invalid. Please sign in again." });
    }
}

const handleVendorTokens = (accessToken: string | undefined, refreshToken: string | undefined, req: Request, res: Response, next: NextFunction) => {
    try {
        if (accessToken) {
            try {
                const decoded = verifyToken(accessToken, "access", { logErrors: false });
                (req as any).user = decoded;
                return next();
            } catch (error) {
                if (!refreshToken) throw error;
            }
        }

        if (refreshToken) {
            const decoded = verifyToken(refreshToken, "refresh", { logErrors: false });
            const newAccessToken = generateNewAccessToken(refreshToken);
            res.cookie("vendorAccessToken", newAccessToken, { ...COOKIE_OPTIONS, maxAge: 30 * 60 * 1000 });
            res.setHeader("x-access-token", newAccessToken);
            (req as any).user = decoded;
            return next();
        }

        // No valid tokens found - clear any lingering auth cookies
        res.clearCookie("vendorAccessToken", COOKIE_OPTIONS);
        res.clearCookie("vendorRefreshToken", COOKIE_OPTIONS);
        return res.status(401).json({ message: "Unauthorized! No valid tokens provided." });

    }
    catch (error) {
        // Invalid or expired sessions are an expected authentication outcome.
        try { res.clearCookie("vendorAccessToken", COOKIE_OPTIONS); } catch { };
        try { res.clearCookie("vendorRefreshToken", COOKIE_OPTIONS); } catch { };
        return res.status(401).json({ message: "Session expired or invalid. Please sign in again." });
    }
}
