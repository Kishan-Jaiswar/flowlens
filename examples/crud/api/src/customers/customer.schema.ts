import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CustomerDocument = Customer & Document;

@Schema({ timestamps: true })
export class Customer {
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

export const CustomerSchema = SchemaFactory.createForClass(Customer);
