import { Module } from '@nestjs/common';
import { AuditService } from './common/audit.service';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';
import { ImportsController } from './imports/imports.controller';
import { ImportsService } from './imports/imports.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';

/**
 * The root module `main.ts` boots. Nest finds every controller and service
 * through it, and so does `flowlens unused`: without this file nothing in the
 * backend is reachable from the entry point, and all of it reads as dead.
 */
@Module({
  controllers: [CustomersController, ImportsController, OrdersController, ProductsController],
  providers: [AuditService, CustomersService, ImportsService, OrdersService, ProductsService],
})
export class AppModule {}
