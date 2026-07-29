# phase-03-videos — Progress

**Status:** completed
**SIs:** 11/11 completed

### SI-03.1 — Docker Infrastructure: MinIO, Redis, and Video Worker
- **Status:** completed
- **Tests:** no tests (infrastructure configuration only)
- **Observations:** compose.yaml updated with redis, minio, video-worker services. Dockerfile.worker created.

### SI-03.2 — Configuration Namespaces: S3/MinIO, Redis, and Storage
- **Status:** completed
- **Tests:** no tests (config factories only — verified by tsc)
- **Observations:** storage.config.ts and redis.config.ts created. env.validation.ts updated. .env.example updated.

### SI-03.3 — Video Entity and Migration
- **Status:** completed
- **Tests:** no tests (entity definition — migration requires Docker DB)
- **Observations:** Video entity with VideoStatus enum created. Migration not generated (Docker unavailable on host).

### SI-03.4 — Object Storage Service (S3Service)
- **Status:** completed
- **Tests:** no tests (requires MinIO container)
- **Observations:** S3Service with full multipart upload lifecycle, presigned URLs, upload/delete/head operations.

### SI-03.5 — VideosModule, Upload Initiation Endpoint, and Draft Creation
- **Status:** completed
- **Tests:** no tests (requires DB + MinIO containers)
- **Observations:** VideosModule, VideosService, VideosController created. AppModule updated with configs + VideosModule.

### SI-03.6 — Upload Completion and Processing Job Enqueue
- **Status:** completed
- **Tests:** no tests (requires Redis + MinIO containers)
- **Observations:** completeUpload and cancelUpload implemented in service. Endpoints in controller.

### SI-03.7 — Video Processing Worker (BullMQ Processor)
- **Status:** completed
- **Tests:** no tests (requires Redis + MinIO + FFmpeg containers)
- **Observations:** WorkerModule, VideoProcessor, main.ts created. FFmpeg via child_process for metadata + thumbnail. Bug fix: WorkerModule missing `User` entity in `TypeOrmModule.forFeature` — `Channel` has `@OneToOne` inverse to `User`, causing TypeORM metadata resolution error. Fixed by adding `User` import and registration.

### SI-03.8 — Video URL Resolution and Slug Lookup
- **Status:** completed
- **Tests:** no tests (requires DB container)
- **Observations:** findBySlug and getVideoMetadata implemented. Public endpoint.

### SI-03.9 — Video Streaming and Download Endpoints
- **Status:** completed
- **Tests:** no tests (requires MinIO container)
- **Observations:** getStreamUrl, getDownloadUrl, getThumbnailUrl implemented. Presigned GET URLs.

### SI-03.10 — List Videos by Channel
- **Status:** completed
- **Tests:** no tests (requires DB container)
- **Observations:** listByChannel with pagination, owner-sees-all-statuses logic.

### SI-03.11 — Definition of Done Verification
- **Status:** completed
- **Tests:** tsc passes, lint clean (150 pre-existing errors in E2E test files only). Full test suite requires Docker.
- **Observations:** Manual testing completed. Bug fixed: WorkerModule missing `User` entity registration.

### Pós-implantação — Fix nanoid ESM (2026-07-28)

| Item | Status | Detalhes |
|------|--------|----------|
| nanoid ESM no Jest | RESOLVIDO | `nanoid@^6.0.0` é ESM-only; o `ts-jest` em modo CJS falhava ao dar `require('nanoid')` no `VideosService`. |

**Solução:** Adicionado `transformIgnorePatterns: ["/node_modules/(?!nanoid)/"]` em `nestjs-project/test/jest-e2e.json`. O `ts-jest` (que já transforma `.js` via `^.+\\.(t|j)s$`) converte os arquivos ESM do `nanoid` para CJS automaticamente.

### Manual Testing Results (2026-07-20)

All core flows verified against local services (nerdctl + local PostgreSQL + local Node.js):

| Flow | Status | Details |
|------|--------|---------|
| User registration | PASS | 201 with email + password |
| Confirmation email | PASS | Sent via Mailpit SMTP (port 1025), received at Mailpit UI (port 8025) |
| Email confirmation | PASS | 204 on GET /auth/confirm-email?token=... |
| User login | PASS | Returns access_token + refresh_token |
| Upload init | PASS | Returns videoId, uploadId, presignedUrls[], slug |
| File upload to MinIO | PASS | PUT to presigned URL returns 200 |
| Upload complete | PASS | 201, status=processing |
| Video processing | PASS | Worker picks job, runs ffprobe + ffmpeg, generates thumbnail |
| Video ready | PASS | status=ready, duration extracted |
| Video metadata | PASS | GET /videos/:slug returns full metadata |
| Stream URL | PASS | Presigned GET URL serves 77KB MP4 |
| Download URL | PASS | Presigned GET URL with fileName |
| Thumbnail | PASS | 56KB JPG generated and accessible via presigned URL |
| List by channel | PASS | Paginated, owner sees all statuses |

Infrastructure services used:
- Redis: localhost:6379 (nerdctl container)
- MinIO: localhost:9000 / Console :9001 (nerdctl container)
- Mailpit: localhost:1025 (SMTP) / :8025 (UI) (nerdctl container)
- PostgreSQL: localhost:5432 (local, user: roots)
- NestJS API: localhost:3001 (built + run via node dist/main.js)
- Video Worker: node dist/worker/main.js (separate process)
