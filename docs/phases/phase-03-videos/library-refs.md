---
kind: library-refs
name: phase-03-videos
date: 2026-07-20
---

# phase-03-videos — Library References

## New Libraries (introduced in this phase)

### @nestjs/bullmq

- **Version:** ^11.x (latest: 11.0.4)
- **Purpose:** NestJS integration for BullMQ job queues — video processing pipeline
- **Documentation:** https://docs.nestjs.com/techniques/queues
- **Install:** `npm install --save @nestjs/bullmq bullmq`
- **Key APIs:** `BullModule.forRoot()`, `BullModule.registerQueue()`, `@Processor()`, `@Process()`, `Processor` class, `Worker` class

### bullmq

- **Version:** ^5.x (latest: 5.80.9)
- **Purpose:** Redis-based job queue library (core engine behind @nestjs/bullmq)
- **Documentation:** https://docs.bullmq.io/
- **Install:** `npm install --save bullmq`
- **Key APIs:** `Queue`, `Worker`, `Job`, `FlowProducer`

### @aws-sdk/client-s3

- **Version:** ^3.x
- **Purpose:** AWS S3 client for MinIO interaction — multipart upload, object operations
- **Documentation:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/
- **Install:** `npm install --save @aws-sdk/client-s3`
- **Key APIs:** `S3Client`, `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `GetObjectCommand`, `HeadObjectCommand`

### @aws-sdk/s3-request-presigner

- **Version:** ^3.x
- **Purpose:** Generate presigned URLs for S3/MinIO — upload and download
- **Documentation:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/
- **Install:** `npm install --save @aws-sdk/s3-request-presigner`
- **Key APIs:** `getSignedUrl()`

### nanoid

- **Version:** ^5.x
- **Purpose:** URL-safe unique ID generation for video slugs
- **Documentation:** https://github.com/ai/nanoid
- **Install:** `npm install --save nanoid`
- **Key APIs:** `nanoid(size?)`, custom alphabet via `customAlphabet(alphabet, size)`

## Infrastructure Services (Docker)

### Redis (for BullMQ)

- **Image:** `redis:7-alpine`
- **Purpose:** Job queue backend for BullMQ
- **Docker Compose service name:** `redis`
- **Port:** 6379

### MinIO (Object Storage)

- **Image:** `minio/minio:latest`
- **Purpose:** S3-compatible object storage for video files and thumbnails
- **Docker Compose service name:** `minio`
- **Ports:** 9000 (API), 9001 (Console)
- **Configuration:** `server /data --console-address ":9001"`

### Video Worker (FFmpeg)

- **Base image:** Custom (Dockerfile with FFmpeg + Node.js)
- **Purpose:** Processes video jobs from BullMQ — metadata extraction, thumbnail generation
- **Docker Compose service name:** `video-worker`
- **Dependencies:** Redis, MinIO, PostgreSQL

## Already Installed (inherited)

| Package | Version | Phase |
|---------|---------|-------|
| @nestjs/config | ^4.x | phase-01 |
| joi | ^17.x | phase-01 |
| typeorm | ^0.3.28 | phase-01 |
| pg | ^8.20.0 | phase-01 |
| @nestjs/jwt | ^11.0.2 | phase-02 |
| argon2 | ^0.41.1 | phase-02 |
| class-validator | ^0.14.4 | phase-02 |
| class-transformer | ^0.5.1 | phase-02 |
| @nestjs-modules/mailer | ^2.3.4 | phase-02 |
| @nestjs/throttler | ^6.5.0 | phase-02 |
