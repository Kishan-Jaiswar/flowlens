import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PharmaStockMapDocument = PharmaStockMap & Document;

/** An explicit collection name must win over the derived one. */
@Schema({ collection: 'pharma_stock_maps' })
export class PharmaStockMap {
  @Prop()
  medicineId: string;

  @Prop()
  stock: number;
}

export const PharmaStockMapSchema = SchemaFactory.createForClass(PharmaStockMap);
