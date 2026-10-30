const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:8081',
    'http://localhost:4000',
    'http://localhost:4001',
    'http://192.168.29.150:4000',
    'http://192.168.1.11:3000',
    'http://192.168.1.11:3001',
    'https://mtwo.in',
    'https://www.mtwo.in',
    'https://vendor.mtwo.in',
    'https://admin.mtwo.in',
    'https://client.mtwo.in',
    'https://api.mtwo.in',
    'https://api-admin.mtwo.in',
]);

// Shared by the HTTP CORS config and Socket.io so both accept the same origins.
// Requests without an Origin header (mobile apps, server-to-server) are allowed.
export const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return true;

    const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
    const isLanIp = /^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin);
    const isVercelPreview = /^https:\/\/.*\.vercel\.app$/.test(origin);
    const isMtwoDomain = /^https:\/\/(.*\.)?mtwo\.in$/.test(origin);

    return allowedOrigins.has(origin) || isLocalhost || isLanIp || isVercelPreview || isMtwoDomain;
};
