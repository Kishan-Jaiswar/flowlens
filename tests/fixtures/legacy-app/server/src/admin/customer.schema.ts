import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CustomerDocument = Customer & Document;

@Schema({ timestamps: true })
export class Customer {
  @Prop()
  name: string;

  @Prop()
  notes: string;

  @Prop({ default: false })
  archived: boolean;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);
