---
kind: phase
name: phase-03-videos
status: planned
date: 2026-07-20
---

# phase-03-videos — Implementation Plan

## Objective

Implement the video upload, processing, storage, and streaming infrastructure for StreamTube. This phase introduces Object Storage (MinIO), a message queue (BullMQ + Redis), a video processing worker (FFmpeg), and the Video module in the NestJS backend. Videos up to 10GB can be uploaded via presigned multipart URLs, automatically processed (metadata extraction + thumbnail generation), assigned unique slugs, and streamed/downloaded via presigned GET URLs.

---

## Step Implementations

### SI-03.1 — Docker Infrastructure: MinIO, Redis, and Video Worker

**Description:** Add MinIO (object storage), Redis (job queue backend), and Video Worker (FFmpeg) services to `compose.yaml`. Create the Dockerfile for the video worker.

**Technical actions:**

1. Add `redis` service to `compose.yaml`:
   - Image: `redis:7-alpine`
   - Port: `6379:6379`
   - Healthcheck: `redis-cli ping`

2. Add `minio` service to `compose.yaml`:
   - Image: `minio/minio:latest`
   - Command: `server /data --console-address ":9001"`
   - Ports: `9000:9000` (API), `9001:9001` (Console)
   - Environment: `MINIO_ROOT_USER=minioadmin`, `MINIO_ROOT_PASSWORD=minioadmin`
   - Volume: `minio-data:/data`

3. Create `Dockerfile.worker` in `nestjs-project/`:
   - Base image: `node:22-alpine`
   - Install FFmpeg: `apk add --no-cache ffmpeg`
   - Copy `package.json` and `package-lock.json`, run `npm ci`
   - Copy `dist/` (compiled output)
   - Entrypoint: `node dist/worker/main.js`

4. Add `video-worker` service to `compose.yaml`:
   - Build context: `.`, dockerfile: `Dockerfile.worker`
   - Depends on: `db`, `redis`, `minio`
   - Environment: same DB/Redis/MinIO vars as `nestjs-api`
   - Profiles: `worker` (optional — can be started separately)

5. Add `minio-data` named volume to `compose.yaml`.

**Dependencies:** None.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| — | — | No tests — infrastructure configuration only |

**Acceptance criteria:**

1. `docker compose up -d` starts all 5 services (API, DB, Mailpit, Redis, MinIO).
2. MinIO console accessible at `http://localhost:9001`.
3. Redis responds to `redis-cli ping` inside its container.
4. Video worker container builds and starts successfully.

---

### SI-03.2 — Configuration Namespaces: S3/MinIO, Redis, and Storage

**Description:** Add configuration namespaces for S3/MinIO connection, Redis connection, and storage settings. Add environment variables and Joi validation.

**Technical actions:**

1. Create `src/config/storage.config.ts`:
   - `registerAs('storage', () => ({...}))` with S3 endpoint, bucket, access key, secret key, region.
   - Use env vars: `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_REGION`.

2. Create `src/config/redis.config.ts`:
   - `registerAs('redis', () => ({...}))` with host, port.
   - Use env vars: `REDIS_HOST`, `REDIS_PORT`.

3. Update `src/config/env.validation.ts`:
   - Add Joi validation for new env vars (STORAGE_*, REDIS_*).
   - Defaults: `STORAGE_ENDPOINT=http://minio:9000`, `STORAGE_BUCKET=streamtube`, `STORAGE_ACCESS_KEY=minioadmin`, `STORAGE_SECRET_KEY=minioadmin`, `STORAGE_REGION=us-east-1`, `REDIS_HOST=redis`, `REDIS_PORT=6379`.

4. Register new config factories in `AppModule` imports.

5. Add new env vars to `.env.example`.

