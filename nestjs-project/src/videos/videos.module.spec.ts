import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { VideosModule } from './videos.module';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import redisConfig from '../config/redis.config';

jest.mock('nanoid', () => ({
  customAlphabet: () => () => 'testslug123',
}));

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosModule', () => {
  it('should compile with TypeOrmModule.forFeature([Video, Channel]) and BullModule.registerQueue', async () => {
    const ds = createTestDataSource(ALL_ENTITIES);
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, redisConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
