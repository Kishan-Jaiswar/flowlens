import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  @Length(2, 80)
  name: string;

  @IsString()
  @Length(10, 15)
  phone: string;

  @IsInt()
  @Min(0)
  age: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
