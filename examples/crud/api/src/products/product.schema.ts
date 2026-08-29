import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema()
export class Product {
  @Prop({ required: true, index: true })
  brand: string;

  @Prop()
  composition: string;

  @Prop({ default: 0 })
  stock: number;

  @Prop()
  expiryDate: Date;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
