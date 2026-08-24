import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PrescriptionDocument = Prescription & Document;

@Schema({ timestamps: true })
export class Prescription {
  @Prop({ required: true, index: true })
  patientId: Types.ObjectId;

  @Prop({ type: [Object], default: [] })
  medicines: Array<{ medicineId: string; dosage: string }>;

  @Prop()
  diagnosis: string;

  @Prop()
  advice: string;

  @Prop()
  followUpDays: number;
}

export const PrescriptionSchema = SchemaFactory.createForClass(Prescription);
