---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-07-20
scope_description: "File upload strategy for 10GB video uploads to MinIO (S3-compatible) — presigned URLs vs multipart API vs Tus protocol"
---

# Technical Decisions — Video Upload Strategy

_Subprojects in scope:_

- `nestjs-project/` — Backend API: must handle upload initiation, presigned URL generation, metadata management, and orchestrate upload lifecycle
- `next-frontend/` (not yet initialized) — Frontend: must implement the upload client, progress tracking, and resumability UI

---

## TD-01: Upload Protocol

**Scope:** Cross-layer

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** The platform must support video uploads up to 10GB. The storage backend is MinIO (S3-compatible) running in Docker. The project plan (Phase 03) explicitly requires uploads up to 10GB without performance impact, and the project notes (§4) require resumability on connection failure. Three viable approaches exist: presigned URL upload (client → MinIO directly), multipart upload via API (client → API → MinIO), and Tus protocol (resumable uploads via @tus/server + @tus/s3-store). This is a cross-layer decision because it defines the handshake sequence between backend (URL generation, metadata tracking) and frontend (upload execution, progress, resumability).

**Options:**

### Option A: Presigned Multipart Upload (Client → MinIO directly, orchestrated by API)

- The API generates presigned URLs for each S3 multipart upload part. The client uploads parts directly to MinIO using these URLs. The API orchestrates the lifecycle: `CreateMultipartUpload` → return part URLs → client uploads parts → client reports completion → API calls `CompleteMultipartUpload`.
- **Pros:**
  - Zero memory impact on the API server — file bytes never touch NestJS
  - S3-native multipart provides part-level parallelism and automatic resumability at the part level
  - API server scales horizontally without upload memory concerns
  - `@aws-sdk/s3-request-presigner` + `@aws-sdk/client-s3` are mature, well-documented, and fully compatible with MinIO's S3 API
  - Compatible with existing NestJS + Express stack — no new dependencies beyond `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (already used in the ecosystem)
  - Presigned URLs are short-lived (configurable expiry), limiting abuse window
  - Frontend can use Uppy's `@uppy/aws-s3-multipart` for built-in progress tracking, parallel uploads, and retry
  - For 10GB with 100MB parts = 100 parts; with 25MB parts = 400 parts (both under MinIO's limits)
- **Cons:**
  - More complex API endpoint design (initiate, sign parts, complete, abort)
  - Frontend must implement part tracking, retry logic, and completion handshake (mitigated by Uppy)
  - Requires MinIO CORS configuration for browser-direct uploads
  - Auth tokens must be included in presigned URL requests (content-type headers) or managed via separate auth mechanism
  - Requires a "pending video" DB record before upload starts (to track upload state)

### Option B: Tus Protocol (@tus/server + @tus/s3-store)

- Client uploads via Tus protocol to the NestJS API. `@tus/server` runs as middleware within Express. `@tus/s3-store` handles S3-compatible multipart upload to MinIO transparently. Tus provides built-in resumability via `PATCH` requests with offset headers.
- **Pros:**
  - Protocol-level resumability — client can pause, resume, or retry any chunk without API-level logic
  - `@tus/s3-store` v2.x handles S3 multipart upload, part splitting, and completion automatically
  - Well-tested with MinIO (community examples exist: `nestjs-tus-server-with-minio`)
  - `@tus/server` v2.x integrates cleanly into Express as middleware
  - Client libraries (`tus-js-client`, Uppy's Tus plugin) handle progress, retry, and resumability out of the box
  - API server memory stays low — `@tus/s3-store` streams parts to S3 using the SDK, not buffering full files
- **Cons:**
  - API acts as a proxy — every byte passes through the NestJS server before reaching MinIO (unlike Option A where client hits MinIO directly)
  - Adds a new protocol dependency (`@tus/server`, `@tus/s3-store`, `@tus/file-store` for metadata) vs. using raw S3 SDK
  - Tus server occupies its own Express routes (`/uploads`), which must be carefully integrated with NestJS routing/middleware
  - Tus metadata is stored locally (memory or file-based) — requires a persistence strategy for upload state
  - More niche ecosystem — fewer NestJS examples compared to `@aws-sdk` patterns
  - `@tus/s3-store` stores metadata as `{id}.info` files on S3, adding small objects alongside video content
  - Nginx/reverse proxy configuration required: request buffering must be disabled for Tus to work correctly
  - Max upload size is 5TiB per Tus spec, but part management and metadata files add S3 object overhead

### Option C: Multipart Upload via API Proxy (Client → API → MinIO)

- Client sends `multipart/form-data` to the NestJS API. API uses Multer (disk or memory storage) to receive the file, then streams or buffers it to MinIO using `@aws-sdk/client-s3` or `@aws-sdk/lib-storage`.
- **Pros:**
  - Simplest implementation — standard NestJS `FileInterceptor` + `@UploadedFile()` pattern
  - No CORS configuration needed on MinIO (API mediates all access)
  - Full control over validation, metadata extraction, and authorization at the API layer before storage
  - Familiar NestJS pattern with abundant documentation and examples
- **Cons:**
  - **Critical memory issue for 10GB files**: NestJS `FileInterceptor` with default `memoryStorage` buffers the entire file into Node.js heap. A single 10GB upload would OOM the server.
  - Even with `diskStorage`, Multer writes the full file to disk before the controller executes — for 10GB this means either massive disk I/O or OOM depending on configuration
  - Streaming via Busboy (bypassing Multer) is possible but fights NestJS's interceptor model — `FileInterceptor` waits for Multer to finish parsing before calling the controller, creating a deadlock for large streams (documented in nestjs/nest#13158)
  - `@aws-sdk/lib-storage` can stream from disk to S3 with multipart, but the file must first land on disk somewhere — doubling storage temporarily
  - API server memory scales linearly with concurrent uploads — not viable for 10GB
  - Upload speed bottleneck: every byte traverses the API network hop twice (client→API, API→MinIO)
  - Timeout risk: Express default timeout is 30s; even with extensions, streaming 10GB through the API requires careful timeout configuration at every layer (Express, Nginx, load balancer)

**Recommendation:** Option A (Presigned Multipart Upload). For 10GB video uploads, Option A is the only architecture where the API server memory stays constant regardless of file size or concurrent uploads. Option B is a viable alternative but adds unnecessary complexity when S3-native multipart already provides resumability at the part level. Option C is fundamentally incompatible with 10GB files in NestJS without significant architectural workarounds. Option A also aligns with the project's Docker/MinIO infrastructure — MinIO supports `CreateMultipartUpload`, `UploadPart`, and `CompleteMultipartUpload` natively, and `@aws-sdk/s3-request-presigner` generates per-part presigned URLs that work with MinIO's S3 API.

**Decision:** _[pending]_

---

## TD-02: Upload Chunk Size

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** With the presigned multipart upload approach (TD-01), the file is split into parts before uploading. The chunk size determines the number of API calls, retry granularity, and memory usage on the client. MinIO allows up to 10,000 parts per multipart upload. For 10GB: 10MB chunks = 1,000 parts (at limit); 25MB chunks = 400 parts; 100MB chunks = 100 parts.

**Options:**

### Option A: 25MB chunks (recommended for 1-5GB range)

- 25MB per part. For 10GB: ~400 parts. Good balance between API call overhead and retry granularity.
- **Pros:** 400 parts is well within limits; each retry re-uploads only 25MB; moderate number of presigned URLs to generate
- **Cons:** 400 presigned URL requests at initiation; slightly more overhead than larger chunks

### Option B: 100MB chunks (optimized for large files)

- 100MB per part. For 10GB: ~100 parts. Minimizes API calls.
- **Pros:** Only 100 presigned URLs; fewer API roundtrips; lower client-side part management overhead
- **Cons:** Each retry re-uploads 100MB; less granular progress reporting; larger memory footprint per part on client

### Option C: Dynamic chunk size based on file size

- Calculate optimal chunk size at upload initiation: <100MB → single upload; 100MB-1GB → 10MB; 1-5GB → 25MB; >5GB → 100MB.
- **Pros:** Optimal for all file sizes; avoids unnecessary multipart overhead for small files
- **Cons:** More complex logic; variable behavior makes debugging harder

**Recommendation:** Option C (dynamic chunk size). The API should calculate the optimal part size based on total file size before generating presigned URLs. This provides the best experience across the range of upload sizes while keeping 10GB uploads efficient at ~100 parts.

**Decision:** _[pending]_

---

## TD-03: Upload Client Library

**Scope:** Frontend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** The frontend (Next.js) needs to implement the upload client that interacts with the presigned multipart API (TD-01). This includes: requesting presigned URLs, uploading parts with progress tracking, retrying failed parts, and calling the completion endpoint. The library choice affects developer experience, bundle size, and feature completeness.

**Options:**

### Option A: Uppy with @uppy/aws-s3-multipart plugin

- Uppy is a modular file uploader. The `@uppy/aws-s3-multipart` plugin handles multipart upload to S3/MinIO using presigned URLs with built-in parallel uploads, progress tracking, and retry.
- **Pros:**
  - Production-tested S3 multipart integration with custom `createMultipartUpload`, `signPart`, `completeMultipartUpload` hooks
  - Built-in progress tracking, pause/resume, retry with exponential backoff
  - Drag-and-drop UI component included
  - Works with any framework (React, vanilla JS)
  - Large community, actively maintained by Transloadit
  - Can be configured to call the NestJS API for URL signing via custom hooks
- **Cons:**
  - Adds ~50-100KB to bundle (tree-shakeable)
  - Opinionated API surface — some customization requires understanding Uppy's plugin architecture

### Option B: Custom fetch-based implementation

- Implement multipart upload logic directly using `fetch` + presigned URLs. Track parts in React state, upload with `Promise.allSettled`, handle retry manually.
- **Pros:**
  - Zero additional dependencies
  - Full control over upload behavior
  - Minimal bundle impact
- **Cons:**
  - Significant implementation effort (part calculation, parallel upload management, retry logic, progress aggregation)
  - Must re-implement everything Uppy provides out of the box
  - Higher risk of bugs in edge cases (network failures, partial completions)

### Option C: tus-js-client (if Tus protocol chosen in TD-01)

- Client for the Tus protocol. Handles resumability, progress, and retry natively.
- **Pros:** Native Tus integration, well-tested resumability
- **Cons:** Only viable if TD-01选择了 Tus (not presigned URLs); different protocol than S3-native multipart

**Recommendation:** Option A (Uppy + @uppy/aws-s3-multipart). The custom hooks map directly to the API endpoints defined in TD-01: `createMultipartUpload` → `POST /uploads/video/initiate`, `signPart` → `POST /uploads/video/sign-part`, `completeMultipartUpload` → `POST /uploads/video/complete`. This provides production-grade upload handling with minimal custom code.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Cross-layer | Upload Protocol | Presigned Multipart Upload (client → MinIO directly, API-orchestrated) | _[pending]_ |
| TD-02 | Backend | Upload Chunk Size | Dynamic chunk size based on file size | _[pending]_ |
| TD-03 | Frontend | Upload Client Library | Uppy + @uppy/aws-s3-multipart | _[pending]_ |

---

## Appendix: Library Version Reference

| Package | Latest Version | MinIO Compatibility | Notes |
|---------|---------------|---------------------|-------|
| `@aws-sdk/client-s3` | ^3.700+ | Full S3 API compatible | MinIO implements S3 API natively |
| `@aws-sdk/s3-request-presigner` | ^3.700+ | Full presigned URL support | `getSignedUrl` for PutObject, UploadPart, etc. |
| `@tus/server` | ^2.4.1 (May 2026) | Via @tus/s3-store | Requires Node.js >=20.19.0 |
| `@tus/s3-store` | ^2.0.1 (Aug 2025) | S3-compatible storage | Configurable `partSize`, `minPartSize`, `maxMultipartParts` |
| `multer` | ^1.4.5-lts.2 | N/A | Used only if Option C chosen (not recommended) |
| Uppy (`@uppy/aws-s3-multipart`) | ^3.x+ | S3-compatible via presigned URLs | Tree-shakeable, React-friendly |

### MinIO Presigned URL Notes

- MinIO supports S3 v4 presigned URLs with configurable expiry (1s to 7d)
- `PutObject` presigned URLs: valid for single-part uploads
- `UploadPart` presigned URLs: valid per-part, longer expiry recommended (1 hour) since large uploads take time
- `CreateMultipartUpload` is an API call (not presigned) — must be called server-side with MinIO credentials
- MinIO requires CORS configuration for browser-direct uploads: `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`
