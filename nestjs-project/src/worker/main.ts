import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const logger = new Logger('VideoWorker');

  await NestFactory.createApplicationContext(WorkerModule);
  logger.log('Video worker started and listening for jobs');
}

bootstrap().catch((err) => {
  console.error('Video worker failed to start:', err);
  process.exit(1);
});
