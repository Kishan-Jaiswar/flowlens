import { IsArray, IsInt, IsOptional, IsString } from 'class-validator';

export class CreatePrescriptionDto {
  @IsString()
  patientId: string;

  @IsArray()
  medicines: Array<{ medicineId: string; dosage: string }>;

  @IsString()
  diagnosis: string;

  @IsOptional()
  @IsString()
  advice?: string;

  @IsOptional()
  @IsInt()
  followUpDays?: number;
}
