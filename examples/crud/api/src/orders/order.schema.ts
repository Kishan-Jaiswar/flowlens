import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrderDocument = Order & Document;

@Schema({ timestamps: true })
export class Order {
  @Prop({ required: true, index: true })
  customerId: Types.ObjectId;

  @Prop({ type: [Object], default: [] })
  products: Array<{ productId: string; quantity: string }>;

  @Prop()
  note: string;

  @Prop()
  couponCode: string;

  @Prop()
  deliveryDays: number;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
