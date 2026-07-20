import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VideosService } from './videos.service';
import { VideosController } from './videos.controller';
import { S3Service } from './s3.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
  controllers: [VideosController],
  providers: [VideosService, S3Service],
  exports: [VideosService],
})
export class VideosModule {}
