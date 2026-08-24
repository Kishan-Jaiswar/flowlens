import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClinicSettings, ClinicSettingsDocument } from './clinic-settings.schema';
import { PharmaStockMap, PharmaStockMapDocument } from './pharma-stock-map.schema';

@Injectable()
export class ClinicService {
  constructor(
    @InjectModel(ClinicSettings.name)
    private readonly settingsModel: Model<ClinicSettingsDocument>,
    @InjectModel(PharmaStockMap.name)
    private readonly stockMapModel: Model<PharmaStockMapDocument>,
  ) {}

  async settings() {
    const settings = await this.settingsModel.findOne().lean();
    const maps = await this.stockMapModel.find().lean();
    return { settings, maps };
  }
}
