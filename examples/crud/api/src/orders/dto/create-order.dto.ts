import { IsArray, IsInt, IsOptional, IsString } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  customerId: string;

  @IsArray()
  products: Array<{ productId: string; quantity: string }>;

  @IsString()
  note: string;

  @IsOptional()
  @IsString()
  couponCode?: string;

  @IsOptional()
  @IsInt()
  deliveryDays?: number;
}
