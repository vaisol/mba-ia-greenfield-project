---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-20
scope_description: "Video upload, processing, storage, streaming, and background job infrastructure for the StreamTube platform."
---

# Technical Decisions — Phase 03: Upload e Processamento de Videos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers video upload endpoints, presigned URL generation, video metadata management, streaming/download endpoints, and orchestrates the processing pipeline via a message queue.
- `next-frontend/` — Frontend deferred: video upload UI, player, and management screens will be addressed in a future phase. No open decision in this document.

---

## TD-01: Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Phase 03 requires a background job queue to process uploaded videos asynchronously (extract metadata via ffprobe, generate thumbnails via FFmpeg). The architecture diagram specifies a "Message Queue (TBD)". The queue must run reliably in Docker, support retries with backoff, and integrate cleanly with NestJS 11.

**Options:**

### Option A: BullMQ + @nestjs/bullmq (Redis)
- BullMQ is the actively developed successor to Bull, built on Redis. The `@nestjs/bullmq` package (v11.0.4) is maintained by the NestJS core team and officially documented at docs.nestjs.com/techniques/queues. Uses Redis as the backing store.
- **Pros:** Official NestJS integration — guaranteed compatibility with NestJS 11. Feature-rich: retries with exponential backoff, delayed jobs, concurrency control, rate limiting, priority queues, flow orchestration (producer-consumer chains). 6.7M weekly npm downloads. Bull Board for monitoring. Battle-tested at scale (Microsoft, Vendure).
- **Cons:** Requires a Redis container (~15MB, negligible resource usage). Redis is an additional infrastructure dependency vs. reusing PostgreSQL.

### Option B: pg-boss (PostgreSQL)
- A PostgreSQL-backed job queue using `SKIP LOCKED` for reliable job claiming. Uses the existing PostgreSQL database — no new infrastructure. `pg-boss` has 916K weekly downloads and is actively maintained (multiple releases per week).
- **Pros:** Zero new infrastructure — reuses the existing PostgreSQL container. Exactly-once delivery via SKIP LOCKED. Active maintenance (82 contributors). Features include retries, scheduling, workflow orchestration, and a monitoring dashboard.
- **Cons:** NestJS integration is community-only (`@wavezync/nestjs-pgboss` — single maintainer, not officially supported). No official `@nestjs/pg-boss` package. Adds load to the PostgreSQL instance that also serves the application database. Less mature ecosystem compared to BullMQ.

### Option C: BeeQueue (Redis)
- A simple, lightweight Redis queue. ~29K weekly downloads. Minimal API surface.
- **Pros:** Very simple to set up. Low dependency footprint.
- **Cons:** No priority queues, no rate limiting, no job flows, no monitoring UI. Maintenance is uncertain (v2.0.0 was a Node.js version bump only, 7+ months since last release). No official NestJS integration. Insufficient feature set for video processing pipeline.

**Recommendation:** **Option A (BullMQ + @nestjs/bullmq)** — The official NestJS integration is decisive for a project that follows NestJS conventions. BullMQ's feature set (retries, concurrency, flow orchestration) matches the video processing pipeline requirements exactly. Redis is a minimal infrastructure addition (~15MB) that also enables future caching. pg-boss is attractive for eliminating Redis but lacks official NestJS support — adopting an unmaintained community wrapper for a critical infrastructure component is a risk not worth taking.

