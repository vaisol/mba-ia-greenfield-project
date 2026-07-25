import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { VideosService } from './videos.service';
import { Video, VideoStatus } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { S3Service } from './s3.service';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import redisConfig from '../config/redis.config';
import {
  VideoNotFoundException,
  VideoAccessDeniedException,
} from './video.exceptions';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService (integration)', () => {
  let service: VideosService;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let processingQueue: Queue;

  const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
  const TEST_CHANNEL_ID = '00000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, redisConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video, Channel]),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'localhost',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        BullModule.registerQueue({ name: 'video-processing' }),
      ],
      providers: [VideosService, S3Service],
    }).compile();

    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    videoRepo = dataSource.getRepository(Video);
    processingQueue = module.get<Queue>(getQueueToken('video-processing'));
  }, 30000);

  afterAll(async () => {
    await processingQueue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "users"');

    await dataSource.query(
      `INSERT INTO "users" (id, email, password, is_confirmed)
       VALUES ($1, 'test@example.com', 'hashed', true)`,
      [TEST_USER_ID],
    );
    await dataSource.query(
      `INSERT INTO "channels" (id, name, nickname, user_id)
       VALUES ($1, 'Test Channel', 'testch', $2)`,
      [TEST_CHANNEL_ID, TEST_USER_ID],
    );
  });

  describe('findBySlug', () => {
    it('throws VideoNotFoundException for non-existent slug', async () => {
      await expect(service.findBySlug('nonexistent')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('finds video by slug with channel relation', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'testslug', 'videos/test/source', 'ready')`,
        ['video-1', TEST_CHANNEL_ID],
      );

      const video = await service.findBySlug('testslug');
      expect(video.id).toBe('video-1');
      expect(video.channel).toBeDefined();
      expect(video.channel.name).toBe('Test Channel');
    });
  });

  describe('findById', () => {
    it('throws VideoNotFoundException for non-existent id', async () => {
      await expect(service.findById('nonexistent')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('finds video by id', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'testslug2', 'videos/test2/source', 'draft')`,
        ['video-2', TEST_CHANNEL_ID],
      );

      const video = await service.findById('video-2');
      expect(video.id).toBe('video-2');
    });
  });

  describe('listByChannel', () => {
    it('throws VideoNotFoundException for non-existent channel', async () => {
      await expect(
        service.listByChannel('nonexistent', { page: 1, limit: 10 }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('returns only READY videos for non-owner viewers', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES
           ($1, $2, 'Ready', 'ready1', 'v/ready1', 'ready'),
           ($3, $2, 'Draft', 'draft1', 'v/draft1', 'draft')`,
        ['v-r1', TEST_CHANNEL_ID, 'v-d1'],
      );

      const result = await service.listByChannel('testch', {
        page: 1,
        limit: 10,
        viewerUserId: 'other-user',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].slug).toBe('ready1');
    });

    it('returns all videos for the channel owner', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES
           ($1, $2, 'Ready', 'ready2', 'v/ready2', 'ready'),
           ($3, $2, 'Draft', 'draft2', 'v/draft2', 'draft')`,
        ['v-r2', TEST_CHANNEL_ID, 'v-d2'],
      );

      const result = await service.listByChannel('testch', {
        page: 1,
        limit: 10,
        viewerUserId: TEST_USER_ID,
      });

      expect(result.data).toHaveLength(2);
    });

    it('paginates results correctly', async () => {
      const inserts = Array.from({ length: 5 }, (_, i) =>
        dataSource.query(
          `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
           VALUES ($1, $2, 'Video', $3, $4, 'ready')`,
          [`v-pag-${i}`, TEST_CHANNEL_ID, `slug-pag-${i}`, `v/slug-pag-${i}`],
        ),
      );
      await Promise.all(inserts);

      const page1 = await service.listByChannel('testch', {
        page: 1,
        limit: 2,
      });
      expect(page1.data).toHaveLength(2);
      expect(page1.meta.total).toBe(5);
      expect(page1.meta.totalPages).toBe(3);

      const page3 = await service.listByChannel('testch', {
        page: 3,
        limit: 2,
      });
      expect(page3.data).toHaveLength(1);
    });
  });

  describe('updateVideoStatus', () => {
    it('throws VideoNotFoundException for non-existent video', async () => {
      await expect(
        service.updateVideoStatus('nonexistent', VideoStatus.READY),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('updates video status in the database', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'upslug', 'v/upslug', 'processing')`,
        ['v-up1', TEST_CHANNEL_ID],
      );

      await service.updateVideoStatus('v-up1', VideoStatus.READY, {
        duration: 120,
        thumbnailStorageKey: 'v/upslug/thumb.jpg',
      });

      const video = await videoRepo.findOneBy({ id: 'v-up1' });
      expect(video!.status).toBe(VideoStatus.READY);
      expect(video!.duration).toBe(120);
      expect(video!.thumbnail_storage_key).toBe('v/upslug/thumb.jpg');
    });

    it('sets processing_error when status is ERROR', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'errslug', 'v/errslug', 'processing')`,
        ['v-err1', TEST_CHANNEL_ID],
      );

      await service.updateVideoStatus('v-err1', VideoStatus.ERROR, {
        processingError: 'FFmpeg crashed',
      });

      const video = await videoRepo.findOneBy({ id: 'v-err1' });
      expect(video!.status).toBe(VideoStatus.ERROR);
      expect(video!.processing_error).toBe('FFmpeg crashed');
    });
  });

  describe('completeUpload', () => {
    it('throws VideoNotFoundException for non-existent video', async () => {
      await expect(
        service.completeUpload(TEST_USER_ID, {
          videoId: 'nonexistent',
          uploadId: 'upload-1',
          parts: [{ PartNumber: 1, ETag: 'etag' }],
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoAccessDeniedException when user does not own video', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'ownslug', 'v/ownslug', 'draft')`,
        ['v-own1', TEST_CHANNEL_ID],
      );

      await expect(
        service.completeUpload('wrong-user-id', {
          videoId: 'v-own1',
          uploadId: 'upload-1',
          parts: [{ PartNumber: 1, ETag: 'etag' }],
        }),
      ).rejects.toThrow(VideoAccessDeniedException);
    });
  });

  describe('cancelUpload', () => {
    it('throws VideoNotFoundException for non-existent video', async () => {
      await expect(
        service.cancelUpload(TEST_USER_ID, {
          videoId: 'nonexistent',
          uploadId: 'upload-1',
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('removes draft video from database', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'canslug', 'v/canslug', 'draft')`,
        ['v-can1', TEST_CHANNEL_ID],
      );

      const result = await service.cancelUpload(TEST_USER_ID, {
        videoId: 'v-can1',
        uploadId: 'upload-1',
      });

      expect(result.success).toBe(true);
      const video = await videoRepo.findOneBy({ id: 'v-can1' });
      expect(video).toBeNull();
    });
  });
});
