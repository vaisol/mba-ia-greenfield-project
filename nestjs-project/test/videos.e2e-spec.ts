import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let authService: AuthService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    authService = moduleFixture.get(AuthService);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token;
  }

  describe('GET /videos/channel/:nickname', () => {
    it('returns 404 for non-existent channel', async () => {
      await request(app.getHttpServer())
        .get('/videos/channel/nonexistent')
        .expect(404);
    });

    it('returns empty list for channel with no videos', async () => {
      const accessToken = await registerConfirmAndLogin('ch1@example.com');
      const meRes = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);
      const nickname = meRes.body.email.split('@')[0];

      const res = await request(app.getHttpServer())
        .get(`/videos/channel/${nickname}`)
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });
  });

  describe('GET /videos/:slug', () => {
    it('returns 404 for non-existent slug', async () => {
      await request(app.getHttpServer()).get('/videos/nonexistent').expect(404);
    });
  });

  describe('GET /videos/:slug/stream', () => {
    it('returns 404 for non-existent slug', async () => {
      await request(app.getHttpServer())
        .get('/videos/nonexistent/stream')
        .expect(404);
    });
  });

  describe('GET /videos/:slug/download', () => {
    it('returns 404 for non-existent slug', async () => {
      await request(app.getHttpServer())
        .get('/videos/nonexistent/download')
        .expect(404);
    });
  });

  describe('GET /videos/:slug/thumbnail', () => {
    it('returns 404 for non-existent slug', async () => {
      await request(app.getHttpServer())
        .get('/videos/nonexistent/thumbnail')
        .expect(404);
    });
  });

  describe('POST /videos/upload/init', () => {
    it('returns 401 without auth token', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload/init')
        .send({
          title: 'Test',
          fileName: 'test.mp4',
          fileSize: 1000,
          mimeType: 'video/mp4',
        })
        .expect(401);
    });

    it('returns 400 with VALIDATION_ERROR on missing fields', async () => {
      const accessToken = await registerConfirmAndLogin('valid@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/upload/init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 with VALIDATION_ERROR on invalid fileSize', async () => {
      const accessToken = await registerConfirmAndLogin('invalid@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/upload/init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Test',
          fileName: 'test.mp4',
          fileSize: -1,
          mimeType: 'video/mp4',
        })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 403 when user has no channel', async () => {
      const accessToken = await registerConfirmAndLogin(
        'nochannel@example.com',
      );

      await request(app.getHttpServer())
        .post('/videos/upload/init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Test',
          fileName: 'test.mp4',
          fileSize: 1000,
          mimeType: 'video/mp4',
        })
        .expect(403);
    });
  });

  describe('POST /videos/upload/complete', () => {
    it('returns 401 without auth token', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload/complete')
        .send({ videoId: 'v1', uploadId: 'u1', parts: [] })
        .expect(401);
    });
  });

  describe('POST /videos/upload/cancel', () => {
    it('returns 401 without auth token', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload/cancel')
        .send({ videoId: 'v1', uploadId: 'u1' })
        .expect(401);
    });
  });
});
