// Cloudflare R2 upload (S3-compatible). Configured via env vars.
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const endpoint = process.env.R2_ENDPOINT;
const bucket = process.env.R2_BUCKET;
const publicUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");

let client = null;
if (endpoint && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
  client = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function r2put(key, body, contentType) {
  if (!client) throw new Error("R2 not configured");
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return publicUrl + "/" + key;
}

module.exports = { r2put, r2ready: () => !!client && !!publicUrl };
