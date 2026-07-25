import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { VideosService } from './videos.service';
import { Video, VideoStatus } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { S3Service } from './s3.service';
import storageConfig from '../config/storage.config';
import {
  VideoNotFoundException,
  VideoNotReadyException,
  VideoAccessDeniedException,
} from './video.exceptions';

jest.mock('nanoid', () => ({
  customAlphabet: () => () => 'testslug123',
}));

type MockRepo<T extends object> = jest.Mocked<Repository<T>>;

function makeRepo<T extends object>(): MockRepo<T> {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    remove: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
    findBy: jest.fn(),
    findOneBy: jest.fn(),
    findOneOrFail: jest.fn(),
    have: jest.fn(),
    merge: jest.fn(),
    preload: jest.fn(),
    insert: jest.fn(),
    softDelete: jest.fn(),
    recover: jest.fn(),
    query: jest.fn(),
    manager: {} as any,
    metadata: {} as any,
    target: {} as any,
    dataSource: {} as any,
  } as unknown as MockRepo<T>;
}

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepo: MockRepo<Video>;
  let channelRepo: MockRepo<Channel>;
  let s3Service: jest.Mocked<S3Service>;
  let processingQueue: jest.Mocked<Queue>;

  const mockStorageCfg = {
    endpoint: 'http://minio:9000',
    bucket: 'streamtube',
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    region: 'us-east-1',
  };

  beforeEach(async () => {
    videoRepo = makeRepo<Video>();
    channelRepo = makeRepo<Channel>();
    s3Service = {
      createMultipartUpload: jest.fn(),
      getPartPresignedUrl: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
      getDownloadPresignedUrl: jest.fn(),
      getObject: jest.fn(),
      headObject: jest.fn(),
      deleteObject: jest.fn(),
      uploadObject: jest.fn(),
    } as unknown as jest.Mocked<S3Service>;
    processingQueue = {
      add: jest.fn(),
    } as unknown as jest.Mocked<Queue>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepo },
        { provide: getRepositoryToken(Channel), useValue: channelRepo },
        { provide: S3Service, useValue: s3Service },
        {
          provide: getQueueToken('video-processing'),
          useValue: processingQueue,
        },
        { provide: storageConfig.KEY, useValue: mockStorageCfg },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initUpload', () => {
    it('throws VideoAccessDeniedException when channel not found', async () => {
      channelRepo.findOne.mockResolvedValue(null);

      await expect(
        service.initUpload('user-1', {
          title: 'Test',
          fileName: 'video.mp4',
          fileSize: 1000,
          mimeType: 'video/mp4',
        }),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('creates draft video and returns presigned URLs', async () => {
      const channel = { id: 'ch-1', user_id: 'user-1' } as Channel;
      channelRepo.findOne.mockResolvedValue(channel);
      s3Service.createMultipartUpload.mockResolvedValue({
        uploadId: 'upload-1',
        key: 'videos/testslug123/source',
      });
      s3Service.getPartPresignedUrl.mockResolvedValue('http://presigned-url');
      videoRepo.create.mockImplementation((v) => v as Video);
      videoRepo.save.mockImplementation(async (v) => {
        (v as Video).id = 'video-1';
        return v as Video;
      });
      videoRepo.findOne.mockResolvedValue(null);

      const result = await service.initUpload('user-1', {
        title: 'Test Video',
        fileName: 'video.mp4',
        fileSize: 1000,
        mimeType: 'video/mp4',
      });

      expect(result.videoId).toBe('video-1');
      expect(result.uploadId).toBe('upload-1');
      expect(result.presignedUrls).toHaveLength(1);
      expect(result.partSize).toBe(100 * 1024 * 1024);
      expect(result.totalParts).toBe(1);
      expect(result.slug).toBe('testslug123');
    });

    it('calculates multiple parts for large files', async () => {
      const channel = { id: 'ch-1', user_id: 'user-1' } as Channel;
      channelRepo.findOne.mockResolvedValue(channel);
      s3Service.createMultipartUpload.mockResolvedValue({
        uploadId: 'upload-1',
        key: 'videos/testslug123/source',
      });
      s3Service.getPartPresignedUrl.mockResolvedValue('http://presigned-url');
      videoRepo.create.mockImplementation((v) => v as Video);
      videoRepo.save.mockImplementation(async (v) => {
        (v as Video).id = 'video-1';
        return v as Video;
      });
      videoRepo.findOne.mockResolvedValue(null);

      const result = await service.initUpload('user-1', {
        title: 'Large Video',
        fileName: 'large.mp4',
        fileSize: 250 * 1024 * 1024,
        mimeType: 'video/mp4',
      });

      expect(result.totalParts).toBe(3);
      expect(result.presignedUrls).toHaveLength(3);
      expect(s3Service.getPartPresignedUrl).toHaveBeenCalledTimes(3);
    });
  });

  describe('completeUpload', () => {
    it('throws VideoNotFoundException when video not found', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-1', {
          videoId: 'nonexistent',
          uploadId: 'upload-1',
          parts: [{ PartNumber: 1, ETag: 'etag' }],
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoAccessDeniedException when user does not own video', async () => {
      const video = {
        id: 'video-1',
        channel: { user_id: 'other-user' },
        status: VideoStatus.DRAFT,
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      await expect(
        service.completeUpload('user-1', {
          videoId: 'video-1',
          uploadId: 'upload-1',
          parts: [{ PartNumber: 1, ETag: 'etag' }],
        }),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws VideoNotReadyException when video is not in DRAFT status', async () => {
      const video = {
        id: 'video-1',
        channel: { user_id: 'user-1' },
        status: VideoStatus.READY,
        slug: 'test123',
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      await expect(
        service.completeUpload('user-1', {
          videoId: 'video-1',
          uploadId: 'upload-1',
          parts: [{ PartNumber: 1, ETag: 'etag' }],
        }),
      ).rejects.toThrow(VideoNotReadyException);
    });

    it('completes upload, sets PROCESSING status, and enqueues job', async () => {
      const video = {
        id: 'video-1',
        channel: { user_id: 'user-1' },
        status: VideoStatus.DRAFT,
        slug: 'test123',
        storage_key: 'videos/test123/source',
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      videoRepo.save.mockImplementation(async (v) => v as Video);

      const result = await service.completeUpload('user-1', {
        videoId: 'video-1',
        uploadId: 'upload-1',
        parts: [{ PartNumber: 1, ETag: 'etag' }],
      });

      expect(s3Service.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/test123/source',
        'upload-1',
        [{ PartNumber: 1, ETag: 'etag' }],
      );
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(processingQueue.add).toHaveBeenCalledWith('process', {
        videoId: 'video-1',
      });
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });
  });

  describe('cancelUpload', () => {
    it('throws VideoNotFoundException when video not found', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(
        service.cancelUpload('user-1', {
          videoId: 'nonexistent',
          uploadId: 'upload-1',
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoAccessDeniedException when user does not own video', async () => {
      const video = {
        id: 'video-1',
        channel: { user_id: 'other-user' },
        status: VideoStatus.DRAFT,
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      await expect(
        service.cancelUpload('user-1', {
          videoId: 'video-1',
          uploadId: 'upload-1',
        }),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws VideoNotReadyException when video is not DRAFT', async () => {
      const video = {
        id: 'video-1',
        channel: { user_id: 'user-1' },
        status: VideoStatus.PROCESSING,
        slug: 'test123',
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      await expect(
        service.cancelUpload('user-1', {
          videoId: 'video-1',
          uploadId: 'upload-1',
        }),
      ).rejects.toThrow(VideoNotReadyException);
    });

    it('aborts upload and removes video record', async () => {
      const video = {
        id: 'video-1',
        channel: { user_id: 'user-1' },
        status: VideoStatus.DRAFT,
        slug: 'test123',
        storage_key: 'videos/test123/source',
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      videoRepo.remove.mockResolvedValue(video);

      const result = await service.cancelUpload('user-1', {
        videoId: 'video-1',
        uploadId: 'upload-1',
      });

      expect(s3Service.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/test123/source',
        'upload-1',
      );
      expect(videoRepo.remove).toHaveBeenCalledWith(video);
      expect(result.success).toBe(true);
    });
  });

  describe('findBySlug', () => {
    it('throws VideoNotFoundException when slug not found', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(service.findBySlug('nonexistent')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('returns video with channel relation', async () => {
      const video = {
        id: 'video-1',
        slug: 'test123',
        channel: { id: 'ch-1', name: 'test-channel' },
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      const result = await service.findBySlug('test123');
      expect(result.id).toBe('video-1');
      expect(videoRepo.findOne).toHaveBeenCalledWith({
        where: { slug: 'test123' },
        relations: ['channel'],
      });
    });
  });

  describe('findById', () => {
    it('throws VideoNotFoundException when id not found', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('returns video by id', async () => {
      const video = { id: 'video-1', slug: 'test123' } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      const result = await service.findById('video-1');
      expect(result.id).toBe('video-1');
    });
  });

  describe('getStreamUrl', () => {
    it('throws VideoNotReadyException when video is not READY', async () => {
      const video = {
        id: 'video-1',
        slug: 'test123',
        status: VideoStatus.DRAFT,
        channel: {},
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      await expect(service.getStreamUrl('test123')).rejects.toThrow(
        VideoNotReadyException,
      );
    });

    it('returns presigned URL and content type for READY video', async () => {
      const video = {
        id: 'video-1',
        slug: 'test123',
        status: VideoStatus.READY,
        storage_key: 'videos/test123/source',
        mime_type: 'video/mp4',
        channel: {},
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      s3Service.getDownloadPresignedUrl.mockResolvedValue(
        'http://presigned-stream',
      );

      const result = await service.getStreamUrl('test123');
      expect(result.url).toBe('http://presigned-stream');
      expect(result.contentType).toBe('video/mp4');
    });

    it('defaults contentType to video/mp4 when mime_type is null', async () => {
      const video = {
        id: 'video-1',
        slug: 'test123',
        status: VideoStatus.READY,
        storage_key: 'videos/test123/source',
        mime_type: null,
        channel: {},
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      s3Service.getDownloadPresignedUrl.mockResolvedValue(
        'http://presigned-stream',
      );

      const result = await service.getStreamUrl('test123');
      expect(result.contentType).toBe('video/mp4');
    });
  });

  describe('getDownloadUrl', () => {
    it('throws VideoNotReadyException when video is not READY', async () => {
      const video = {
        id: 'video-1',
        slug: 'test123',
        status: VideoStatus.PROCESSING,
        channel: {},
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      await expect(service.getDownloadUrl('test123')).rejects.toThrow(
        VideoNotReadyException,
      );
    });

    it('returns presigned URL and fileName', async () => {
      const video = {
        id: 'video-1',
        slug: 'test123',
        status: VideoStatus.READY,
        storage_key: 'videos/test123/source',
        original_filename: 'my-video.mp4',
        channel: {},
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      s3Service.getDownloadPresignedUrl.mockResolvedValue(
        'http://presigned-download',
      );

      const result = await service.getDownloadUrl('test123');
      expect(result.url).toBe('http://presigned-download');
      expect(result.fileName).toBe('my-video.mp4');
    });

    it('defaults fileName to slug.mp4 when original_filename is null', async () => {
      const video = {
        id: 'video-1',
        slug: 'test123',
        status: VideoStatus.READY,
        storage_key: 'videos/test123/source',
        original_filename: null,
        channel: {},
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      s3Service.getDownloadPresignedUrl.mockResolvedValue(
        'http://presigned-download',
      );

      const result = await service.getDownloadUrl('test123');
      expect(result.fileName).toBe('test123.mp4');
    });
  });

  describe('getThumbnailUrl', () => {
    it('returns null when no thumbnail key exists', async () => {
      const video = {
        id: 'video-1',
        slug: 'test123',
        thumbnail_storage_key: null,
        channel: {},
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      const result = await service.getThumbnailUrl('test123');
      expect(result).toBeNull();
    });

    it('returns presigned URL for thumbnail', async () => {
      const video = {
        id: 'video-1',
        slug: 'test123',
        thumbnail_storage_key: 'videos/test123/thumb.jpg',
        channel: {},
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      s3Service.getDownloadPresignedUrl.mockResolvedValue(
        'http://presigned-thumb',
      );

      const result = await service.getThumbnailUrl('test123');
      expect(result).toBe('http://presigned-thumb');
    });
  });

  describe('getVideoMetadata', () => {
    it('returns video metadata with channel info', async () => {
      const video = {
        id: 'video-1',
        title: 'Test Video',
        description: 'A test',
        slug: 'test123',
        duration: 120,
        status: VideoStatus.READY,
        thumbnail_storage_key: 'videos/test123/thumb.jpg',
        created_at: new Date('2024-01-01'),
        channel: { name: 'Test Channel', nickname: 'testch' },
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      s3Service.getDownloadPresignedUrl.mockResolvedValue(
        'http://presigned-thumb',
      );

      const result = await service.getVideoMetadata('test123');
      expect(result.id).toBe('video-1');
      expect(result.title).toBe('Test Video');
      expect(result.channel.name).toBe('Test Channel');
      expect(result.thumbnailUrl).toBe('http://presigned-thumb');
    });

    it('returns null thumbnailUrl when no thumbnail', async () => {
      const video = {
        id: 'video-1',
        title: 'Test',
        slug: 'test123',
        thumbnail_storage_key: null,
        created_at: new Date(),
        channel: { name: 'Ch', nickname: 'ch' },
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);

      const result = await service.getVideoMetadata('test123');
      expect(result.thumbnailUrl).toBeNull();
    });
  });

  describe('listByChannel', () => {
    const createMockQb = () => {
      const qb: Record<string, jest.Mock> = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getMany: jest.fn().mockResolvedValue([]),
      };
      return qb;
    };

    it('throws VideoNotFoundException when channel not found', async () => {
      channelRepo.findOne.mockResolvedValue(null);

      await expect(
        service.listByChannel('nonexistent', { page: 1, limit: 20 }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('filters by READY status for non-owner viewers', async () => {
      const channel = { id: 'ch-1', user_id: 'owner-id' } as Channel;
      channelRepo.findOne.mockResolvedValue(channel);
      const qb = createMockQb();
      videoRepo.createQueryBuilder.mockReturnValue(qb as any);

      await service.listByChannel('testch', {
        page: 1,
        limit: 20,
        viewerUserId: 'other-user',
      });

      expect(qb.andWhere).toHaveBeenCalledWith('video.status = :status', {
        status: VideoStatus.READY,
      });
    });

    it('does not filter by status for owner viewing own channel', async () => {
      const channel = { id: 'ch-1', user_id: 'owner-id' } as Channel;
      channelRepo.findOne.mockResolvedValue(channel);
      const qb = createMockQb();
      videoRepo.createQueryBuilder.mockReturnValue(qb as any);

      await service.listByChannel('testch', {
        page: 1,
        limit: 20,
        viewerUserId: 'owner-id',
      });

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'video.status = :status',
        expect.anything(),
      );
    });

    it('filters by specific status when owner provides status filter', async () => {
      const channel = { id: 'ch-1', user_id: 'owner-id' } as Channel;
      channelRepo.findOne.mockResolvedValue(channel);
      const qb = createMockQb();
      videoRepo.createQueryBuilder.mockReturnValue(qb as any);

      await service.listByChannel('testch', {
        page: 1,
        limit: 20,
        status: VideoStatus.DRAFT,
        viewerUserId: 'owner-id',
      });

      expect(qb.andWhere).toHaveBeenCalledWith('video.status = :status', {
        status: VideoStatus.DRAFT,
      });
    });

    it('returns paginated results', async () => {
      const channel = { id: 'ch-1', user_id: 'owner-id' } as Channel;
      channelRepo.findOne.mockResolvedValue(channel);
      const video = { id: 'video-1', slug: 'test123' } as Video;
      const qb = createMockQb();
      qb.getCount.mockResolvedValue(1);
      qb.getMany.mockResolvedValue([video]);
      videoRepo.createQueryBuilder.mockReturnValue(qb as any);

      const result = await service.listByChannel('testch', {
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);
      expect(result.meta.totalPages).toBe(1);
    });
  });

  describe('updateVideoStatus', () => {
    it('throws VideoNotFoundException when video not found', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateVideoStatus('nonexistent', VideoStatus.READY),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('updates status and metadata', async () => {
      const video = {
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        duration: null,
        thumbnail_storage_key: null,
        processing_error: null,
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      videoRepo.save.mockImplementation(async (v) => v as Video);

      await service.updateVideoStatus('video-1', VideoStatus.READY, {
        duration: 120,
        thumbnailStorageKey: 'videos/test123/thumb.jpg',
      });

      expect(video.status).toBe(VideoStatus.READY);
      expect(video.duration).toBe(120);
      expect(video.thumbnail_storage_key).toBe('videos/test123/thumb.jpg');
      expect(videoRepo.save).toHaveBeenCalledWith(video);
    });

    it('updates to ERROR status with processing error', async () => {
      const video = {
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        processing_error: null,
      } as Video;
      videoRepo.findOne.mockResolvedValue(video);
      videoRepo.save.mockImplementation(async (v) => v as Video);

      await service.updateVideoStatus('video-1', VideoStatus.ERROR, {
        processingError: 'FFmpeg failed',
      });

      expect(video.status).toBe(VideoStatus.ERROR);
      expect(video.processing_error).toBe('FFmpeg failed');
    });
  });
});