**Decision:** A (BullMQ + @nestjs/bullmq with Redis)

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`

---

## TD-02: Upload Strategy for Large Files (10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The platform must support video uploads up to 10GB without blocking the API server or consuming excessive memory. The storage backend is MinIO (S3-compatible) running in Docker. The upload must be resumable on connection failure. Depends on TD-03 (Object Storage).

**Options:**

### Option A: Presigned Multipart Upload (Client → MinIO directly)
- The API generates presigned URLs for each part of a multipart upload. The client uploads parts directly to MinIO, bypassing the API server entirely. Flow: (1) client requests upload initialization → API creates multipart upload on MinIO, returns uploadId + presigned URLs for each part → (2) client uploads parts directly to MinIO → (3) client notifies API of completion → API completes the multipart upload on MinIO.
- **Pros:** Zero memory impact on the API — bytes never pass through the server. Resumable per-part (failed parts can be retried independently). S3 multipart upload is natively supported by MinIO. Well-established pattern for large file uploads.
- **Cons:** More complex implementation (3-step handshake: init → upload → complete). Client must handle chunking logic (or use a library like Uppy). Presigned URLs have expiry (must be long enough for large uploads or refreshed).

### Option B: Tus Protocol (Resumable Uploads via API)
- The tus protocol (https://tus.io) provides resumable uploads via HTTP. The `@tus/server` package with `@tus/s3-store` streams uploads through the API server to S3/MinIO. Supports concatenation for parallel uploads.
- **Pros:** Protocol-level resumability built-in. Standard protocol with client libraries in many languages. Handles chunking automatically.
- **Cons:** Every byte still traverses the NestJS server (memory and bandwidth impact). `@tus/server` is Express middleware — integration with NestJS requires custom wiring. Community NestJS examples are sparse. The server acts as a proxy for all upload traffic, creating a bottleneck for 10GB files.

### Option C: Multipart Upload via API (Client → API → MinIO)
- Client sends file chunks via `multipart/form-data` to the API. API streams each chunk to MinIO using `@aws-sdk/client-s3`. Uses Multer for multipart parsing.
- **Pros:** Simplest implementation — single endpoint, standard HTTP. No presigned URL complexity.
- **Cons:** **Fatal for 10GB** — `FileInterceptor` in `@nestjs/platform-express` waits for Multer to finish parsing before calling the controller (nestjs/nest#13158). For files > `highWaterMark` (~16KB), backpressure causes deadlock. Even with streaming Multer config, all bytes pass through the API server consuming memory and bandwidth. No native resumability.

**Recommendation:** **Option A (Presigned Multipart Upload)** — The only strategy that truly keeps the API server free from file content. For 10GB videos, this is a hard architectural requirement, not a nice-to-have. The implementation complexity is justified: the 3-step handshake is well-documented in AWS/MinIO guides, and libraries like `@uppy/aws-s3-multipart` handle client-side chunking automatically.

**Decision:** A (Presigned Multipart Upload — client uploads directly to MinIO)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## TD-03: Object Storage Configuration

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The architecture diagram specifies "Object Storage (S3 or MinIO)" for video files and thumbnails. MinIO is the local development choice (S3-compatible API). The decision here covers bucket organization, key structure, and access patterns.

**Options:**

### Option A: Single bucket with path-based key prefix
- All files stored in one bucket (`streamtube`) with key prefixes: `videos/{video-id}/source.mp4`, `videos/{video-id}/thumbnail.jpg`. MinIO default bucket.
- **Pros:** Simplest configuration — one bucket, one set of policies. Path-based separation is sufficient for a single-tenant development platform. Easy to manage and back up.
- **Cons:** No isolation between video files and thumbnails at the bucket policy level. Bucket-level operations (listing, lifecycle rules) affect all files.

### Option B: Separate buckets for videos and thumbnails
- Two buckets: `streamtube-videos` and `streamtube-thumbnails`. Each with its own lifecycle policies and access rules.
- **Pros:** Clean separation of concerns. Can apply different lifecycle policies (e.g., delete incomplete multipart uploads after 1 day). Easier to set bucket-specific CORS or access policies.
- **Cons:** Two buckets to manage and configure. Slightly more complex initialization. Overkill for a development/local setup.

### Option C: Single bucket with MinIO event notifications
- Same as Option A, but configure MinIO event notifications to trigger webhooks on upload completion. Events sent to the NestJS API.
- **Pros:** Server-side notification of upload completion without polling. Decoupled architecture.
- **Cons:** MinIO event notifications require additional configuration. Adds complexity for a flow that can be handled by the client notifying the API after completing the multipart upload (Option A's step 3). MinIO events may not be reliable in all Docker configurations.

**Recommendation:** **Option A (Single bucket with path prefix)** — For a development/local setup, a single bucket with path-based keys is sufficient and simplest. The key structure (`videos/{video-id}/source.mp4`, `videos/{video-id}/thumbnail.jpg`) provides clear organization. Lifecycle policies and bucket policies can be added later if needed.

**Decision:** A (Single bucket `streamtube` with path-based key prefix)

**Libraries:** `@aws-sdk/client-s3@^3.x`

---

## TD-04: Video Processing Worker Architecture

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** After a video is uploaded to MinIO, it must be processed: metadata extraction (duration, resolution, codec) via ffprobe, and thumbnail generation via FFmpeg. The worker must run as a separate Docker container and consume jobs from the BullMQ queue (TD-01). Depends on TD-01 (queue) and TD-03 (storage).

**Options:**

### Option A: Separate NestJS container with BullMQ Worker + FFmpeg
- A dedicated NestJS container runs a `VideoProcessor` class (BullMQ `@Processor` decorator) that consumes from the `video-processing` queue. FFmpeg and ffprobe are invoked via `child_process.execFile()` from a base image that includes FFmpeg (e.g., `jrottenberg/ffmpeg:alpine`). The worker downloads the video from MinIO, processes it, uploads the thumbnail back to MinIO, and updates the database.
- **Pros:** Follows NestJS patterns — uses the same DI container, config system, and TypeORM entities as the API. BullMQ's `Worker` class integrates cleanly with NestJS. The worker container shares the same codebase as the API (different entrypoint or module). Reuses the project's config conventions (database, MinIO, Redis config).
- **Cons:** The worker container needs FFmpeg in its Docker image (adds ~50-100MB to the image). Two containers running NestJS (API + worker) — but with different purposes.

### Option B: Pure FFmpeg container (no NestJS)
- A lightweight container running a custom Node.js script that pulls jobs from Redis directly (using `bullmq` without NestJS), invokes FFmpeg, and updates the database via raw SQL or a lightweight ORM connection.
- **Pros:** Smaller container image (no NestJS overhead). Potentially faster startup. Simpler mental model — just a script that processes videos.
- **Cons:** Duplicates configuration logic (database connection, MinIO credentials, Redis connection). Loses NestJS DI, config conventions, and entity management. Must maintain a separate codebase or script outside the NestJS project. No shared type safety between API and worker.

### Option C: FFmpeg as a sidecar container with inter-container communication
- The API container communicates with an FFmpeg sidecar via HTTP or Unix socket. The sidecar exposes a simple API: POST /process with the video path, returns when done.
- **Pros:** Clean separation of concerns. FFmpeg runs in its own isolated environment.
- **Cons:** Adds network/IPC overhead between containers. Requires a custom HTTP server in the FFmpeg container. Over-engineered for the use case — FFmpeg is invoked via command-line, not as a persistent service.

**Recommendation:** **Option A (Separate NestJS container with BullMQ Worker)** — Keeps the worker within the NestJS ecosystem, reusing config, entities, and DI. The FFmpeg dependency is handled by the Docker base image (`jrottenberg/ffmpeg:alpine` or similar). The worker and API share the same `src/` codebase but run different modules — this is a standard NestJS pattern for background workers. The ~50-100MB image size increase is acceptable for a development environment.

**Decision:** A (Separate NestJS container with BullMQ Worker + FFmpeg via child_process)

**Libraries:** (FFmpeg via Docker base image, no additional npm packages beyond BullMQ)

---

## TD-05: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros

**Context:** Each video needs a unique, URL-safe identifier used in public URLs (e.g., `/watch/{slug}`). The identifier must be collision-resistant, URL-safe, and human-friendly (short enough for sharing). The project already uses UUIDs for primary keys (TD from Phase 01 conventions).

**Options:**

### Option A: nanoid (21 chars, URL-safe alphabet)
- `nanoid` generates URL-safe IDs using `A-Za-z0-9_-` alphabet. 21 characters by default (same collision resistance as UUID v4). 118 bytes minified. Uses hardware random generator (crypto.getRandomValues).
- **Pros:** Tiny (118 bytes, zero dependencies). URL-safe by default. 21 chars is short enough for sharing. Collision probability: 1 in 2^106. Custom alphabet and length supported. 27K GitHub stars, widely adopted.
- **Cons:** 21 characters is longer than YouTube's 11-char IDs. Not human-readable or memorable. Different format from the UUID primary key (may confuse developers expecting consistency).

### Option B: nanoid with custom short alphabet (11 chars)
- Use `nanoid` with a custom alphabet and 11-character length, matching YouTube's URL slug length. Custom alphabet: `A-Za-z0-9_-` (64 chars). 11 chars from 64-char alphabet = ~66 bits of entropy.
- **Pros:** Same length as YouTube URLs (familiar pattern). Still high collision resistance (1 in 2^66 — sufficient for millions of videos). URL-safe. Very short and shareable.
- **Cons:** Lower entropy than UUID v4 (acceptable for video count scale). Custom configuration needed. Slightly higher collision risk than 21-char default (still negligible for expected scale).

### Option C: UUID v4 (same as primary key)
- Use the same UUID v4 format as the entity's primary key for the public URL slug. 36 characters with hyphens.
- **Pros:** Zero additional library. Guaranteed unique (already the PK). Consistent with the project's UUID convention.
- **Cons:** 36 characters is long for a shareable URL. Hyphens in URLs can be confusing. No customizability. Not aesthetically pleasing for public-facing URLs.

**Recommendation:** **Option B (nanoid with 11-char custom alphabet)** — YouTube-length slugs (11 chars) are the proven pattern for video sharing platforms. 66 bits of entropy is sufficient for any realistic video count. The `nanoid` library is tiny, dependency-free, and widely trusted. Using a separate `slug` field (distinct from the UUID PK) keeps the public URL clean while preserving UUID for internal references.

**Decision:** B (nanoid with custom 11-char alphabet using `A-Za-z0-9_-`)

**Libraries:** `nanoid@^5.x`

---

## TD-06: Video Streaming and Download Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo) e Download do vídeo pelo usuário

**Context:** Videos must be streamable (play without downloading the entire file) and downloadable. The video files are stored in MinIO. The API must serve or proxy video content to the frontend. Depends on TD-03 (Object Storage).

**Options:**

### Option A: MinIO Direct Streaming via Presigned URLs
- Generate a presigned GET URL for the video file in MinIO and return it to the client. The client streams directly from MinIO. For streaming, support HTTP Range requests (206 Partial Content). MinIO natively supports Range requests on presigned URLs.
- **Pros:** Zero bandwidth impact on the API server — video bytes flow directly from MinIO to the client. MinIO handles Range requests natively. Simplest implementation — just generate a presigned URL and return it. Scales horizontally without API bottleneck.
- **Cons:** Presigned URLs expose the MinIO endpoint directly (internal service name leaks to the client). In production, this would need a CDN or reverse proxy to hide the storage endpoint. In development, the MinIO endpoint is already on the Docker network and accessible via localhost mapping.

### Option B: API Proxy with Range Support
- The API endpoint streams the video from MinIO to the client, supporting HTTP Range requests. Uses `@nestjs/platform-express` response streaming (`res.set()` + pipe). The API acts as a proxy between the client and MinIO.
- **Pros:** The MinIO endpoint is hidden from the client — only the API URL is exposed. Full control over headers, caching, and access control at the API layer. Works in production without exposing internal storage.
- **Cons:** All video bytes pass through the API server — consumes API bandwidth and memory for every stream request. For a 10GB video, this creates a significant bottleneck. Multiple concurrent streams multiply the impact. Defeats the purpose of using presigned URLs for uploads.

### Option C: Hybrid — API generates presigned URLs, client streams from MinIO
- Same as Option A, but the API endpoint is a thin wrapper that authenticates the request, checks video access permissions, and returns a short-lived presigned URL. The client then streams directly from MinIO using the presigned URL.
- **Pros:** Combines access control (API layer) with direct streaming (MinIO). API only handles the lightweight URL generation, not the video bytes. Supports Range requests transparently via MinIO. Presigned URL expiry limits exposure window.
- **Cons:** Two requests from the client (one to API for URL, one to MinIO for streaming). Presigned URL still exposes MinIO endpoint. Slightly more complex than pure Option A.

**Recommendation:** **Option C (Hybrid — API generates presigned URLs for streaming)** — Provides authentication and access control at the API layer while keeping video bandwidth off the API server. The presigned URL approach with short expiry (e.g., 1 hour) limits exposure. For the download endpoint, the same presigned URL mechanism works with a `Content-Disposition: attachment` header. MinIO's native Range request support handles streaming without additional configuration. In production, a CDN can be placed in front of MinIO to hide the endpoint.

**Decision:** C (Hybrid — API generates presigned GET URLs for streaming/download)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology | BullMQ + @nestjs/bullmq | A (BullMQ + Redis) |
| TD-02 | Backend | Upload Strategy (10GB) | Presigned Multipart Upload | A (Client → MinIO directly) |
| TD-03 | Backend | Object Storage Configuration | Single bucket with path prefix | A (`streamtube` bucket) |
| TD-04 | Backend | Video Processing Worker | Separate NestJS container + FFmpeg | A (BullMQ Worker + child_process) |
| TD-05 | Backend | Unique Video URL Identifier | nanoid with custom alphabet | B (11-char `A-Za-z0-9_-`) |
| TD-06 | Backend | Video Streaming/Download | Hybrid presigned URLs | C (API generates presigned GET URLs) |
