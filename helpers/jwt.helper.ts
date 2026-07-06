import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';

type TokenType = 'access' | 'refresh';

type TokenPayload = JwtPayload & {
    userId: string;
    username: string;
    email: string;
    role: string;
    type: TokenType;
    vendorType?: string;
};

function isTokenPayload(decoded: string | JwtPayload): decoded is TokenPayload {
    return typeof decoded === 'object' && decoded !== null
        && typeof decoded.userId === 'string'
        && typeof decoded.username === 'string'
        && typeof decoded.email === 'string'
        && (decoded.type === 'access' || decoded.type === 'refresh');
}

export function generateRefreshToken(userId: string, username: string, email: string, role: string, vendorType?: string): string {
    try {
        const payload: TokenPayload = { userId, username, email, role, type: 'refresh', vendorType };
        const secretKey = process.env.REFRESH_TOKEN_SECRET;
        if (!secretKey) {
            throw new Error('Refresh token secret key is not defined');
        }
        const options: SignOptions = { expiresIn: '45d' };
        const refreshToken = jwt.sign(payload, secretKey, options);

        return refreshToken;
    }
    catch (error) {
        console.error('Error generating refresh token:', error);
        throw new Error('Failed to generate refresh token');
    }
}

export function generateAccessToken(userId: string, username: string, email: string, role: string, vendorType?: string): string {
    try {
        const payload: TokenPayload = { userId, username, email, role, type: 'access', vendorType };
        const secretKey = process.env.ACCESS_TOKEN_SECRET;
        if (!secretKey) {
            throw new Error('Access token secret key is not defined');
        }
        const options: SignOptions = { expiresIn: '30m' };
        const accessToken = jwt.sign(payload, secretKey, options);

        return accessToken;
    }
    catch (error) {
        console.error('Error generating access token:', error);
        throw new Error('Failed to generate access token');
    }
}

export function verifyToken(token: string, type: TokenType, options: { logErrors?: boolean } = {}): { userId: string, username: string, email: string, role: string, vendorType?: string | undefined } {
    try {
        const secretKey = type === 'access' ? process.env.ACCESS_TOKEN_SECRET : process.env.REFRESH_TOKEN_SECRET;
        if (!secretKey) {
            throw new Error('Token secret key is not defined');
        }

        const decoded: TokenPayload = jwt.verify(token, secretKey) as TokenPayload;
        if (!isTokenPayload(decoded)) {
            throw new Error('Invalid token payload');
        }

        if (decoded.type !== type) {
            throw new Error('Invalid token type');
        }

        return { userId: decoded.userId, username: decoded.username, email: decoded.email, role: decoded.role, vendorType: decoded.vendorType };
    }
    catch (error) {
        if (options.logErrors !== false) {
            console.error('Error verifying token:', error);
        }
        throw new Error('Failed to verify token');
    }
}
