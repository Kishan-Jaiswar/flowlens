import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AuditLogDocument = AuditLog & Document;

@Schema()
export class AuditLog {
  @Prop({ required: true })
  action: string;

  @Prop()
  subjectId: string;

  @Prop()
  at: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
