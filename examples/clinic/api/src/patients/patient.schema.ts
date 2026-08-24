import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PatientDocument = Patient & Document;

@Schema({ timestamps: true })
export class Patient {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, index: true })
  phone: string;

  @Prop()
  age: number;

  @Prop()
  notes: string;

  @Prop({ default: false })
  archived: boolean;
}

export const PatientSchema = SchemaFactory.createForClass(Patient);