**Dependencies:** SI-03.1 (Docker services must be defined to know hostnames).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/storage.config.spec.ts` | Unit | Config factory returns correct defaults |
| `src/config/redis.config.spec.ts` | Unit | Config factory returns correct defaults |
| `src/config/env.validation.integration-spec.ts` | Integration | Env validation accepts new vars |

**Acceptance criteria:**

1. `storageConfig` provides correct S3/MinIO connection params.
2. `redisConfig` provides correct Redis connection params.
3. Joi schema validates new env vars with correct defaults.
4. `npx tsc --noEmit` passes.

---

### SI-03.3 — Video Entity and Migration

**Description:** Create the `Video` entity and generate the database migration. The entity links to `Channel` (many videos per channel) and includes all fields for video metadata, storage keys, status, and URL slug.

**Technical actions:**

1. Create `src/videos/entities/video.entity.ts`:
   - Table: `videos`
   - Columns: `id` (uuid PK), `channel_id` (uuid FK), `title` (varchar 255), `description` (text, nullable), `status` (enum: draft, processing, ready, error), `slug` (varchar 21, unique, indexed), `storage_key` (varchar 512), `thumbnail_storage_key` (varchar 512, nullable), `duration` (int, nullable — seconds), `file_size` (bigint, nullable), `mime_type` (varchar 50, nullable), `original_filename` (varchar 500, nullable), `processing_error` (text, nullable), `created_at`, `updated_at`.
   - Relations: `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`.
   - Indexes: unique index on `slug`, index on `channel_id` + `status`.

2. Generate migration: `npm run migration:generate -- -d src/data-source.ts src/database/migrations/<timestamp>-CreateVideos`

3. Create `src/videos/entities/video.entity.integration-spec.ts`:
   - Test entity creation, unique constraint on slug, FK constraint on channel_id.

**Dependencies:** SI-03.2 (config for DB connection), Phase 02 (Channel entity must exist).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Entity maps correctly to DB, unique slug, FK constraints |

**Acceptance criteria:**

1. Migration creates `videos` table with all columns and indexes.
2. `slug` column has a unique index.
3. FK constraint on `channel_id` references `channels(id)`.
4. Integration test passes with real DB.
5. `npm run migration:run` succeeds.

---

### SI-03.4 — Object Storage Service (S3Service)

**Description:** Create a service wrapping the S3 client for MinIO interactions: presigned URL generation (upload parts + download), multipart upload lifecycle, and object operations.

**Technical actions:**

1. Create `src/videos/s3.config.ts`:
   - Factory function that creates an `S3Client` instance from storage config.
   - Use `forcePathStyle: true` for MinIO compatibility.

2. Create `src/videos/s3.service.ts`:
   - Inject `storageConfig` via `@Inject(storageConfig.KEY)`.
   - Create `S3Client` instance in constructor.
   - Methods:
     - `createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string; key: string }>`
     - `getPartPresignedUrl(key: string, uploadId: string, partNumber: number): Promise<string>`
     - `completeMultipartUpload(key: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]): Promise<void>`
     - `getDownloadPresignedUrl(key: string, expiresIn?: number): Promise<string>`
     - `getObject(key: string): Promise<Readable>`
     - `deleteObject(key: string): Promise<void>`

3. Create `src/videos/s3.service.spec.ts`:
   - Mock `S3Client` and `getSignedUrl`.
   - Test presigned URL generation, multipart upload flow.

4. Create `src/videos/s3.service.integration-spec.ts`:
   - Test against real MinIO container.
   - Test create → presign → complete lifecycle.

**Dependencies:** SI-03.2 (storage config).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/s3.service.spec.ts` | Unit | S3 operations, presigned URL generation |
| `src/videos/s3.service.integration-spec.ts` | Integration | Real MinIO interaction, multipart upload lifecycle |

**Acceptance criteria:**

1. `S3Service` generates valid presigned URLs for upload parts.
2. `S3Service` completes multipart upload correctly.
3. `S3Service` generates presigned download URLs.
4. Unit tests mock S3Client correctly.
5. Integration tests pass against real MinIO.

---

### SI-03.5 — VideosModule, Upload Initiation Endpoint, and Draft Creation

**Description:** Create the `VideosModule` with controller, service, and DTOs. Implement the upload initiation endpoint that creates a draft video record and returns presigned URLs for multipart upload.

**Technical actions:**

1. Create `src/videos/dto/init-upload.dto.ts`:
   - Fields: `title` (string, required), `fileName` (string, required), `fileSize` (number, required), `mimeType` (string, required).
   - class-validator decorators on all fields.

2. Create `src/videos/dto/init-upload-response.dto.ts`:
   - Fields: `videoId` (uuid), `uploadId` (string), `presignedUrls` (array of { partNumber, url }), `partSize` (number), `totalParts` (number).

