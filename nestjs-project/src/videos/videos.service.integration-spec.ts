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
  let s3Service: S3Service;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let processingQueue: Queue;

  const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
  const TEST_CHANNEL_ID = '00000000-0000-0000-0000-000000000002';
  const NONEXISTENT_VIDEO_ID = '00000000-0000-0000-0000-00000000dead';

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
    s3Service = module.get(S3Service);
    dataSource = module.get(DataSource);
    videoRepo = dataSource.getRepository(Video);
    processingQueue = module.get<Queue>(getQueueToken('video-processing'));

    await module.init();
  }, 30000);

  afterAll(async () => {
    await processingQueue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "refresh_tokens"');
    await dataSource.query('DELETE FROM "verification_tokens"');
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
        ['00000000-0000-0000-0000-000000000101', TEST_CHANNEL_ID],
      );

      const video = await service.findBySlug('testslug');
      expect(video.id).toBe('00000000-0000-0000-0000-000000000101');
      expect(video.channel).toBeDefined();
      expect(video.channel.name).toBe('Test Channel');
    });
  });

  describe('findById', () => {
    it('throws VideoNotFoundException for non-existent id', async () => {
      await expect(service.findById(NONEXISTENT_VIDEO_ID)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('finds video by id', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'testslug2', 'videos/test2/source', 'draft')`,
        ['00000000-0000-0000-0000-000000000102', TEST_CHANNEL_ID],
      );

      const video = await service.findById(
        '00000000-0000-0000-0000-000000000102',
      );
      expect(video.id).toBe('00000000-0000-0000-0000-000000000102');
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
        [
          '00000000-0000-0000-0000-000000000103',
          TEST_CHANNEL_ID,
          '00000000-0000-0000-0000-000000000104',
        ],
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
        [
          '00000000-0000-0000-0000-000000000105',
          TEST_CHANNEL_ID,
          '00000000-0000-0000-0000-000000000106',
        ],
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
          [
            `00000000-0000-0000-0000-0000000001${String(10 + i)}`,
            TEST_CHANNEL_ID,
            `slug-pag-${i}`,
            `v/slug-pag-${i}`,
          ],
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
        service.updateVideoStatus(NONEXISTENT_VIDEO_ID, VideoStatus.READY),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('updates video status in the database', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'upslug', 'v/upslug', 'processing')`,
        ['00000000-0000-0000-0000-000000000120', TEST_CHANNEL_ID],
      );

      await service.updateVideoStatus(
        '00000000-0000-0000-0000-000000000120',
        VideoStatus.READY,
        {
          duration: 120,
          thumbnailStorageKey: 'v/upslug/thumb.jpg',
        },
      );

      const video = await videoRepo.findOneBy({
        id: '00000000-0000-0000-0000-000000000120',
      });
      expect(video!.status).toBe(VideoStatus.READY);
      expect(video!.duration).toBe(120);
      expect(video!.thumbnail_storage_key).toBe('v/upslug/thumb.jpg');
    });

    it('sets processing_error when status is ERROR', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'errslug', 'v/errslug', 'processing')`,
        ['00000000-0000-0000-0000-000000000121', TEST_CHANNEL_ID],
      );

      await service.updateVideoStatus(
        '00000000-0000-0000-0000-000000000121',
        VideoStatus.ERROR,
        {
          processingError: 'FFmpeg crashed',
        },
      );

      const video = await videoRepo.findOneBy({
        id: '00000000-0000-0000-0000-000000000121',
      });
      expect(video!.status).toBe(VideoStatus.ERROR);
      expect(video!.processing_error).toBe('FFmpeg crashed');
    });
  });

  describe('completeUpload', () => {
    it('throws VideoNotFoundException for non-existent video', async () => {
      await expect(
        service.completeUpload(TEST_USER_ID, {
          videoId: NONEXISTENT_VIDEO_ID,
          uploadId: 'upload-1',
          parts: [{ PartNumber: 1, ETag: 'etag' }],
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoAccessDeniedException when user does not own video', async () => {
      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'ownslug', 'v/ownslug', 'draft')`,
        ['00000000-0000-0000-0000-000000000122', TEST_CHANNEL_ID],
      );

      await expect(
        service.completeUpload('wrong-user-id', {
          videoId: '00000000-0000-0000-0000-000000000122',
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
          videoId: NONEXISTENT_VIDEO_ID,
          uploadId: 'upload-1',
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('removes draft video from database', async () => {
      const { uploadId } = await s3Service.createMultipartUpload(
        'v/canslug',
        'video/mp4',
      );

      await dataSource.query(
        `INSERT INTO "videos" (id, channel_id, title, slug, storage_key, status)
         VALUES ($1, $2, 'Test', 'canslug', 'v/canslug', 'draft')`,
        ['00000000-0000-0000-0000-000000000123', TEST_CHANNEL_ID],
      );

      const result = await service.cancelUpload(TEST_USER_ID, {
        videoId: '00000000-0000-0000-0000-000000000123',
        uploadId,
      });

      expect(result.success).toBe(true);
      const video = await videoRepo.findOneBy({
        id: '00000000-0000-0000-0000-000000000123',
      });
      expect(video).toBeNull();
    });
  });
});
