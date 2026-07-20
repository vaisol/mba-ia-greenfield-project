import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { customAlphabet } from 'nanoid';
import { Video, VideoStatus } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { S3Service } from './s3.service';
import storageConfig from '../config/storage.config';
import {
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './video.exceptions';
import { InitUploadDto } from './dto/init-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CancelUploadDto } from './dto/cancel-upload.dto';

const nanoid = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
  11,
);

const PART_SIZE = 100 * 1024 * 1024; // 100MB per part

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly s3Service: S3Service,
    @InjectQueue('video-processing')
    private readonly processingQueue: Queue,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async initUpload(
    userId: string,
    dto: InitUploadDto,
  ): Promise<{
    videoId: string;
    uploadId: string;
    presignedUrls: { partNumber: number; url: string }[];
    partSize: number;
    totalParts: number;
    slug: string;
  }> {
    const channel = await this.channelRepository.findOne({
      where: { user_id: userId },
    });
    if (!channel) {
      throw new VideoAccessDeniedException();
    }

    const slug = await this.generateUniqueSlug();
    const storageKey = `videos/${slug}/source`;

    const { uploadId } = await this.s3Service.createMultipartUpload(
      storageKey,
      dto.mimeType,
    );

    const totalParts = Math.ceil(dto.fileSize / PART_SIZE);
    const presignedUrls: { partNumber: number; url: string }[] = [];

    for (let i = 1; i <= totalParts; i++) {
      const url = await this.s3Service.getPartPresignedUrl(
        storageKey,
        uploadId,
        i,
      );
      presignedUrls.push({ partNumber: i, url });
    }

    const video = this.videoRepository.create({
      channel_id: channel.id,
      title: dto.title,
      slug,
      storage_key: storageKey,
      status: VideoStatus.DRAFT,
      file_size: dto.fileSize,
      mime_type: dto.mimeType,
      original_filename: dto.fileName,
    });

    await this.videoRepository.save(video);

    return {
      videoId: video.id,
      uploadId,
      presignedUrls,
      partSize: PART_SIZE,
      totalParts,
      slug,
    };
  }

  async completeUpload(
    userId: string,
    dto: CompleteUploadDto,
  ): Promise<{ id: string; status: VideoStatus; slug: string }> {
    const video = await this.videoRepository.findOne({
      where: { id: dto.videoId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException(dto.videoId);
    }

    if (video.channel.user_id !== userId) {
      throw new VideoAccessDeniedException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotReadyException(video.slug);
    }

    await this.s3Service.completeMultipartUpload(
      video.storage_key,
      dto.uploadId,
      dto.parts,
    );

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    await this.processingQueue.add('process', {
      videoId: video.id,
    });

    return { id: video.id, status: video.status, slug: video.slug };
  }

  async cancelUpload(
    userId: string,
    dto: CancelUploadDto,
  ): Promise<{ success: boolean }> {
    const video = await this.videoRepository.findOne({
      where: { id: dto.videoId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException(dto.videoId);
    }

    if (video.channel.user_id !== userId) {
      throw new VideoAccessDeniedException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotReadyException(video.slug);
    }

    await this.s3Service.abortMultipartUpload(video.storage_key, dto.uploadId);

    await this.videoRepository.remove(video);

    return { success: true };
  }

  async findBySlug(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException(slug);
    }

    return video;
  }

  async findById(id: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException(id);
    }

    return video;
  }

  async getStreamUrl(
    slug: string,
  ): Promise<{ url: string; contentType: string }> {
    const video = await this.findBySlug(slug);

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException(slug);
    }

    const url = await this.s3Service.getDownloadPresignedUrl(
      video.storage_key,
      3600,
    );

    return { url, contentType: video.mime_type || 'video/mp4' };
  }

  async getDownloadUrl(
    slug: string,
  ): Promise<{ url: string; fileName: string }> {
    const video = await this.findBySlug(slug);

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException(slug);
    }

    const url = await this.s3Service.getDownloadPresignedUrl(
      video.storage_key,
      3600,
    );

    const fileName = video.original_filename || `${slug}.mp4`;

    return { url, fileName };
  }

  async getThumbnailUrl(slug: string): Promise<string | null> {
    const video = await this.findBySlug(slug);

    if (!video.thumbnail_storage_key) {
      return null;
    }

    return this.s3Service.getDownloadPresignedUrl(
      video.thumbnail_storage_key,
      3600,
    );
  }

  async getVideoMetadata(slug: string) {
    const video = await this.findBySlug(slug);

    const thumbnailUrl = video.thumbnail_storage_key
      ? await this.s3Service.getDownloadPresignedUrl(
          video.thumbnail_storage_key,
          3600,
        )
      : null;

    return {
      id: video.id,
      title: video.title,
      description: video.description,
      slug: video.slug,
      duration: video.duration,
      status: video.status,
      channel: {
        name: video.channel.name,
        nickname: video.channel.nickname,
      },
      thumbnailUrl,
      createdAt: video.created_at,
    };
  }

  async listByChannel(
    channelNickname: string,
    options: {
      page: number;
      limit: number;
      status?: VideoStatus;
      viewerUserId?: string;
    },
  ) {
    const channel = await this.channelRepository.findOne({
      where: { nickname: channelNickname },
    });

    if (!channel) {
      throw new VideoNotFoundException(channelNickname);
    }

    const qb = this.videoRepository
      .createQueryBuilder('video')
      .where('video.channel_id = :channelId', { channelId: channel.id });

    const isOwner = options.viewerUserId === channel.user_id;

    if (!isOwner) {
      qb.andWhere('video.status = :status', { status: VideoStatus.READY });
    } else if (options.status) {
      qb.andWhere('video.status = :status', { status: options.status });
    }

    qb.orderBy('video.created_at', 'DESC');

    const total = await qb.getCount();
    const videos = await qb
      .skip((options.page - 1) * options.limit)
      .take(options.limit)
      .getMany();

    return {
      data: videos,
      meta: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages: Math.ceil(total / options.limit),
      },
    };
  }

  async updateVideoStatus(
    videoId: string,
    status: VideoStatus,
    metadata?: {
      duration?: number;
      thumbnailStorageKey?: string;
      processingError?: string;
    },
  ): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      throw new VideoNotFoundException(videoId);
    }

    video.status = status;
    if (metadata?.duration !== undefined) {
      video.duration = metadata.duration;
    }
    if (metadata?.thumbnailStorageKey !== undefined) {
      video.thumbnail_storage_key = metadata.thumbnailStorageKey;
    }
    if (metadata?.processingError !== undefined) {
      video.processing_error = metadata.processingError;
    }

    await this.videoRepository.save(video);
  }

  private async generateUniqueSlug(): Promise<string> {
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
      const slug = nanoid();
      const existing = await this.videoRepository.findOne({
        where: { slug },
      });
      if (!existing) {
        return slug;
      }
    }
    throw new Error('Failed to generate unique slug after retries');
  }
}