3. Create `src/videos/videos.service.ts`:
   - Inject: `Repository<Video>`, `S3Service`, `DataSource`.
   - Method `initUpload(userId, dto)`:
     - Look up user's channel (1:1 relationship).
     - Generate nanoid slug (11 chars, unique — retry on collision).
     - Create video record with status `draft`.
     - Create multipart upload on MinIO.
     - Generate presigned URLs for each part.
     - Return upload details to client.

4. Create `src/videos/videos.controller.ts`:
   - `POST /videos/upload/init` — Protected (JWT). Calls `videosService.initUpload()`.
   - OpenAPI decorators.

5. Create `src/videos/videos.module.ts`:
   - Imports: `TypeOrmModule.forFeature([Video])`, `BullModule.registerQueue({ name: 'video-processing' })`.
   - Providers: `VideosService`, `S3Service`.
   - Controllers: `VideosController`.

6. Register `VideosModule` in `AppModule`.

7. Create `src/videos/videos.service.spec.ts`:
   - Test slug generation, draft creation, S3Service mock.

8. Create `src/videos/videos.service.integration-spec.ts`:
   - Test full init upload flow with real DB and MinIO.

9. Create `src/videos/videos.controller.spec.ts`:
   - Test controller delegates to service.

**Dependencies:** SI-03.3 (Video entity), SI-03.4 (S3Service).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Init upload logic, slug generation, draft creation |
| `src/videos/videos.service.integration-spec.ts` | Integration | Full flow with real DB + MinIO |
| `src/videos/videos.controller.spec.ts` | Unit | Controller delegates to service |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles correctly |

**Acceptance criteria:**

1. `POST /videos/upload/init` returns presigned URLs for multipart upload.
2. Video record is created with status `draft` and unique slug.
3. Slug is 11 characters, URL-safe, unique.
4. Presigned URLs are valid for MinIO upload.
5. All tests pass.

---

### SI-03.6 — Upload Completion and Processing Job Enqueue

**Description:** Implement the upload completion endpoint that finalizes the multipart upload on MinIO and enqueues a video processing job to BullMQ.

**Technical actions:**

1. Create `src/videos/dto/complete-upload.dto.ts`:
   - Fields: `videoId` (uuid), `uploadId` (string), `parts` (array of { PartNumber: number, ETag: string }).
   - class-validator decorators.

2. Add method `completeUpload(userId, dto)` to `VideosService`:
   - Verify video belongs to user's channel.
   - Verify video status is `draft`.
   - Call `S3Service.completeMultipartUpload()`.
   - Update video status to `processing`.
   - Add BullMQ job to `video-processing` queue with video ID.
   - Return updated video.

3. Add endpoint `POST /videos/upload/complete` to `VideosController`:
   - Protected (JWT).
   - Calls `videosService.completeUpload()`.

4. Create `src/videos/dto/cancel-upload.dto.ts`:
   - Fields: `videoId` (uuid), `uploadId` (string).

5. Add method `cancelUpload(userId, dto)` to `VideosService`:
   - Abort multipart upload on MinIO.
   - Delete video record (status `draft`).

6. Add endpoint `POST /videos/upload/cancel` to `VideosController`:
   - Protected (JWT).

7. Create tests for complete and cancel operations.

**Dependencies:** SI-03.5 (VideosModule, init upload), SI-03.4 (S3Service), SI-03.1 (Redis for BullMQ).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Complete/cancel logic, job enqueue |
| `src/videos/videos.service.integration-spec.ts` | Integration | Full flow with real DB + MinIO + Redis |

**Acceptance criteria:**

1. `POST /videos/upload/complete` finalizes the upload and enqueues processing.
2. Video status changes from `draft` to `processing`.
3. BullMQ job is created with the video ID.
4. `POST /videos/upload/cancel` aborts upload and deletes draft.
5. Only the video owner can complete/cancel.
6. All tests pass.

---

### SI-03.7 — Video Processing Worker (BullMQ Processor)

**Description:** Create the video processing worker that consumes jobs from BullMQ, extracts metadata via ffprobe, generates a thumbnail via FFmpeg, and updates the video record.

**Technical actions:**

1. Create `src/worker/main.ts`:
   - Bootstrap NestJS application with only the necessary modules (VideosModule, DatabaseModule, ConfigModule).
   - No HTTP server — worker-only bootstrap.

