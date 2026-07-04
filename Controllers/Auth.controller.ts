import type { Request, Response } from "express";
import bcrypt from 'bcrypt';
import type { DatabaseError } from 'pg';
import { generateAccessToken, generateRefreshToken, verifyToken } from "../helpers/jwt.helper";
import pool from "../DbConnect";
import { COOKIE_OPTIONS } from "../shared/CokkieSetting.shared";
import { sendOTPEmail } from "../helpers/emailService.helper";
import { uploadBufferToS3, BUCKET_NAME } from "../services/s3.service";

const validUserRoles = new Set(["client", "vendor", "admin", "super_admin", "fulfillment_center", "delivery_agent"]);
const gstDocumentMimeTypes = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"]);

function normalizeRequiredText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function parseCoordinate(value: unknown) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCategoryCodes(value: unknown) {
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return normalizeCategoryCodes(parsed);
        } catch {
            return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
        }
    }

    if (!Array.isArray(value)) {
        return [] as string[];
    }

    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0);
}

function getUploadedFile(req: Request, fieldName: string): Express.Multer.File | undefined {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    return files?.[fieldName]?.[0];
}

function safeFileExtension(file: Express.Multer.File) {
    const extension = file.originalname.includes(".")
        ? file.originalname.split(".").pop()?.toLowerCase()
        : file.mimetype.split("/").pop();
    return extension && /^[a-z0-9]+$/.test(extension) ? extension : "bin";
}

async function uploadRegistrationFile(file: Express.Multer.File | undefined, options: { fieldLabel: string; folder: string; allowedTypes: Set<string>; required: boolean }) {
    if (!file) {
        if (options.required) {
            throw new Error(`${options.fieldLabel} is required.`);
        }
        return "";
    }

    if (!options.allowedTypes.has(file.mimetype)) {
        throw new Error(`${options.fieldLabel} must be a valid ${options.fieldLabel.toLowerCase().includes("signature") ? "JPG, PNG, or WEBP image" : "PDF or image"} file.`);
    }

    if (!BUCKET_NAME) {
        throw new Error("AWS_BUCKET_NAME is not configured.");
    }

    const key = `vendor-registration/${options.folder}/${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${safeFileExtension(file)}`;
    const uploaded = await uploadBufferToS3(file.buffer, key, file.mimetype);
    return uploaded.s3Key;
}

