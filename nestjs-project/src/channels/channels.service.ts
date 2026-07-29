import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { appendRandomSuffix, sanitizeNickname } from './nickname.util';
import { Channel } from './entities/channel.entity';

const PG_UNIQUE_VIOLATION = '23505';
const NICKNAME_COLUMN = 'nickname';
const MAX_RETRIES = 5;

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverErr = err.driverError as {
    code?: string;
    detail?: string;
  };
  return (
    driverErr?.code === PG_UNIQUE_VIOLATION &&
    typeof driverErr?.detail === 'string' &&
    driverErr.detail.includes(column)
  );
}

@Injectable()
export class ChannelsService {
  constructor(private readonly dataSource: DataSource) {}

  async createChannel(userId: string, email: string): Promise<Channel> {
    const baseNickname = sanitizeNickname(email.split('@')[0]);
    const repository = this.dataSource.getRepository(Channel);

    let nickname = baseNickname;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const existing = await repository.findOne({
        where: { nickname },
      });
      if (existing) {
        nickname = appendRandomSuffix(baseNickname);
        continue;
      }

      try {
        return await repository.save(
          repository.create({
            name: baseNickname,
            nickname,
            user_id: userId,
          }),
        );
      } catch (err) {
        if (isPgUniqueViolationOnColumn(err, NICKNAME_COLUMN)) {
          nickname = appendRandomSuffix(baseNickname);
        } else {
          throw err;
        }
      }
    }

    throw new Error(
      'Nickname conflict could not be resolved after max retries',
    );
  }
}