2. Create `src/worker/video.processor.ts`:
   - `@Processor('video-processing')` decorator.
   - `@Process()` handler:
     - Download video from MinIO to temp file.
     - Run `ffprobe` to extract: duration, resolution, codec, file size.
     - Run `ffmpeg` to generate thumbnail (frame at 25% of duration, 1280x720).
     - Upload thumbnail to MinIO.
     - Update video record: status → `ready`, duration, thumbnail_storage_key, metadata.
     - On error: status → `error`, processing_error message.
     - Clean up temp files.

3. Create `src/worker/video.processor.spec.ts`:
   - Test processor handles successful processing.
   - Test processor handles ffprobe/ffmpeg errors.
   - Test processor cleans up temp files.

4. Create `src/worker/worker.module.ts`:
   - Imports: `BullModule.forRoot()`, `BullModule.registerQueue()`, `TypeOrmModule`, `ConfigModule`.

5. Update `Dockerfile.worker`:
   - Install FFmpeg in the Docker image.
   - Entry point: `node dist/worker/main.js`.

**Dependencies:** SI-03.1 (Redis, Docker worker), SI-03.3 (Video entity), SI-03.4 (S3Service for download/upload).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/video.processor.spec.ts` | Unit | Processing logic, metadata extraction, thumbnail generation |

**Acceptance criteria:**

1. Worker consumes jobs from `video-processing` queue.
2. ffprobe extracts video duration and metadata.
3. ffmpeg generates a thumbnail at 25% of video duration.
4. Thumbnail is uploaded to MinIO.
5. Video status changes from `processing` to `ready`.
6. On error, status changes to `error` with error message.
7. Temp files are cleaned up after processing.

---

### SI-03.8 — Video URL Resolution and Slug Lookup

**Description:** Implement the video URL resolution endpoint that looks up a video by its unique slug and returns video metadata.

**Technical actions:**

1. Add method `findBySlug(slug: string)` to `VideosService`:
   - Find video by slug where status is `ready`.
   - Include channel information (channel name, nickname).
   - Throw `VideoNotFoundException` if not found or not ready.

2. Add endpoint `GET /videos/:slug` to `VideosController`:
   - Public (no auth required — anonymous users can watch).
   - Returns video metadata (title, description, duration, channel info, thumbnail URL).
   - Does NOT return the streaming URL (separate endpoint).

3. Create `src/videos/dto/video-response.dto.ts`:
   - Fields: id, title, description, slug, duration, channel (name, nickname), thumbnailUrl, createdAt.

4. Create domain exceptions for video operations:
   - `VideoNotFoundException` (404)
   - `VideoNotReadyException` (400) — video still processing
   - `VideoAccessDeniedException` (403) — not owner

**Dependencies:** SI-03.3 (Video entity), SI-03.5 (VideosService).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Slug lookup, error handling |
| `test/videos.e2e-spec.ts` | E2E | Full HTTP flow for video lookup |

**Acceptance criteria:**

1. `GET /videos/:slug` returns video metadata for ready videos.
2. Returns 404 for non-existent slugs.
3. Returns appropriate error for videos still processing.
4. Anonymous users can access the endpoint.
5. All tests pass.

---

### SI-03.9 — Video Streaming and Download Endpoints

**Description:** Implement streaming and download endpoints that generate presigned GET URLs for MinIO, enabling the client to stream or download the video directly.

**Technical actions:**

1. Add method `getStreamUrl(userId: string | null, slug: string)` to `VideosService`:
   - Find video by slug (status must be `ready`).
   - Generate presigned GET URL from MinIO (expires in 1 hour).
   - Return URL and content type.

2. Add endpoint `GET /videos/:slug/stream` to `VideosController`:
   - Public (anonymous users can stream).
   - Returns `{ url: string, contentType: string }` — client redirects or streams from this URL.
   - MinIO handles Range requests natively.

3. Add endpoint `GET /videos/:slug/download` to `VideosController`:
   - Public (anonymous users can download).
   - Returns presigned URL with `Content-Disposition: attachment` header.
   - Returns `{ url: string, fileName: string }`.

4. Add method `getThumbnailUrl(slug: string)` to `VideosService`:
   - Generate presigned URL for the thumbnail object.
   - Used in video metadata responses.

5. Update video response DTOs to include thumbnail URL.

**Dependencies:** SI-03.4 (S3Service presigned URLs), SI-03.8 (slug lookup).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Stream/download URL generation |
| `test/videos.e2e-spec.ts` | E2E | Stream and download endpoints |

**Acceptance criteria:**

1. `GET /videos/:slug/stream` returns a presigned URL for streaming.
2. `GET /videos/:slug/download` returns a presigned URL for download.
3. URLs are valid and accessible from MinIO.
4. Anonymous users can access both endpoints.
5. Presigned URLs expire after 1 hour.
6. All tests pass.

---

### SI-03.10 — List Videos by Channel

**Description:** Implement an endpoint to list videos for a specific channel, supporting pagination and filtering by status.

**Technical actions:**

1. Add method `listByChannel(channelId: string, options: { page, limit, status? })` to `VideosService`:
   - Query videos by channel_id with pagination.
   - Optional filter by status.
   - Return paginated results with total count.

2. Add endpoint `GET /channels/:nickname/videos` to `VideosController`:
   - Public (anonymous users can see published videos).
   - Returns paginated list of video metadata.

3. Create `src/videos/dto/list-videos.dto.ts`:
   - Query params: `page` (default 1), `limit` (default 20), `status` (optional).

**Dependencies:** SI-03.3 (Video entity), SI-03.5 (VideosService).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | List by channel, pagination |
| `test/videos.e2e-spec.ts` | E2E | List endpoint |

**Acceptance criteria:**

1. `GET /channels/:nickname/videos` returns paginated video list.
2. Supports page/limit query parameters.
3. Optional status filter works.
4. Only `ready` videos shown to anonymous users; owner sees all statuses.
5. All tests pass.

---

### SI-03.11 — Definition of Done Verification

**Description:** Run the full Definition of Done checks: test suite, TypeScript compilation, and lint.

**Technical actions:**

1. Run `docker compose exec nestjs-api npm test -- --runInBand` — full unit + integration suite.
2. Run `docker compose exec nestjs-api npm run test:e2e` — full E2E suite.
3. Run `docker compose exec nestjs-api npx tsc --noEmit` — TypeScript compilation.
4. Run `docker compose exec nestjs-api npm run lint` — ESLint.
5. Fix any failures.
6. Update `docs/phases/phase-03-videos/progress.md` with final status.

**Dependencies:** All previous SIs.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| Full test suite | All | Definition of Done |

**Acceptance criteria:**

1. `npm test -- --runInBand` — all tests pass (green).
2. `npm run test:e2e` — all E2E tests pass.
3. `npx tsc --noEmit` — exits with code 0.
4. `npm run lint` — no errors.
5. `progress.md` updated with completed status.

---

## Technical Specifications

### Data Model

**Table: `videos`**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PK, default gen_random_uuid() | Video identifier |
| channel_id | uuid | FK → channels(id), NOT NULL | Owner channel |
| title | varchar(255) | NOT NULL | Video title |
| description | text | NULLABLE | Video description |
| status | enum('draft','processing','ready','error') | NOT NULL, default 'draft' | Processing status |
| slug | varchar(21) | UNIQUE, NOT NULL | URL-safe unique identifier |
| storage_key | varchar(512) | NOT NULL | S3/MinIO key for video file |
| thumbnail_storage_key | varchar(512) | NULLABLE | S3/MinIO key for thumbnail |
| duration | integer | NULLABLE | Duration in seconds |
| file_size | bigint | NULLABLE | File size in bytes |
| mime_type | varchar(50) | NULLABLE | MIME type (e.g., video/mp4) |
| original_filename | varchar(500) | NULLABLE | Original uploaded filename |
| processing_error | text | NULLABLE | Error message if processing failed |
| created_at | timestamp | NOT NULL, default NOW() | Creation timestamp |
| updated_at | timestamp | NOT NULL | Last update timestamp |

**Indexes:**
- `UQ_videos_slug` — unique index on `slug`
- `IDX_videos_channel_status` — composite index on `channel_id` + `status`

### API Contracts

**POST /videos/upload/init** (Protected — JWT)
```
Request: { title: string, fileName: string, fileSize: number, mimeType: string }
Response: { videoId: uuid, uploadId: string, presignedUrls: [{ partNumber: number, url: string }], partSize: number, totalParts: number }
```

**POST /videos/upload/complete** (Protected — JWT)
```
Request: { videoId: uuid, uploadId: string, parts: [{ PartNumber: number, ETag: string }] }
Response: { id: uuid, status: 'processing', slug: string }
```

**POST /videos/upload/cancel** (Protected — JWT)
```
Request: { videoId: uuid, uploadId: string }
Response: { success: true }
```

**GET /videos/:slug** (Public)
```
Response: { id, title, description, slug, duration, channel: { name, nickname }, thumbnailUrl, createdAt }
```

**GET /videos/:slug/stream** (Public)
```
Response: { url: string, contentType: string }
```

**GET /videos/:slug/download** (Public)
```
Response: { url: string, fileName: string }
```

**GET /channels/:nickname/videos** (Public)
```
Query: ?page=1&limit=20&status=ready
Response: { data: VideoListItem[], meta: { page, limit, total, totalPages } }
```

### Authorization Matrix

| Endpoint | Auth Required | Owner Only | Notes |
|----------|:------------:|:----------:|-------|
| POST /videos/upload/init | Yes | Yes (channel) | Must own channel |
| POST /videos/upload/complete | Yes | Yes (video) | Must own video |
| POST /videos/upload/cancel | Yes | Yes (video) | Must own video |
| GET /videos/:slug | No | — | Public for ready videos |
| GET /videos/:slug/stream | No | — | Public for ready videos |
| GET /videos/:slug/download | No | — | Public for ready videos |
| GET /channels/:nickname/videos | No | — | Public; owner sees all statuses |

### Error Catalog

| Error Code | HTTP Status | Description |
|-----------|:-----------:|-------------|
| VIDEO_NOT_FOUND | 404 | Video with given slug does not exist |
| VIDEO_NOT_READY | 400 | Video is still processing or in error state |
| VIDEO_ACCESS_DENIED | 403 | User does not own this video |
| VIDEO_UPLOAD_INIT_FAILED | 500 | Failed to initialize multipart upload |
| VIDEO_PROCESSING_FAILED | 500 | Video processing failed (FFmpeg error) |
| VIDEO_SLUG_COLLISION | 500 | Slug collision after retries (extremely unlikely) |

### Events/Messages

**BullMQ Queue: `video-processing`**

| Event | Producer | Consumer | Payload | Retry Strategy |
|-------|----------|----------|---------|----------------|
| video.process | VideosService (API) | VideoProcessor (Worker) | `{ videoId: uuid }` | 3 retries, exponential backoff (5s, 30s, 120s) |

**Job Lifecycle:**
1. API creates job on upload completion.
2. Worker picks up job, downloads video from MinIO.
3. Worker extracts metadata (ffprobe) and generates thumbnail (ffmpeg).
4. Worker uploads thumbnail to MinIO.
5. Worker updates video status to `ready` with metadata.
6. On failure: status → `error`, `processing_error` set, job retried up to 3 times.

---

## Dependency Map

```
SI-03.1 (Docker Infrastructure)
    ↓