export async function registerUser(req: Request, res: Response): Promise<Response> {

    const { name, email, password, role: requestedRole } = req.body;
    const role = typeof requestedRole === "string" && requestedRole.trim() ? requestedRole.trim() : "client";

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'All fields are required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    if (!/^[\w.-]+@[\w.-]+\.\w{2,}$/.test(email)) {
        return res.status(400).json({ message: 'Invalid email format' });
    }

    if (!validUserRoles.has(role)) {
        return res.status(400).json({ message: 'Invalid role' });
    }

    try {
        // Check if user already exists
        const existingUserResult = await pool.query('SELECT id, is_verified FROM users WHERE email = $1', [email]);

        if (existingUserResult.rows.length > 0) {
            const existingUser = existingUserResult.rows[0];

            if (existingUser.is_verified) {
                return res.status(409).json({ message: 'User with this email already exists' });
            }

            // User exists but is not verified — update details and resend OTP

            const hashedPassword = await bcrypt.hash(password, 10);
            await pool.query(
                'UPDATE users SET name = $1, password_hash = $2, role = $3 WHERE id = $4',
                [name, hashedPassword, role, existingUser.id]
            );

            // Generate new OTP
            const plainOTP = Math.floor(100000 + Math.random() * 900000).toString();
            const hashedOTP = await bcrypt.hash(plainOTP, 10);
            const expiryTime = new Date(Date.now() + 10 * 60 * 1000);

            await pool.query(
                'UPDATE users SET OTP = $1, OTP_Expiry = $2 WHERE id = $3',
                [hashedOTP, expiryTime, existingUser.id]
            );

            if (process.env.Production !== 'true') {
                console.log(`Generated OTP for ${email}: ${plainOTP} (expires at ${expiryTime.toISOString()})`);
            }

            const emailResult = await sendOTPEmail(name, email, plainOTP, 10);
            if (!emailResult.success) {
                console.error(`Failed to send OTP email to ${email}:`, emailResult.error);
                return res.status(500).json({ message: 'Failed to send OTP email. Please try again.' });
            }

            return res.status(200).json({
                message: 'OTP sent to your email. Please verify to complete registration.',
                email: email,
                expiresAt: expiryTime.toISOString()
            });
        }

        // New user — create with is_verified = false
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (name, email, password_hash, role, is_verified) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email',
            [name, email, hashedPassword, role, false]
        );

        const user = result.rows[0];
        // Generate OTP
        const plainOTP = Math.floor(100000 + Math.random() * 900000).toString();
        const hashedOTP = await bcrypt.hash(plainOTP, 10);
        const expiryTime = new Date(Date.now() + 10 * 60 * 1000);

        await pool.query(
            'UPDATE users SET OTP = $1, OTP_Expiry = $2 WHERE id = $3',
            [hashedOTP, expiryTime, user.id]
        );

        const emailResult = await sendOTPEmail(name, email, plainOTP, 10);
        if (!emailResult.success) {
            console.error(`Failed to send OTP email to ${email}:`, emailResult.error);
            return res.status(500).json({ message: 'Failed to send OTP email. Please try again.' });
        }

        return res.status(200).json({
            message: 'Registration initiated. OTP sent to your email.',
            email: email,
            expiresAt: expiryTime.toISOString()
        });
    }
    catch (error) {
        const dbError = error as DatabaseError;
        if (dbError.code === '23505') {
            return res.status(409).json({ message: 'User with this email already exists' });
        }
        console.error('Error registering user:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
}


export async function loginUser(req: Request, res: Response): Promise<Response> {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
        return res.status(400).json({ message: 'Email, password, and role are required' });
    }

    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({ message: 'Invalid email' });
        }

        if (user.role != role)
            return res.status(401).json({ message: `This email is associated with ${user.role} and you are trying to log in as ${role}! That is not allowed.` });

        if (!user.is_verified) {
            return res.status(403).json({ message: 'Please verify your email before logging in.' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) {

            return res.status(401).json({ message: 'Invalid password' });

        }

        let vendorType: string | undefined;
        if (user.role === 'vendor') {
            const vendorResult = await pool.query('SELECT vendor_type FROM vendors WHERE user_id = $1 LIMIT 1', [user.id]);
            vendorType = vendorResult.rows[0]?.vendor_type || 'product';
        }

        const refreshToken = generateRefreshToken(user.id, user.name, user.email, user.role, vendorType);

        const accessToken = generateAccessToken(user.id, user.name, user.email, user.role, vendorType);

        // Store refresh token in database for revocation and session tracking
        await pool.query('UPDATE users SET refresh_token = $1 WHERE id = $2', [refreshToken, user.id]);

        res.cookie(`${user.role}RefreshToken`, refreshToken, {
            ...COOKIE_OPTIONS,
            maxAge: 45 * 24 * 60 * 60 * 1000, // 45 days
        });

        res.cookie(`${user.role}AccessToken`, accessToken, {
            ...COOKIE_OPTIONS,
            maxAge: 30 * 60 * 1000, // 30 minutes
        });


        return res.status(200).json({
            message: 'Login successful',
            token: accessToken,
            accessToken,
            refreshToken,
            user: { userId: user.id, username: user.name, email: user.email, role: user.role }
        });

    }
    catch (error) {
        console.error('Error logging in user:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
}

export async function getCurrentUser(req: Request, res: Response): Promise<Response> {
    const user = (req as any).user;
    if (!user) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    let vendorType: string | null = null;
    if (user.role === "vendor") {
        try {
            const vendorRes = await pool.query(
                `SELECT vendor_type FROM vendors WHERE user_id = $1`,
                [user.userId]
            );
            if (vendorRes.rows.length > 0) {
                vendorType = vendorRes.rows[0].vendor_type;
            }
        } catch (err) {
            console.error("Error fetching vendor_type for getCurrentUser:", err);
        }
    }
    return res.status(200).json({
        user: {
            userId: user.userId,
            username: user.username,
            email: user.email,
            role: user.role,
            vendorType
        }
    });
}

export async function logoutUser(req: Request, res: Response): Promise<Response> {
    const isRequestFrom = req.headers['x-request-from'] || '';
    
    // Always clear cookies for the requesting role so the client is guaranteed to be logged out
    if (typeof isRequestFrom === 'string' && isRequestFrom.trim() !== '') {
        res.clearCookie(`${isRequestFrom}RefreshToken`, COOKIE_OPTIONS);
        res.clearCookie(`${isRequestFrom}AccessToken`, COOKIE_OPTIONS);
    } else {
        // Fallback: clear all known role cookies to be safe
        res.clearCookie('vendorRefreshToken', COOKIE_OPTIONS);
        res.clearCookie('vendorAccessToken', COOKIE_OPTIONS);
        res.clearCookie('clientRefreshToken', COOKIE_OPTIONS);
        res.clearCookie('clientAccessToken', COOKIE_OPTIONS);
        res.clearCookie('fulfillment_centerRefreshToken', COOKIE_OPTIONS);
        res.clearCookie('fulfillment_centerAccessToken', COOKIE_OPTIONS);
        res.clearCookie('delivery_agentRefreshToken', COOKIE_OPTIONS);
        res.clearCookie('delivery_agentAccessToken', COOKIE_OPTIONS);
    }

    const headerRefreshToken = typeof req.headers['x-refresh-token'] === 'string'
        ? req.headers['x-refresh-token']
        : undefined;
    const refreshToken = req.cookies[`${isRequestFrom}RefreshToken`]
        || req.cookies['vendorRefreshToken']
        || req.cookies['clientRefreshToken']
        || req.body?.refreshToken
        || headerRefreshToken;

    const authHeader = req.headers.authorization;
    const usesHeader = typeof authHeader === "string";
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
    const accessToken = usesHeader ? bearer : (req.cookies[`${isRequestFrom}AccessToken`] || req.cookies['vendorAccessToken'] || req.cookies['clientAccessToken']);

    let userId: string | undefined;

    // 1. Try to extract userId from access token
    if (accessToken) {
        try {
            const decoded = verifyToken(accessToken, 'access', { logErrors: false });
            userId = decoded.userId;
        } catch (err) {
            // Ignore token verification errors
        }
    }

    // 2. Try to extract userId from refresh token
    if (refreshToken) {
        try {
            const decoded = verifyToken(refreshToken, 'refresh', { logErrors: false });
            userId = userId || decoded.userId;
        } catch (err) {
            // Ignore
        }
    }

    try {
        if (userId) {
            // If we have a verified userId, clear their refresh token from the database directly
            await pool.query('UPDATE users SET refresh_token = NULL WHERE id = $1', [userId]);
        } else if (refreshToken) {
            // Fallback: clear by refresh token value
            await pool.query('UPDATE users SET refresh_token = NULL WHERE refresh_token = $1', [refreshToken]);
        }

        return res.status(200).json({ message: 'Logout successful' });
    }
    catch (error) {
        console.error('Error logging out user:', error);
        return res.status(200).json({ message: 'Logout completed with database warning' });
    }
}

export const OTPSendingController = async (req: Request, res: Response): Promise<Response> => {
    const { email } = req.body;


    if (!email) {
        return res.status(400).json({ message: 'Email is required' });
    }

    try {
        // Check if user exists
        const userResult = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const user = userResult.rows[0];

        // Generate 6-digit OTP
        const plainOTP = Math.floor(100000 + Math.random() * 900000).toString();
        // Hash the OTP
        const hashedOTP = await bcrypt.hash(plainOTP, 10);

        // Set expiry to 10 minutes from now
        const expiryTime = new Date(Date.now() + 10 * 60 * 1000);

        // Save hashed OTP and expiry to database
        await pool.query(
            'UPDATE users SET OTP = $1, OTP_Expiry = $2 WHERE email = $3',
            [hashedOTP, expiryTime, email]
        );

        const emailResult = await sendOTPEmail(user.name, email, plainOTP, 10);
        if (!emailResult.success) {
            console.error(`Failed to send OTP email to ${email}:`, emailResult.error);
            return res.status(500).json({ message: 'Failed to send OTP email. Please try again.' });
        }

        if (process.env.NODE_ENV !== 'production') {
            console.log(`OTP for ${email}: ${plainOTP}`);
        }

        return res.status(200).json({
            message: 'OTP sent successfully',
            email: email,
            expiresAt: expiryTime.toISOString()
        });
    } catch (e) {
        console.error("Error while generating and sending otp: ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}

export const OTPVerificationController = async (req: Request, res: Response): Promise<Response> => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ message: 'Email and OTP are required' });
    }

    try {
        // Get user with OTP and expiry
        const userResult = await pool.query(
            'SELECT id, OTP, OTP_Expiry FROM users WHERE email = $1',
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const user = userResult.rows[0];
        const storedHashedOTP = user.otp;
        const otpExpiry = user.otp_expiry;

        // Check if OTP exists
        if (!storedHashedOTP || !otpExpiry) {
            return res.status(400).json({ message: 'No OTP found. Please request a new OTP.' });
        }

        // Check if OTP has expired
        if (new Date() > new Date(otpExpiry)) {
            // Clear expired OTP
            await pool.query(
                'UPDATE users SET OTP = NULL, OTP_Expiry = NULL WHERE email = $1',
                [email]
            );
            return res.status(400).json({ message: 'OTP has expired. Please request a new OTP.' });
        }

        // Compare input OTP with stored hashed OTP
        const isOTPValid = await bcrypt.compare(otp, storedHashedOTP);

        if (!isOTPValid) {
            return res.status(401).json({ message: 'Invalid OTP' });
        }

        // Set OTP = 'VERIFIED' with a 10-minute expiry window for password reset
        const verificationExpiry = new Date(Date.now() + 10 * 60 * 1000);
        await pool.query(
            'UPDATE users SET OTP = $1, OTP_Expiry = $2 WHERE email = $3',
            ['VERIFIED', verificationExpiry, email]
        );

        return res.status(200).json({
            message: 'OTP verified successfully',
            email: email,
            verified: true
        });
    } catch (e) {
        console.error("Error while verifying otp: ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}

export const verifyRegisteredUser = async (req: Request, res: Response): Promise<Response> => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ message: 'Email and OTP are required' });
    }

    try {
        // Get user with OTP, expiry, and verification status
        const userResult = await pool.query(
            'SELECT id, name, email, role, OTP, OTP_Expiry, is_verified FROM users WHERE email = $1',
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const user = userResult.rows[0];

        if (user.is_verified) {
            return res.status(400).json({ message: 'User is already verified. Please log in.' });
        }

        const storedHashedOTP = user.otp;
        const otpExpiry = user.otp_expiry;

        // Check if OTP exists
        if (!storedHashedOTP || !otpExpiry) {
            return res.status(400).json({ message: 'No OTP found. Please request a new OTP.' });
        }

        // Check if OTP has expired
        if (new Date() > new Date(otpExpiry)) {
            await pool.query(
                'UPDATE users SET OTP = NULL, OTP_Expiry = NULL WHERE email = $1',
                [email]
            );
            return res.status(400).json({ message: 'OTP has expired. Please request a new OTP.' });
        }

        // Compare input OTP with stored hashed OTP
        const isOTPValid = await bcrypt.compare(otp, storedHashedOTP);

        if (!isOTPValid) {
            return res.status(401).json({ message: 'Invalid OTP' });
        }

        const normalizedCompanyName = normalizeRequiredText(req.body.companyName);
        const normalizedBusinessType = normalizeRequiredText(req.body.businessType);
        const normalizedVendorType = req.body.vendorType === "service" ? "service" : "product";
        const normalizedGstNumber = normalizeRequiredText(req.body.gstNumber);
        const normalizedCompanyWebsite = normalizeRequiredText(req.body.companyWebsite);
        const normalizedGstCertificateLink = normalizeRequiredText(req.body.gstCertificateLink);
        const gstCertificateFile = getUploadedFile(req, "gstCertificate");
        const normalizedPhone = normalizeRequiredText(req.body.phone);
        const normalizedAlternativeNumber = normalizeRequiredText(req.body.alternativeNumber);
        const normalizedDesignation = normalizeRequiredText(req.body.designation);
        const normalizedBusinessDescription = normalizeRequiredText(req.body.businessDescription);
        const normalizedAddress = normalizeRequiredText(req.body.address);
        const normalizedCity = normalizeRequiredText(req.body.city);
        const normalizedState = normalizeRequiredText(req.body.state);
        const normalizedCountry = normalizeRequiredText(req.body.country);
        const normalizedPincode = normalizeRequiredText(req.body.pincode);
        const parsedLatitude = parseCoordinate(req.body.latitude);
        const parsedLongitude = parseCoordinate(req.body.longitude);
        const normalizedCreditCycle = normalizeRequiredText(req.body.creditCycle);
        const parsedMinCommission = req.body.minimumCommissionPercentage ? parseInt(req.body.minimumCommissionPercentage) : null;
        const parsedMaxCommission = req.body.maximumCommissionPercentage ? parseInt(req.body.maximumCommissionPercentage) : null;

        const shouldPersistVendorSetup = [
            normalizedCompanyName,
            normalizedBusinessType,
            normalizedGstNumber,
            normalizedPhone,
            normalizedDesignation,
            normalizedBusinessDescription,
            normalizedAddress,
            normalizedCity,
            normalizedState,
            normalizedCountry,
            normalizedPincode,
            normalizedCompanyWebsite,
            normalizedGstCertificateLink,
            normalizedAlternativeNumber,
            normalizedCreditCycle,
        ].some((value) => value.length > 0) || Boolean(gstCertificateFile) || parsedLatitude !== null || parsedLongitude !== null || parsedMinCommission !== null || parsedMaxCommission !== null;

        if (shouldPersistVendorSetup) {
            if (
                !normalizedCompanyName ||
                !normalizedBusinessType ||
                !normalizedGstNumber ||
                !normalizedPhone ||
                !normalizedDesignation ||
                !normalizedBusinessDescription ||
                !normalizedAddress ||
                !normalizedCity ||
                !normalizedState ||
                !normalizedCountry ||
                !normalizedPincode ||
                !normalizedCreditCycle ||
                parsedMinCommission === null ||
                parsedMaxCommission === null ||
                parsedLatitude === null ||
                parsedLongitude === null ||
                (!gstCertificateFile && !normalizedGstCertificateLink)
            ) {
                return res.status(400).json({ message: "Missing vendor setup fields. All fields, GST certificate, and commission details are required." });
            }

            if (!/^\d{6}$/.test(normalizedPincode)) {
                return res.status(400).json({ message: "Pincode must be 6 digits." });
            }

            if (parsedLatitude < -90 || parsedLatitude > 90 || parsedLongitude < -180 || parsedLongitude > 180) {
                return res.status(400).json({ message: "Latitude/longitude out of range." });
            }

            if (parsedMinCommission < 0 || parsedMinCommission > 100) {
                return res.status(400).json({ message: "Minimum commission percentage must be between 0 and 100." });
            }

            if (parsedMaxCommission < 0 || parsedMaxCommission > 100) {
                return res.status(400).json({ message: "Maximum commission percentage must be between 0 and 100." });
            }

            if (parsedMinCommission > parsedMaxCommission) {
                return res.status(400).json({ message: "Minimum commission cannot be greater than maximum commission." });
            }
        }


        const selectedCategoryCodes = normalizeCategoryCodes(req.body.vendorCategories);

        // Validate that at least one category is selected if vendor setup is being completed
        if (shouldPersistVendorSetup && selectedCategoryCodes.length === 0) {
            return res.status(400).json({ message: "Please select at least one vendor category." });
        }

        if (selectedCategoryCodes.length > 3) {
            return res.status(400).json({ message: "You can select up to 3 vendor categories." });
        }

        const client = await pool.connect();
        let userRole = user.role;
        let refreshToken = "";
        let accessToken = "";
        let vendorType: string | undefined;

        try {
            await client.query("BEGIN");

            await client.query(
                'UPDATE users SET is_verified = TRUE, OTP = NULL, OTP_Expiry = NULL WHERE id = $1',
                [user.id]
            );

            if (shouldPersistVendorSetup) {
                const appNumber = `APP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(1000 + Math.random() * 9000)}`;
                const duplicateGst = await client.query(
                    `
                            SELECT user_id
                            FROM vendors
                            WHERE gst_number = $1 AND user_id <> $2
                        `,
                    [normalizedGstNumber, user.id]
                );

                if (duplicateGst.rows.length > 0) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ message: "This GST number is already registered with another vendor." });
                }

                const uploadedGstCertificateLink = gstCertificateFile ? await uploadRegistrationFile(gstCertificateFile, {
                    fieldLabel: "GST certificate",
                    folder: "gst-certificates",
                    allowedTypes: gstDocumentMimeTypes,
                    required: true,
                }) : normalizedGstCertificateLink;

                await client.query(
                    `
                            INSERT INTO vendors (
                                user_id,
                                company_name,
                                gst_number,
                                gst_certificate_link,
                                business_type,
                                company_website,
                                phone,
                                alternative_number,
                                designation,
                                business_description,
                                credit_cycle,
                                minimum_commision_percentage,
                                maximum_commision_percentage,
                                approval_status,
                                approval_notes,
                                application_number,
                                vendor_type,
                                updated_at
                            )
                            VALUES ($1, $2, $3, NULLIF($4, ''), $5, NULLIF($6, ''), $7, NULLIF($8, ''), $9, $10, $11, $12, $13, 'pending', 'Awaiting admin approval', $14, $15, NOW())
                            ON CONFLICT (user_id)
                            DO UPDATE SET
                                company_name = EXCLUDED.company_name,
                                gst_number = EXCLUDED.gst_number,
                                gst_certificate_link = EXCLUDED.gst_certificate_link,
                                business_type = EXCLUDED.business_type,
                                company_website = EXCLUDED.company_website,
                                phone = EXCLUDED.phone,
                                alternative_number = EXCLUDED.alternative_number,
                                designation = EXCLUDED.designation,
                                business_description = EXCLUDED.business_description,
                                credit_cycle = EXCLUDED.credit_cycle,
                                minimum_commision_percentage = EXCLUDED.minimum_commision_percentage,
                                maximum_commision_percentage = EXCLUDED.maximum_commision_percentage,
                                approval_status = EXCLUDED.approval_status,
                                approval_notes = EXCLUDED.approval_notes,
                                application_number = COALESCE(vendors.application_number, EXCLUDED.application_number),
                                vendor_type = EXCLUDED.vendor_type,
                                updated_at = NOW()
                        `,
                    [
                        user.id,
                        normalizedCompanyName,
                        normalizedGstNumber,
                        uploadedGstCertificateLink,
                        normalizedBusinessType,
                        normalizedCompanyWebsite,
                        normalizedPhone,
                        normalizedAlternativeNumber,
                        normalizedDesignation,
                        normalizedBusinessDescription,
                        normalizedCreditCycle,
                        parsedMinCommission,
                        parsedMaxCommission,
                        appNumber,
                        normalizedVendorType
                    ]
                );

                await client.query(
                    `
                            INSERT INTO addresses (user_id, address, city, state, country, pincode, latitude, longitude, updated_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                        `,
                    [
                        user.id,
                        normalizedAddress,
                        normalizedCity,
                        normalizedState,
                        normalizedCountry,
                        normalizedPincode,
                        parsedLatitude,
                        parsedLongitude
                    ]
                );

                // Get the vendor record to link categories
                const vendorResult = await client.query(
                    `SELECT id, vendor_type FROM vendors WHERE user_id = $1`,
                    [user.id]
                );

                if (vendorResult.rows.length > 0) {
                    const vendorId = vendorResult.rows[0].id;
                    vendorType = vendorResult.rows[0].vendor_type || 'product';

                    // Delete existing vendor categories first (for updates)
                    await client.query(
                        `DELETE FROM vendor_categories WHERE vendor_id = $1`,
                        [vendorId]
                    );

                    // Insert selected categories
                    if (selectedCategoryCodes.length > 0) {
                        for (const categoryCode of selectedCategoryCodes) {
                            const categoryResult = await client.query(
                                `SELECT id FROM product_category WHERE code = $1 AND is_active = TRUE`,
                                [categoryCode]
                            );

                            if (categoryResult.rows.length > 0) {
                                const categoryId = categoryResult.rows[0].id;
                                await client.query(
                                    `
                                            INSERT INTO vendor_categories (vendor_id, category_id)
                                            VALUES ($1, $2)
                                            ON CONFLICT (vendor_id, category_id) DO NOTHING
                                        `,
                                    [vendorId, categoryId]
                                );
                            }
                        }
                    }
                }
            }

            refreshToken = generateRefreshToken(user.id, user.name, user.email, user.role, vendorType);
            accessToken = generateAccessToken(user.id, user.name, user.email, user.role, vendorType);

            const tokenResult = await client.query('UPDATE users SET refresh_token = $1 WHERE id = $2 RETURNING role', [refreshToken, user.id]);
            userRole = tokenResult.rows[0]?.role || userRole;

            await client.query("COMMIT");

            res.cookie(`${userRole}RefreshToken`, refreshToken, {
                ...COOKIE_OPTIONS,
                maxAge: 45 * 24 * 60 * 60 * 1000,
            });

            res.cookie(`${userRole}AccessToken`, accessToken, {
                ...COOKIE_OPTIONS,
                maxAge: 30 * 60 * 1000,
            });
        } catch (transactionError) {
            await client.query("ROLLBACK");
            throw transactionError;
        } finally {
            client.release();
        }

        return res.status(200).json({
            message: 'Email verified successfully. Registration complete.',
            token: accessToken,
            accessToken,
            refreshToken,
            user: { userId: user.id, username: user.name, email: user.email, role: user.role },
            vendorSetupComplete: shouldPersistVendorSetup
        });
    } catch (e) {
        console.error("Error while verifying registered user: ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}

export const resetPasswordController = async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
    }

    try {
        // Retrieve current OTP status
        const userResult = await pool.query(
            'SELECT OTP, OTP_Expiry FROM users WHERE email = $1',
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const user = userResult.rows[0];
        
        // Ensure OTP has been verified
        if (user.otp !== 'VERIFIED') {
            return res.status(400).json({ message: 'OTP must be verified before resetting password' });
        }

        // Ensure the verification has not expired
        if (!user.otp_expiry || new Date() > new Date(user.otp_expiry)) {
            return res.status(400).json({ message: 'Verification window has expired. Please verify OTP again.' });
        }

        // Hash the new password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Update user password and clear verification status
        await pool.query(
            'UPDATE users SET password_hash = $1, OTP = NULL, OTP_Expiry = NULL WHERE email = $2',
            [hashedPassword, email]
        );

        return res.status(200).json({
            message: 'Password reset successfully',
            email: email
        });
    } catch (e) {
        console.error("Error while resetting password: ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}

export const updateUserNameController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { name } = req.body;
    if (!name || typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ message: "Name is required" });
    }

    try {
        const result = await pool.query(
            "UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, role",
            [name.trim(), user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        const updatedUser = result.rows[0];
        return res.status(200).json({
            message: "User name updated successfully",
            user: { userId: updatedUser.id, username: updatedUser.name, email: updatedUser.email, role: updatedUser.role }
        });
    } catch (e) {
        console.error("Error updating user name:", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}
