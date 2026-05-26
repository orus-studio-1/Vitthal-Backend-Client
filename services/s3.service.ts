import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

const s3Client = new S3Client({
    region: (process.env.AWS_REGION || "ap-south-1").trim(),
    credentials: {
        accessKeyId: (process.env.AWS_ACCESS_KEY_ID || "").trim(),
        secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || "").trim(),
    },
});

const BUCKET_NAME = (process.env.AWS_BUCKET_NAME || "").trim();

/**
 * Upload a buffer to S3 and return the public URL + S3 key.
 */
export async function uploadBufferToS3(
    buffer: Buffer,
    key: string,
    contentType: string
): Promise<{ url: string; s3Key: string }> {
    const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
    });

    await s3Client.send(command);

    const url = `https://${BUCKET_NAME}.s3.${(process.env.AWS_REGION || "ap-south-1").trim()}.amazonaws.com/${key}`;
    return { url, s3Key: key };
}

/**
 * Delete an object from S3.
 */
export async function deleteFromS3(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
    });
    await s3Client.send(command);
}

/**
 * Get a presigned URL for a private S3 object (expires in 1 hour by default).
 */
export async function getPresignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
    });
    return getSignedUrl(s3Client, command, { expiresIn });
}

export { s3Client, BUCKET_NAME };
