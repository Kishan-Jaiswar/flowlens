import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ShipmentDocument = Shipment & Document;

@Schema({ timestamps: true })
export class Shipment {
  @Prop()
  shopId: string;

  @Prop()
  notes: string;
}

export const ShipmentSchema = SchemaFactory.createForClass(Shipment);
