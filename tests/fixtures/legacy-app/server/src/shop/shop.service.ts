import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ShopSettings, ShopSettingsDocument } from './shop-settings.schema';
import { StockMap, StockMapDocument } from './stock-map.schema';

@Injectable()
export class ShopService {
  constructor(
    @InjectModel(ShopSettings.name)
    private readonly settingsModel: Model<ShopSettingsDocument>,
    @InjectModel(StockMap.name)
    private readonly stockMapModel: Model<StockMapDocument>,
  ) {}

  async settings() {
    const settings = await this.settingsModel.findOne().lean();
    const maps = await this.stockMapModel.find().lean();
    return { settings, maps };
  }
}
