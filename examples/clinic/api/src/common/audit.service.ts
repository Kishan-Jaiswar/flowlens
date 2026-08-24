import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLog, AuditLogDocument } from './audit-log.schema';

/**
 * Written to by several services — FlowLens flags `auditlogs` as a shared
 * write, which is exactly the kind of coupling that surprises people.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditLog.name) private readonly auditLogModel: Model<AuditLogDocument>,
  ) {}

  async record(action: string, subjectId: unknown) {
    await this.auditLogModel.create({
      action,
      subjectId: String(subjectId),
      at: new Date(),
    });
  }

  async recent(limit = 20) {
    return this.auditLogModel.find().sort({ at: -1 }).limit(limit).lean();
  }
}
