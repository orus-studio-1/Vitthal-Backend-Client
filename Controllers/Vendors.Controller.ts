import type { Request, Response } from "express";
import pool from "../DbConnect";
import { getPresignedUrlOrOriginal } from "../services/s3.service";

async function resolveVendorGstLink(vendor: any) {
    if (vendor && vendor.gst_certificate_link) {
        vendor.gst_certificate_link = await getPresignedUrlOrOriginal(vendor.gst_certificate_link);
    }
    if (vendor && vendor.vendor_gst_certificate_link) {
        vendor.vendor_gst_certificate_link = await getPresignedUrlOrOriginal(vendor.vendor_gst_certificate_link);
    }
    return vendor;
}


function normalizeRequiredText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function isMissingCoordinate(value: unknown) {
    return value === null || value === undefined || value === "";
}

function parseCoordinate(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCategoryCodes(value: unknown) {
    if (!Array.isArray(value)) {
        return [] as string[];
    }

    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0);
}

async function fetchPincodeLookup(
    normalizedPincode: string,
    signal: AbortSignal,
) {
    const response = await fetch(
        `https://api.postalpincode.in/pincode/${normalizedPincode}`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
            },
            signal,
        },
    );
    
    if (!response.ok) {
        throw new Error(`Postal lookup failed with status ${response.status}`);
    }
    
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") {
        return null;
    }

    const responseArray = Array.isArray(data) ? data : null;
    const postalResult = responseArray?.[0];

    const places = Array.isArray((postalResult as { PostOffice?: unknown } | null)?.PostOffice)
        ? ((postalResult as { PostOffice: Array<{ [key: string]: unknown }> }).PostOffice)
        : Array.isArray((data as { places?: Array<{ [key: string]: unknown }> }).places)
            ? ((data as { places: Array<{ [key: string]: unknown }> }).places)
            : null;

    if (!places || places.length === 0) {
        return null;
    }

    const formattedPlaces = places
        .map((place) => {
            const placeName = typeof place.Name === "string"
                ? place.Name.trim()
                : typeof place["place name"] === "string"
                    ? place["place name"].trim()
                    : "";
            const district = typeof place.District === "string" ? place.District.trim() : "";
            const state = typeof place.State === "string"
                ? place.State.trim()
                : typeof place.state === "string"
                    ? place.state.trim()
                    : "";
            const latitude = typeof place.latitude === "string" ? place.latitude : "";
            const longitude = typeof place.longitude === "string" ? place.longitude : "";

            if (!placeName) {
                return null;
            }

            return {
                city: placeName,
                state,
                label: district ? `${placeName}, ${district}` : state ? `${placeName}, ${state}` : placeName,
                latitude,
                longitude,
            };
        })
        .filter((item): item is { city: string; state: string; label: string; latitude: string; longitude: string } => item !== null);

    if (formattedPlaces.length === 0) {
        return null;
    }

    return {
        pincode: normalizedPincode,
        city: formattedPlaces[0].city,
        state: formattedPlaces[0].state,
        postOfficeName: formattedPlaces[0].label,
        places: formattedPlaces,
    };
}

