import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StockMapDocument = StockMap & Document;

/** An explicit collection name must win over the derived one. */
@Schema({ collection: 'stock_maps' })
export class StockMap {
  @Prop()
  productId: string;

  @Prop()
  stock: number;
}

export const StockMapSchema = SchemaFactory.createForClass(StockMap);
