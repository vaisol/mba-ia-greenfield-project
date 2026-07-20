import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideosService } from './videos.service';
import { InitUploadDto } from './dto/init-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CancelUploadDto } from './dto/cancel-upload.dto';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('upload/init')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initialize video upload',
    description:
      'Creates a draft video record and returns presigned URLs for multipart upload directly to object storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initialized with presigned URLs',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitUploadDto,
  ) {
    return this.videosService.initUpload(user.sub, dto);
  }

  @Post('upload/complete')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete video upload',
    description:
      'Finalizes the multipart upload, updates the video status to processing, and enqueues a background job for metadata extraction and thumbnail generation.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, video is now processing',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or video not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'User does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.videosService.completeUpload(user.sub, dto);
  }

  @Post('upload/cancel')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Cancel video upload',
    description:
      'Aborts the multipart upload on object storage and deletes the draft video record.',
  })
  @ApiResponse({ status: 201, description: 'Upload cancelled successfully' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or video not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'User does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CancelUploadDto,
  ) {
    return this.videosService.cancelUpload(user.sub, dto);
  }

  @Public()
  @Get('channel/:nickname')
  @ApiOperation({
    summary: 'List videos by channel',
    description:
      'Returns a paginated list of videos for a specific channel. Anonymous users see only ready videos.',
  })
  @ApiParam({ name: 'nickname', description: 'Channel nickname' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated video list' })
  @ApiResponse({
    status: 404,
    description: 'Channel not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listByChannel(
    @Param('nickname') nickname: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.videosService.listByChannel(nickname, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      viewerUserId: user?.sub,
    });
  }

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Returns metadata for a ready video by its unique slug. Anonymous users can access this endpoint.',
  })
  @ApiParam({ name: 'slug', description: 'Video unique slug (11 chars)' })
  @ApiResponse({ status: 200, description: 'Video metadata' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideoMetadata(@Param('slug') slug: string) {
    return this.videosService.getVideoMetadata(slug);
  }

  @Public()
  @Get(':slug/thumbnail')
  @ApiOperation({
    summary: 'Get video thumbnail URL',
    description:
      'Returns a presigned URL for the video thumbnail generated from the video.',
  })
  @ApiParam({ name: 'slug', description: 'Video unique slug (11 chars)' })
  @ApiResponse({ status: 200, description: 'Thumbnail URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getThumbnailUrl(@Param('slug') slug: string) {
    const url = await this.videosService.getThumbnailUrl(slug);
    return { url };
  }

  @Public()
  @Get(':slug/stream')
  @ApiOperation({
    summary: 'Get video streaming URL',
    description:
      'Returns a presigned URL for streaming the video directly from object storage. Supports HTTP Range requests.',
  })
  @ApiParam({ name: 'slug', description: 'Video unique slug (11 chars)' })
  @ApiResponse({ status: 200, description: 'Streaming URL and content type' })
  @ApiResponse({
    status: 400,
    description: 'Video is not ready for streaming',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStreamUrl(@Param('slug') slug: string) {
    return this.videosService.getStreamUrl(slug);
  }

  @Public()
  @Get(':slug/download')
  @ApiOperation({
    summary: 'Get video download URL',
    description:
      'Returns a presigned URL for downloading the video file from object storage.',
  })
  @ApiParam({ name: 'slug', description: 'Video unique slug (11 chars)' })
  @ApiResponse({ status: 200, description: 'Download URL and file name' })
  @ApiResponse({
    status: 400,
    description: 'Video is not ready for download',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(@Param('slug') slug: string) {
    return this.videosService.getDownloadUrl(slug);
  }
}
