import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ShopSettingsDocument = ShopSettings & Document;

/**
 * An already-plural model name. Mongoose names this collection
 * `shopsettings`, not `shopsettingses`.
 */
@Schema()
export class ShopSettings {
  @Prop()
  shopId: string;

  @Prop()
  labContacts: string[];
}

export const ShopSettingsSchema = SchemaFactory.createForClass(ShopSettings);
