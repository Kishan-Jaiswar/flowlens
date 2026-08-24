import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ClinicSettingsDocument = ClinicSettings & Document;

/**
 * An already-plural model name. Mongoose names this collection
 * `clinicsettings`, not `clinicsettingses`.
 */
@Schema()
export class ClinicSettings {
  @Prop()
  clinicId: string;

  @Prop()
  labContacts: string[];
}

export const ClinicSettingsSchema = SchemaFactory.createForClass(ClinicSettings);
