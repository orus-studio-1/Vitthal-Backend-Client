export const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || process.env.Production === 'true',
    sameSite: (process.env.NODE_ENV === 'production' || process.env.Production === 'true' ? 'none' : 'lax') as 'none' | 'lax',
};