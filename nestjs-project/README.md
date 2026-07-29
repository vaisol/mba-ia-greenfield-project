# StreamTube — API (NestJS 11)

Backend da plataforma de compartilhamento de vídeos StreamTube.

## Stack

- **Runtime:** Node.js (Docker)
- **Framework:** NestJS 11 com Express
- **ORM:** TypeORM 0.3 + PostgreSQL 17
- **Auth:** JWT (access + refresh token rotation) + Argon2id
- **Queue:** BullMQ (Redis) para processamento de vídeos
- **Storage:** MinIO/S3 (presigned multipart upload)
- **Email:** @nestjs-modules/mailer + Mailpit (dev)

## Estrutura

```
src/
├── auth/        # Cadastro, login, JWT, refresh, reset de senha
├── channels/    # Canal 1:1 por usuário
├── users/       # Entidade e serviço de usuários
├── videos/      # Upload, processamento, streaming
├── mail/        # Envio de e-mails (Handlebars)
├── common/      # Filtros, pipes e exceptions de domínio
├── config/      # Configs namespaced (Joi)
└── database/    # Data-source, migrations e seeds
```

## Comandos

Todos os comandos rodam **dentro do container**:

```bash
docker compose exec nestjs-api npm run start:dev   # Dev server (watch)
docker compose exec nestjs-api npm test             # Unit + integration
docker compose exec nestjs-api npm run test:e2e     # E2E (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov     # Cobertura
docker compose exec nestjs-api npx tsc --noEmit     # Type-check
docker compose exec nestjs-api npm run lint         # ESLint
```

## Configuração do Jest (ESM)

O `nanoid` v6 é ESM-only. O `jest-e2e.json` usa `transformIgnorePatterns` para que o `ts-jest` o transpile automaticamente:

```json
"transformIgnorePatterns": ["/node_modules/(?!nanoid)/"]
```

Isso afeta apenas os testes e2e; os testes unitários usam `jest.mock('nanoid', ...)`.
