---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-20T10:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-20T10:00:00-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-05-12T12:21:12-03:00"
  docs/phases/phase-02-auth/context.md: "2026-05-12T13:36:17-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Videos

**Capabilities**

- Serviço de armazenamento de arquivos (videos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de videos com suporte a arquivos de ate 10GB sem impacto na performance
- Pre-cadastro automatico do video como rascunho ao iniciar o upload
- Processamento automatico do video apos upload (extracao de duracao e metadados)
- Geracao automatica de thumbnail a partir de um frame do video
- URL unica por video, sem conflito com outros
- Reproducao via streaming (sem necessidade de download completo)
- Download do video pelo usuario

**Out of scope:** Edicao de videos, gerenciamento de canais, comentarios, likes, interfaces de upload/player (frontend), categorias de video.

**Deliverables:** upload de ate 10GB funcional, processamento automatico do video, streaming funcionando, URLs unicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — upload UI, player, and management screens deferred to a future phase.

**Sequencing notes:** Depends on Fase 01 — Configuracao Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta.

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Videos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Queue Technology | decided | A (BullMQ + @nestjs/bullmq with Redis) | @nestjs/bullmq@^11.x, bullmq@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy (10GB) | decided | A (Presigned Multipart Upload — client → MinIO directly) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Configuration | decided | A (Single bucket streamtube with path-based key prefix) | @aws-sdk/client-s3@^3.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Processing Worker | decided | A (Separate NestJS container with BullMQ Worker + FFmpeg via child_process) | (FFmpeg via Docker base image) |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | B (nanoid with custom 11-char alphabet using A-Za-z0-9_-) | nanoid@^5.x |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Video Streaming/Download | decided | C (Hybrid — API generates presigned GET URLs for streaming/download) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Servico de armazenamento de arquivos (videos e thumbnails) | phase-03-videos/TD-03 |
| Servico de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de videos com suporte a arquivos de ate 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pre-cadastro automatico do video como rascunho ao iniciar o upload | phase-03-videos/TD-02 (presigned init creates draft) |
| Processamento automatico do video apos upload (extracao de duracao e metadados) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Geracao automatica de thumbnail a partir de um frame do video | phase-03-videos/TD-04 |
| URL unica por video, sem conflito com outros | phase-03-videos/TD-05 |
| Reproducao via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do video pelo usuario | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + @nestjs/bullmq — The official NestJS integration is decisive. BullMQ's feature set (retries, concurrency, flow orchestration) matches the video processing pipeline requirements. Redis is a minimal infrastructure addition.

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`

### phase-03-videos/TD-02

**Recommendation:** Presigned Multipart Upload — The only strategy that keeps the API server free from file content. For 10GB videos, this is a hard architectural requirement. The 3-step handshake (init → upload → complete) is well-documented.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Single bucket with path prefix — For a development/local setup, a single bucket with path-based keys is sufficient and simplest. The key structure (videos/{video-id}/source.mp4, videos/{video-id}/thumbnail.jpg) provides clear organization.

**Libraries:** `@aws-sdk/client-s3@^3.x`

### phase-03-videos/TD-04

**Recommendation:** Separate NestJS container with BullMQ Worker — Keeps the worker within the NestJS ecosystem, reusing config, entities, and DI. FFmpeg dependency handled by Docker base image. Worker and API share the same codebase but run different modules.

**Libraries:** (FFmpeg via Docker base image, no additional npm packages beyond BullMQ)

### phase-03-videos/TD-05

**Recommendation:** nanoid with 11-char custom alphabet — YouTube-length slugs (11 chars) are the proven pattern for video sharing platforms. 66 bits of entropy is sufficient. The nanoid library is tiny, dependency-free, and widely trusted.

**Libraries:** `nanoid@^5.x`

### phase-03-videos/TD-06

**Recommendation:** Hybrid presigned URLs — Provides authentication and access control at the API layer while keeping video bandwidth off the API server. Presigned URL with short expiry limits exposure. MinIO's native Range request support handles streaming.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

## Inherited Decisions Detail

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended choice. Native build dependency is a one-time Docker setup cost.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with @nestjs/jwt only — Fewer dependencies, full control over auth flow.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation — Strongest security model with automatic theft detection. PostgreSQL already in stack.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** @nestjs-modules/mailer — Best NestJS integration. Supports SMTP, works with Mailpit for dev.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — First-class NestJS integration. Decorators co-located with DTO.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — Machine-readable error codes. Simple { statusCode, error, message } format.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** @nestjs/throttler — Native NestJS integration. Guard-based rate limiting.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-01-configuracao-base/TD-01

**Recommendation:** @nestjs/config — Official, core-team-maintained. registerAs() factory pattern.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi — First-class integration with @nestjs/config.

**Libraries:** `joi@^17.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables validated by Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- Config injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Domain exceptions: `DomainException` abstract base class with `errorCode` + `httpStatus`. Concrete subclasses for each error. _(from phase 02)_
- UUID primary keys, explicit table names, timestamps, `select: false` for sensitive fields. _(from phase 01/02)_
- Thin controllers with `@ApiTags`, `@ApiOperation`, `@ApiResponse` decorators. Services throw domain exceptions. _(from phase 02)_
- `@Public()` decorator for unauthenticated endpoints. Global `JwtAuthGuard` via `APP_GUARD`. _(from phase 02)_
- Test suffixes: `*.spec.ts` (unit), `*.integration-spec.ts` (integration with real DB), `*.e2e-spec.ts` (E2E via supertest). _(from phase 02)_
- All commands run inside Docker container: `docker compose exec nestjs-api <command>`. _(from CLAUDE.md)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| Telas de upload, player e gerenciamento de videos | deferred | `next-frontend/` not initialized in this phase; UI surfaces start in a later phase. | — |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Unit test (*.spec.ts) | Service logic, utilities, processors — all external deps mocked |
| Integration test (*.integration-spec.ts) | Real DB (TypeORM repositories), real modules with DI, real BullMQ queues |
| E2E test (*.e2e-spec.ts) | Full HTTP cycle via supertest, global guards, exception filters |

Testing guide available: `testing-guide-nestjs-project`
