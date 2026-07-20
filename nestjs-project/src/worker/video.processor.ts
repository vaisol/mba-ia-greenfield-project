import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { VideosService } from '../videos/videos.service';
import { S3Service } from '../videos/s3.service';
import { VideoStatus } from '../videos/entities/video.entity';

const execFileAsync = promisify(execFile);

interface VideoJobData {
  videoId: string;
}

@Processor('video-processing', {
  concurrency: 1,
})
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly s3Service: S3Service,
  ) {
    super();
  }

  async process(job: Job<VideoJobData>): Promise<void> {
    const { videoId } = job.data;
    this.logger.log(`Processing video ${videoId}`);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-'));
    const sourcePath = path.join(tempDir, 'source');
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');

    try {
      const video = await this.videosService.findById(videoId);
      if (!video) {
        throw new Error(`Video ${videoId} not found`);
      }

      const sourceBuffer = await this.s3Service.getObject(video.storage_key);
      await fs.writeFile(sourcePath, sourceBuffer);

      const metadata = await this.extractMetadata(sourcePath);
      await this.generateThumbnail(
        sourcePath,
        thumbnailPath,
        metadata.duration,
      );

      const thumbKey = `videos/${video.slug}/thumbnail.jpg`;
      const thumbBuffer = await fs.readFile(thumbnailPath);
      await this.s3Service.uploadObject(thumbKey, thumbBuffer, 'image/jpeg');

      await this.videosService.updateVideoStatus(videoId, VideoStatus.READY, {
        duration: metadata.duration,
        thumbnailStorageKey: thumbKey,
      });

      this.logger.log(`Video ${videoId} processed successfully`);
    } catch (error) {
      this.logger.error(`Video processing failed for ${videoId}: ${error}`);
      await this.videosService.updateVideoStatus(videoId, VideoStatus.ERROR, {
        processingError:
          error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async extractMetadata(
    filePath: string,
  ): Promise<{ duration: number }> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      filePath,
    ]);

    const probe = JSON.parse(stdout) as { format?: { duration?: string } };
    const duration = parseFloat(probe.format?.duration ?? '0') || 0;

    return { duration: Math.floor(duration) };
  }

  private async generateThumbnail(
    sourcePath: string,
    outputPath: string,
    duration: number,
  ): Promise<void> {
    const seekTime = duration > 0 ? Math.floor(duration * 0.25) : 0;

    await execFileAsync('ffmpeg', [
      '-ss',
      String(seekTime),
      '-i',
      sourcePath,
      '-vframes',
      '1',
      '-vf',
      'scale=1280:-2',
      '-y',
      outputPath,
    ]);
  }
}
