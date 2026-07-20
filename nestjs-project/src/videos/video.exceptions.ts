import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor(identifier: string) {
    super('VIDEO_NOT_FOUND', 404, `Video not found: ${identifier}`);
  }
}

export class VideoNotReadyException extends DomainException {
  constructor(slug: string) {
    super('VIDEO_NOT_READY', 400, `Video is not ready for playback: ${slug}`);
  }
}

export class VideoAccessDeniedException extends DomainException {
  constructor() {
    super('VIDEO_ACCESS_DENIED', 403, 'You do not have access to this video');
  }
}

export class VideoUploadInitFailedException extends DomainException {
  constructor(message: string) {
    super(
      'VIDEO_UPLOAD_INIT_FAILED',
      500,
      `Failed to initialize upload: ${message}`,
    );
  }
}

export class VideoProcessingFailedException extends DomainException {
  constructor(videoId: string, message: string) {
    super(
      'VIDEO_PROCESSING_FAILED',
      500,
      `Video processing failed for ${videoId}: ${message}`,
    );
  }
}
