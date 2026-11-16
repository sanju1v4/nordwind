import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Where uploaded files live. The app only talks to this interface, so tests can use memory instead of S3. */
export interface FileStorage {
  /** A short-lived URL the BROWSER uses to upload directly to storage (case study S9: files never pass through our API). */
  presignUpload(key: string, contentType: string): Promise<string>;
  /** Size of a stored file, or null if it doesn't exist. */
  size(key: string): Promise<number | null>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const UPLOAD_URL_TTL_SECONDS = 300; // 5 minutes: enough to upload, useless if the link leaks later

/** Private S3 bucket. Public access is blocked on the bucket itself (see infra/terraform). */
export function s3Storage(bucket: string, region: string): FileStorage {
  const s3 = new S3Client({ region });
  return {
    presignUpload: (key, contentType) =>
      getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), {
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      }),
    async size(key) {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return head.ContentLength ?? 0;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || status === 403) return null; // 403 = not found when we may not list the bucket
        throw err;
      }
    },
    async read(key) {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await obj.Body!.transformToByteArray());
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

/** In-memory storage for tests. `put` plays the role of the browser uploading to the pre-signed URL. */
export function memoryStorage() {
  const files = new Map<string, Buffer>();
  const storage: FileStorage & { put(key: string, data: Buffer): void; has(key: string): boolean } = {
    presignUpload: async (key) => `memory://upload/${key}`,
    size: async (key) => files.get(key)?.length ?? null,
    read: async (key) => {
      const f = files.get(key);
      if (!f) throw new Error(`no such file: ${key}`);
      return f;
    },
    delete: async (key) => void files.delete(key),
    put: (key, data) => void files.set(key, data),
    has: (key) => files.has(key),
  };
  return storage;
}
