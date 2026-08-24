import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MedicineDocument = Medicine & Document;

@Schema()
export class Medicine {
  @Prop({ required: true, index: true })
  brand: string;

  @Prop()
  composition: string;

  @Prop({ default: 0 })
  stock: number;

  @Prop()
  expiryDate: Date;
}

export const MedicineSchema = SchemaFactory.createForClass(Medicine);
