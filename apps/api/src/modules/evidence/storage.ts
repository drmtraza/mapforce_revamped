import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every evidence object lives under its tenant prefix; keys are never built from user input. */
export function evidenceKey(tenantId: string, companyId: string, evidenceId: string): string {
  for (const id of [tenantId, companyId, evidenceId]) {
    if (!UUID.test(id)) throw new Error('evidenceKey requires UUID components');
  }
  return `tenants/${tenantId}/companies/${companyId}/evidence/${evidenceId}.json`;
}

export function keyBelongsToTenant(key: string, tenantId: string): boolean {
  return key.startsWith(`tenants/${tenantId}/`) && !key.includes('..');
}

export interface EvidenceStorage {
  ensureBucket(): Promise<void>;
  put(key: string, body: string, contentType: string): Promise<void>;
  signedGetUrl(key: string, ttlSeconds: number): Promise<string>;
}

export interface S3StorageOptions {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function createS3Storage(o: S3StorageOptions): EvidenceStorage {
  const credentials = { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey };
  const base = { region: o.region, credentials, forcePathStyle: o.forcePathStyle };
  const internal = new S3Client({ ...base, endpoint: o.endpoint, maxAttempts: 3 });
  const publicSigner = new S3Client({ ...base, endpoint: o.publicEndpoint });

  return {
    async ensureBucket() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket: o.bucket }));
      } catch {
        await internal.send(new CreateBucketCommand({ Bucket: o.bucket }));
      }
    },
    async put(key, body, contentType) {
      await internal.send(
        new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async signedGetUrl(key, ttlSeconds) {
      return getSignedUrl(publicSigner, new GetObjectCommand({ Bucket: o.bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },
  };
}
