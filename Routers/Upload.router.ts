import { Router, Request, Response } from "express";
import multer from "multer";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";
import crypto from "crypto";
import { authenticateAnyRole } from "../Middleware/AuthMiddleware";
import { extractS3Key } from "../services/s3.service";

dotenv.config();

const uploadRouter = Router();

// Configure AWS S3 Client
const s3Client = new S3Client({
  region: (process.env.AWS_REGION || "ap-south-1").trim(),
  credentials: {
    accessKeyId: (process.env.AWS_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || "").trim(),
  },
});

const BUCKET_NAME = process.env.AWS_BUCKET_NAME || "";

// Configure Multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB limit
  },
});

const uploadSingle = upload.single("file");

// Only user uploads made through this router may be presigned here. Server-generated files
// (vendor registration docs, payout cheques, quotation PDFs) are served by their own endpoints.
const PRESIGNABLE_PREFIX = "uploads/";

/**
 * Upload a file to S3
 */
uploadRouter.post("/upload", authenticateAnyRole, (req: Request, res: Response): void => {
  uploadSingle(req, res, async (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          success: false,
          message: "Uploaded files must be 5 MB or smaller.",
        });
        return;
      }

      console.error("Error parsing uploaded file:", error);
      res.status(400).json({
        success: false,
        message: "Unable to process the uploaded file.",
      });
      return;
    }

    try {
      if (!req.file) {
        res.status(400).json({ success: false, message: "No file uploaded." });
        return;
      }

      const file = req.file;
      const originalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
      const userId = (req as any).user.userId as string;
      const fileName = `${PRESIGNABLE_PREFIX}${userId}/${Date.now()}_${crypto.randomUUID()}_${originalName}`;

      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
      });

      await s3Client.send(command);

      res.status(200).json({
        success: true,
        message: "File uploaded successfully",
        fileName,
      });
    } catch (error) {
      console.error("Error uploading file to S3:", error);
      res.status(500).json({
        success: false,
        message: "Failed to upload the file to storage. Please try again.",
      });
    }
  });
});

/**
 * Get a presigned URL for downloading/viewing a file
 */
uploadRouter.get("/upload/file", authenticateAnyRole, async (req: Request, res: Response): Promise<void> => {
  try {
    // Some records store a full S3 URL (e.g. an old signed URL) instead of the key; sign the key it points at.
    const rawFileName = typeof req.query.fileName === "string" ? req.query.fileName : "";
    const fileName = rawFileName.includes("amazonaws.com/") ? decodeURIComponent(extractS3Key(rawFileName)) : rawFileName;
    
    if (!fileName) {
      res.status(400).json({ success: false, message: "Filename is required" });
      return;
    }

    if (!fileName.startsWith(PRESIGNABLE_PREFIX) || fileName.includes("..")) {
      res.status(403).json({ success: false, message: "You do not have access to this file." });
      return;
    }

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName as string,
    });

    // URL expires in 1 hour
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.status(200).json({
      success: true,
      url: signedUrl,
    });
  } catch (error) {
    console.error("Error getting signed URL from S3:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

export default uploadRouter;