SI-03.2 (Configuration)
    ↓
SI-03.3 (Video Entity + Migration)
    ↓
SI-03.4 (S3Service)
    ↓
SI-03.5 (VideosModule + Init Upload) ← depends on SI-03.3, SI-03.4
    ↓
SI-03.6 (Upload Completion + Job Enqueue) ← depends on SI-03.5
    ↓
SI-03.7 (Video Processing Worker) ← depends on SI-03.1, SI-03.3, SI-03.4
    ↓
SI-03.8 (Video URL Resolution) ← depends on SI-03.3, SI-03.5
    ↓
SI-03.9 (Streaming + Download) ← depends on SI-03.4, SI-03.8
    ↓
SI-03.10 (List Videos) ← depends on SI-03.3, SI-03.5
    ↓
SI-03.11 (DoD Verification) ← depends on all SIs
```

---

## Deliverables

- [ ] Docker Compose with MinIO, Redis, and Video Worker services
- [ ] Video entity and migration
- [ ] S3Service for MinIO interactions
- [ ] VideosModule with controller and service
- [ ] Upload initiation endpoint (presigned multipart)
- [ ] Upload completion endpoint (finalize + enqueue)
- [ ] Upload cancellation endpoint
- [ ] Video processing worker (FFmpeg metadata + thumbnail)
- [ ] Video slug lookup endpoint
- [ ] Video streaming endpoint (presigned URL)
- [ ] Video download endpoint (presigned URL)
- [ ] Channel video listing endpoint
- [ ] Domain exceptions for video operations
- [ ] Unit, integration, and E2E tests
- [ ] Configuration namespaces (storage, redis)
- [ ] Environment variables documented in .env.example
- [ ] Full Definition of Done passing (tests + tsc + lint)