export const lookupPincodeController = async (req: Request, res: Response): Promise<Response> => {
    const rawPincode = typeof req.params.pincode === "string" ? req.params.pincode.trim() : "";
    const normalizedPincode = rawPincode.replace(/\D/g, "");

    if (!/^\d{6}$/.test(normalizedPincode)) {
        return res.status(400).json({
            success: false,
            manualEntryAllowed: true,
            message: "Pincode must be exactly 6 digits.",
        });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    try {
        let lookupResult = null as Awaited<ReturnType<typeof fetchPincodeLookup>>;

        try {
            lookupResult = await fetchPincodeLookup(normalizedPincode, controller.signal);
        }
        catch (error) {
            throw error;
        }

        if (!lookupResult) {
            return res.status(404).json({
                success: false,
                manualEntryAllowed: true,
                message: "No location found for this pincode. Please enter city and state manually.",
            });
        }

        return res.status(200).json({
            success: true,
            ...lookupResult,
        });
    }
    catch (error) {
        const isAbortError = (error as Error).name === "AbortError";
        if (isAbortError) {
            return res.status(504).json({
                success: false,
                manualEntryAllowed: true,
                message: "Postal lookup timed out. Please enter city and state manually.",
            });
        }

        console.error("Error while looking up pincode:", error);
        return res.status(502).json({
            success: false,
            manualEntryAllowed: true,
            message: "Postal lookup failed. Please enter city and state manually.",
        });
    }
    finally {
        clearTimeout(timeoutId);
    }
}

export const addVendorController = async (req: Request, res: Response): Promise<Response> => {
    const { companyName, phone, gstNumber } = req.body;
    const { userId } = (req as any).user;
    const normalizedCompanyName = normalizeRequiredText(companyName);
    const normalizedPhone = normalizeRequiredText(phone);
    const normalizedGstNumber = normalizeRequiredText(gstNumber);

    if (!userId || !normalizedCompanyName || !normalizedPhone || !normalizedGstNumber) {
        return res.status(400).json({ message: "All fields are required!" });
    }

    const { role } = (req as any).user;
    if (role != 'vendor')
        return res.status(403).json({ message: "Unauthorized! Only vendors can add vendors!" });

    try {
        await pool.query(
            `UPDATE users SET role = 'vendor', updated_at = NOW() WHERE id = $1`,
            [userId]
        );

        const duplicateGst = await pool.query(
            `
                SELECT user_id
                FROM vendors
                WHERE gst_number = $1 AND user_id <> $2
            `,
            [normalizedGstNumber, userId]
        );

        if (duplicateGst.rows.length > 0) {
            return res.status(409).json({ message: "This GST number is already registered with another vendor." });
        }

        const appNumber = `APP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(1000 + Math.random() * 9000)}`;
        const result = await pool.query(
            `
                INSERT INTO vendors (user_id, phone, gst_number, company_name, approval_status, approval_notes, application_number)
                VALUES ($1, $2, $3, $4, 'pending', 'Awaiting admin approval', $5)
                ON CONFLICT (user_id)
                DO UPDATE SET
                    phone = EXCLUDED.phone,
                    gst_number = EXCLUDED.gst_number,
                    company_name = EXCLUDED.company_name,
                    application_number = COALESCE(vendors.application_number, EXCLUDED.application_number),
                    updated_at = NOW()
                RETURNING id, phone, gst_number, approval_status, approval_notes, application_number
            `,
            [userId, normalizedPhone, normalizedGstNumber, normalizedCompanyName, appNumber]
        );
        const vendor = result.rows[0];
        return res.status(201).json({ message: "Vendor profile saved successfully!", vendor });
    }
    catch (e) {
        console.error("Error occurred while adding vendor: ", e);
        if ((e as { code?: string }).code === "23505") {
            return res.status(409).json({ message: "Vendor profile already exists or GST number is already in use." });
        }
        return res.status(500).json({ message: "Error occurred while adding vendor!" });
    }
}

export const updateVendorBasicDetailsController = async (req: Request, res: Response): Promise<Response> => {
    const { companyName, phone, gstNumber } = req.body;
    const { userId } = (req as any).user;
    const normalizedCompanyName = normalizeRequiredText(companyName);
    const normalizedPhone = normalizeRequiredText(phone);
    const normalizedGstNumber = normalizeRequiredText(gstNumber);

    if (!userId || !normalizedCompanyName || !normalizedPhone || !normalizedGstNumber) {
        return res.status(400).json({ message: "All fields are required!" });
    }

    const { role } = (req as any).user;
    if (role != 'vendor')
        return res.status(403).json({ message: "Unauthorized! Only vendors can add vendors!" });


    try {
        await pool.query(
            `UPDATE users SET role = 'vendor', updated_at = NOW() WHERE id = $1`,
            [userId]
        );

        const doesVendorExists = await pool.query(
            `SELECT * FROM vendors WHERE user_id = $1`,
            [userId]
        );

        if (doesVendorExists.rows.length === 0) {
            return res.status(400).json({ message: "Vendor Does Not Exists with given userId! You have to create new!" });
        }

        if (doesVendorExists.rows[0].is_blocked === true) {
            return res.status(400).json({ message: "Vendor is blocked! You cannot update it" });
        }

        const duplicateGst = await pool.query(
            `
                SELECT user_id
                FROM vendors
                WHERE gst_number = $1 AND user_id <> $2
            `,
            [normalizedGstNumber, userId]
        );

        if (duplicateGst.rows.length > 0) {
            return res.status(409).json({ message: "This GST number is already registered with another vendor." });
        }

        const result = await pool.query(
            `UPDATE vendors SET phone = $1, gst_number = $2, company_name = $3 WHERE user_id = $4 RETURNING id, phone, gst_number, company_name`,
            [normalizedPhone, normalizedGstNumber, normalizedCompanyName, userId]
        );
        const vendor = result.rows[0];

        return res.status(200).json({ message: "Vendor updated successfully!", vendor });
    }
    catch (e) {
        console.error("Error occurred while updating vendor: ", e);
        if ((e as { code?: string }).code === "23505") {
            return res.status(409).json({ message: "GST number is already in use by another vendor." });
        }
        return res.status(500).json({ message: "Error occurred while updating vendor!" });
    }
}

export const createVendorAddress = async (req: Request, res: Response): Promise<Response> => {
    const { address, city, state, country, pincode, latitude, longitude } = req.body;
    const { userId } = (req as any).user;
    const normalizedAddress = normalizeRequiredText(address);
    const normalizedCity = normalizeRequiredText(city);
    const normalizedState = normalizeRequiredText(state);
    const normalizedCountry = normalizeRequiredText(country);
    const normalizedPincode = normalizeRequiredText(pincode);

    if (
        !userId ||
        !normalizedAddress ||
        !normalizedCity ||
        !normalizedState ||
        !normalizedCountry ||
        !normalizedPincode ||
        isMissingCoordinate(latitude) ||
        isMissingCoordinate(longitude)
    ) {
        return res.status(400).json({ message: "All fields are required!" });
    }

    const { role } = (req as any).user;
    if (role != 'vendor')
        return res.status(403).json({ message: "Unauthorized! Only vendors can add vendors!" });

    try {

        const query = `SELECT 
                            u.id as user_exists,
                            u.role,
                            v.is_blocked,
                            a.id as address_exists
                        FROM users u
                        LEFT JOIN vendors v ON u.id = v.user_id
                        LEFT JOIN addresses a ON u.id = a.user_id
                        WHERE u.id = $1`;

        const userDetail = await pool.query(query, [userId]);

        if (userDetail.rows.length === 0) {
            return res.status(400).json({ message: "User does not exist!" });
        }

        const userDetails = userDetail.rows[0];

        if (userDetails.role !== 'vendor') {
            return res.status(400).json({ message: "User is not a vendor!" });
        }

        if (userDetails.is_blocked) {
            return res.status(400).json({ message: "Vendor is blocked! You cannot create an address! Ask Admin to unblock you!" });
        }

        if (userDetails.address_exists) {
            return res.status(400).json({ message: "Address already exists for this user! You can update it" });
        }

        const result = await pool.query(
            `INSERT INTO addresses (user_id, address, city, state, country, pincode, latitude, longitude) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, user_id, address, city, state, country, pincode, latitude, longitude`,
            [userId, normalizedAddress, normalizedCity, normalizedState, normalizedCountry, normalizedPincode, latitude, longitude]
        );
        const vendorAddress = result.rows[0];

        return res.status(201).json({ message: "Vendor address added successfully!", vendorAddress });
    }
    catch (e) {
        console.error("Error occurred while adding vendor address: ", e);
        if ((e as { code?: string }).code === "23505") {
            return res.status(409).json({ message: "Address already exists for this vendor. Please update it instead." });
        }
        return res.status(500).json({ message: "Error occurred while adding vendor address!" });
    }
}

export const updateVendorAddress = async (req: Request, res: Response): Promise<Response> => {
    const { address, city, state, country, pincode, latitude, longitude } = req.body;
    const { userId } = (req as any).user;
    const normalizedAddress = normalizeRequiredText(address);
    const normalizedCity = normalizeRequiredText(city);
    const normalizedState = normalizeRequiredText(state);
    const normalizedCountry = normalizeRequiredText(country);
    const normalizedPincode = normalizeRequiredText(pincode);

    if (
        !userId ||
        !normalizedAddress ||
        !normalizedCity ||
        !normalizedState ||
        !normalizedCountry ||
        !normalizedPincode ||
        isMissingCoordinate(latitude) ||
        isMissingCoordinate(longitude)
    ) {
        return res.status(400).json({ message: "All fields are required!" });
    }

    const { role } = (req as any).user;
    if (role != 'vendor')
        return res.status(403).json({ message: "Unauthorized! Only vendors can add vendors!" });

    try {
        const checkQuery = `
            SELECT 
                u.id as user_exists,
                u.role,
                v.is_blocked,
                a.id as address_exists
            FROM users u
            LEFT JOIN vendors v ON u.id = v.user_id
            LEFT JOIN addresses a ON u.id = a.user_id
            WHERE u.id = $1
        `;

        const checkResult = await pool.query(checkQuery, [userId]);

        if (checkResult.rows.length === 0) {
            return res.status(400).json({ message: "User does not exist!" });
        }

        const userDetails = checkResult.rows[0];

        if (userDetails.role !== 'vendor') {
            return res.status(400).json({ message: "User is not a vendor!" });
        }

        if (userDetails.is_blocked) {
            return res.status(400).json({ message: "Vendor is blocked! You cannot update the address! Ask Admin to unblock you!" });
        }

        if (!userDetails.address_exists) {
            return res.status(400).json({ message: "Address does not exist for this user! Please create an address first." });
        }

        const result = await pool.query(
            `UPDATE addresses SET address = $1, city = $2, state = $3, country = $4, pincode = $5, latitude = $6, longitude = $7 WHERE user_id = $8 RETURNING id, user_id, address, city, state, country, pincode, latitude, longitude`,
            [normalizedAddress, normalizedCity, normalizedState, normalizedCountry, normalizedPincode, latitude, longitude, userId]
        );
        const vendorAddress = result.rows[0];

        return res.status(200).json({ message: "Vendor address updated successfully!", vendorAddress });
    }
    catch (e) {
        console.error("Error occurred while updating vendor address: ", e);
        return res.status(500).json({ message: "Error occurred while updating vendor address!" });
    }
}

export const completeVendorSetupController = async (req: Request, res: Response): Promise<Response> => {
    const {
        companyName,
        businessType,
        gstNumber,
        companyWebsite,
        gstCertificateLink,
        phone,
        alternativeNumber,
        designation,
        businessDescription,
        vendorCategories,
        address,
        city,
        state,
        country,
        pincode,
        latitude,
        longitude,
        creditCycle,
        minimumCommissionPercentage,
        maximumCommissionPercentage
    } = req.body;

    const { userId, role } = (req as any).user;

    const normalizedCompanyName = normalizeRequiredText(companyName);
    const normalizedBusinessType = normalizeRequiredText(businessType);
    const normalizedGstNumber = normalizeRequiredText(gstNumber);
    const normalizedCompanyWebsite = normalizeRequiredText(companyWebsite);
    const normalizedGstCertificateLink = normalizeRequiredText(gstCertificateLink);
    const normalizedPhone = normalizeRequiredText(phone);
    const normalizedAlternativeNumber = normalizeRequiredText(alternativeNumber);
    const normalizedDesignation = normalizeRequiredText(designation);
    const normalizedBusinessDescription = normalizeRequiredText(businessDescription);
    const normalizedCategoryCodes = normalizeCategoryCodes(vendorCategories);
    const normalizedAddress = normalizeRequiredText(address);
    const normalizedCity = normalizeRequiredText(city);
    const normalizedState = normalizeRequiredText(state);
    const normalizedCountry = normalizeRequiredText(country);
    const normalizedPincode = normalizeRequiredText(pincode);
    const normalizedCreditCycle = normalizeRequiredText(creditCycle);

    const parsedLatitude = parseCoordinate(latitude);
    const parsedLongitude = parseCoordinate(longitude);
    const parsedMinCommission = minimumCommissionPercentage !== undefined && minimumCommissionPercentage !== null ? parseInt(minimumCommissionPercentage) : null;
    const parsedMaxCommission = maximumCommissionPercentage !== undefined && maximumCommissionPercentage !== null ? parseInt(maximumCommissionPercentage) : null;

    if (
        !userId ||
        role !== "vendor" ||
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
        parsedLatitude === null ||
        parsedLongitude === null ||
        !normalizedCreditCycle ||
        parsedMinCommission === null ||
        parsedMaxCommission === null
    ) {
        return res.status(400).json({ message: "Missing or invalid required fields." });
    }

    if (normalizedCategoryCodes.length > 3) {
        return res.status(400).json({ message: "You can select up to 3 vendor categories." });
    }

    if (normalizedCategoryCodes.length === 0) {
        return res.status(400).json({ message: "Please select at least one vendor category." });
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

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        await client.query(
            `UPDATE users SET role = 'vendor', updated_at = NOW() WHERE id = $1`,
            [userId]
        );

        const duplicateGst = await client.query(
            `
                SELECT user_id
                FROM vendors
                WHERE gst_number = $1 AND user_id <> $2
            `,
            [normalizedGstNumber, userId]
        );

        if (duplicateGst.rows.length > 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({ message: "This GST number is already registered with another vendor." });
        }

        const appNumber = `APP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(1000 + Math.random() * 9000)}`;
        const vendorResult = await client.query(
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
                    reconsideration_notes,
                    application_number,
                    updated_at
                )
                VALUES ($1, $2, $3, NULLIF($4, ''), $5, NULLIF($6, ''), $7, NULLIF($8, ''), $9, $10, $11, $12, $13, 'pending', 'Awaiting admin approval', NULL, $14, NOW())
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
                    approval_status = 'pending',
                    approval_notes = 'Awaiting admin approval',
                    reconsideration_notes = NULL,
                    application_number = COALESCE(vendors.application_number, EXCLUDED.application_number),
                    updated_at = NOW()
                RETURNING id, user_id, company_name, gst_number, gst_certificate_link, business_type, company_website, phone, alternative_number, designation, business_description, credit_cycle, minimum_commision_percentage, maximum_commision_percentage, approval_status, application_number
            `,
            [
                userId,
                normalizedCompanyName,
                normalizedGstNumber,
                normalizedGstCertificateLink,
                normalizedBusinessType,
                normalizedCompanyWebsite,
                normalizedPhone,
                normalizedAlternativeNumber,
                normalizedDesignation,
                normalizedBusinessDescription,
                normalizedCreditCycle,
                parsedMinCommission,
                parsedMaxCommission,
                appNumber
            ]
        );

        if (normalizedCategoryCodes.length > 0) {
            const categoryResult = await client.query(
                `
                    SELECT id, code
                    FROM product_category
                    WHERE code = ANY($1::text[]) AND is_active = TRUE
                `,
                [normalizedCategoryCodes]
            );

            if (categoryResult.rows.length !== normalizedCategoryCodes.length) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "One or more vendor categories are invalid." });
            }

            const selectedVendor = await client.query(`SELECT id FROM vendors WHERE user_id = $1`, [userId]);
            const vendorId = selectedVendor.rows[0]?.id;

            if (!vendorId) {
                await client.query("ROLLBACK");
                return res.status(500).json({ message: "Vendor record not found after setup save." });
            }

            await client.query(
                `DELETE FROM vendor_categories WHERE vendor_id = $1`,
                [vendorId]
            );

            await client.query(
                `
                    INSERT INTO vendor_categories (vendor_id, category_id)
                    SELECT $1, c.id
                    FROM product_category c
                    WHERE c.code = ANY($2::text[])
                    ON CONFLICT (vendor_id, category_id) DO NOTHING
                `,
                [vendorId, normalizedCategoryCodes]
            );
        }

        const addressCheck = await client.query(
            `SELECT id FROM addresses WHERE user_id = $1`,
            [userId]
        );

        let addressResult;
        if (addressCheck.rows.length > 0) {
            addressResult = await client.query(
                `
                    UPDATE addresses
                    SET address = $1, city = $2, state = $3, country = $4, pincode = $5, latitude = $6, longitude = $7, updated_at = NOW()
                    WHERE user_id = $8
                    RETURNING id, user_id, address, city, state, country, pincode, latitude, longitude
                `,
                [
                    normalizedAddress,
                    normalizedCity,
                    normalizedState,
                    normalizedCountry,
                    normalizedPincode,
                    parsedLatitude,
                    parsedLongitude,
                    userId
                ]
            );
        } else {
            addressResult = await client.query(
                `
                    INSERT INTO addresses (user_id, address, city, state, country, pincode, latitude, longitude, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                    RETURNING id, user_id, address, city, state, country, pincode, latitude, longitude
                `,
                [
                    userId,
                    normalizedAddress,
                    normalizedCity,
                    normalizedState,
                    normalizedCountry,
                    normalizedPincode,
                    parsedLatitude,
                    parsedLongitude
                ]
            );
        }

        await client.query("COMMIT");

        const resolvedVendor = await resolveVendorGstLink(vendorResult.rows[0]);
        return res.status(200).json({
            message: "Vendor setup completed successfully!",
            vendor: resolvedVendor,
            address: addressResult.rows[0]
        });
    }
    catch (e) {
        await client.query("ROLLBACK");
        console.error("Error occurred while completing vendor setup:", e);
        if ((e as { code?: string }).code === "23505") {
            return res.status(409).json({ message: "Duplicate data conflict while saving setup." });
        }
        return res.status(500).json({ message: "Error occurred while completing vendor setup." });
    }
    finally {
        client.release();
    }
}

export const getVendorDetailsController = async (req: Request, res: Response): Promise<Response> => {
    const { userId, role } = (req as any).user;
    if (!userId) {
        return res.status(400).json({ message: "User ID is required!" });
    }

    if(role !== 'vendor') {
        return res.status(403).json({ message: "Unauthorized! Only vendors can access their details!" });
    }

    try{
        const query = `
            SELECT 
                u.id as user_id,
                u.name as user_name,
                u.email as user_email,
                u.is_active as user_is_active,
                v.phone as vendor_phone,
                v.company_name as vendor_company_name,
                v.gst_number as vendor_gst_number,
                v.gst_certificate_link as vendor_gst_certificate_link,
                v.business_type as vendor_business_type,
                v.company_website as vendor_company_website,
                v.alternative_number as vendor_alternative_number,
                v.designation as vendor_designation,
                v.business_description as vendor_business_description,
                v.is_approved as vendor_is_approved,
                v.approval_status as vendor_approval_status,
                v.approval_notes as vendor_approval_notes,
                v.application_number as vendor_application_number,
                v.is_blocked as vendor_is_blocked,
                v.credit_cycle as vendor_credit_cycle,
                v.minimum_commision_percentage as vendor_minimum_commision_percentage,
                v.maximum_commision_percentage as vendor_maximum_commision_percentage,
                v.reconsideration_notes as vendor_reconsideration_notes,
                a.address as vendor_address,
                a.city as vendor_city,
                a.state as vendor_state,
                a.country as vendor_country,
                a.pincode as vendor_pincode,
                a.latitude as vendor_latitude,
                a.longitude as vendor_longitude,
                COALESCE(json_agg(DISTINCT jsonb_build_object('code', vc.code, 'label', vc.label)) FILTER (WHERE vc.id IS NOT NULL), '[]'::json) as vendor_categories
            FROM users u
            LEFT JOIN vendors v ON u.id = v.user_id
            LEFT JOIN addresses a ON u.id = a.user_id
            LEFT JOIN vendor_categories vcs ON v.id = vcs.vendor_id
            LEFT JOIN product_category vc ON vcs.category_id = vc.id
            WHERE u.id = $1 AND u.role = 'vendor'
            GROUP BY u.id, v.id, a.id
        `;

        const result = await pool.query(query, [userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found." });
        }

        const resolvedVendor = await resolveVendorGstLink(result.rows[0]);
        return res.status(200).json({
            message: "Vendor details fetched successfully",
            data: resolvedVendor
        });
    }
    catch (e) {
        console.error("Error : ", e);
        return res.status(500).json({ message: 'internal server error' });
    }
}

export const getVendorCategoriesController = async (req: Request, res: Response): Promise<Response> => {
    const { userId, role } = (req as any).user;
    if (!userId) {
        return res.status(400).json({ message: "User ID is required!" });
    }

    if (role !== "vendor") {
        return res.status(403).json({ message: "Unauthorized! Only vendors can access their categories!" });
    }

    try {
                const query = `
                        SELECT pc.code, pc.label, pc.sort_order
                        FROM vendors v
                        INNER JOIN vendor_categories vc ON vc.vendor_id = v.id
                        INNER JOIN product_category pc ON pc.id = vc.category_id
                        WHERE v.user_id = $1
                            AND pc.is_active = TRUE
                        GROUP BY pc.code, pc.label, pc.sort_order
                        ORDER BY pc.sort_order ASC, pc.label ASC
                `;

        const result = await pool.query(query, [userId]);

        if (result.rows.length === 0) {
            return res.status(200).json({
                message: "No vendor-specific categories found.",
                data: [],
            });
        }

        return res.status(200).json({
            message: "Vendor categories fetched successfully",
            data: result.rows,
        });
    }
    catch (e) {
        console.error("Error : ", e);
        return res.status(500).json({ message: "internal server error" });
    }
}

export const checkVendorSetupStatus = async (req: Request, res: Response): Promise<Response> => {
    const { userId, role } = (req as any).user;
    if (!userId) {
        return res.status(400).json({ message: "User ID is required!" });
    }

    if (role !== "vendor") {
        return res.status(403).json({ message: "Unauthorized! Only vendors can access their details!" });
    }

    try {
        const query = `
            SELECT 
                v.id as vendor_exists,
                a.id as address_exists
            FROM users u
            LEFT JOIN vendors v ON u.id = v.user_id
            LEFT JOIN addresses a ON u.id = a.user_id
            WHERE u.id = $1 AND u.role = 'vendor'
        `;

        const result = await pool.query(query, [userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found." });
        }

        const row = result.rows[0];
        const isSetupComplete = row.vendor_exists !== null && row.address_exists !== null;

        return res.status(200).json({
            message: "Setup status fetched successfully",
            isSetupComplete,
            hasVendorProfile: row.vendor_exists !== null,
            hasAddress: row.address_exists !== null,
        });
    }
    catch (e) {
        console.error("Error : ", e);
        return res.status(500).json({ message: "internal server error" });
    }
}

export const getVendorIdStatusController = async (req: Request, res: Response): Promise<Response> => {
    const { userId, role } = (req as any).user || {};

    if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    if (role !== "vendor") {
        return res.status(200).json({
            id: userId,
            role,
            approval_status: null,
        });
    }

    try {
        const result = await pool.query(
            `
                SELECT
                    u.id,
                    u.role,
                    v.id AS vendor_id,
                    v.approval_status,
                    v.application_number,
                    v.is_active,
                    v.is_blocked,
                    v.reconsideration_notes
                FROM users u
                LEFT JOIN vendors v ON v.user_id = u.id
                WHERE u.id = $1
                LIMIT 1
            `,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Vendor user not found." });
        }

        const row = result.rows[0];

        if (row.role !== "vendor") {
            return res.status(200).json({
                id: row.id,
                role: row.role,
                vendor_id: row.vendor_id ?? null,
                approval_status: null,
                is_active: row.is_active ?? true,
                is_blocked: row.is_blocked ?? false,
                reconsideration_notes: null,
            });
        }

        return res.status(200).json({
            id: row.id,
            role: row.role,
            vendor_id: row.vendor_id ?? null,
            approval_status: row.approval_status ?? "pending",
            application_number: row.application_number ?? null,
            is_active: row.is_active ?? true,
            is_blocked: row.is_blocked ?? false,
            reconsideration_notes: row.reconsideration_notes ?? null,
        });
    }
    catch (e) {
        console.error("Error fetching vendor id status:", e);
        return res.status(500).json({ message: "internal server error" });
    }
}
