import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditService } from '../common/audit.service';
import { MedicinesService } from '../medicines/medicines.service';
import { PatientsService } from '../patients/patients.service';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';
import { Prescription, PrescriptionDocument } from './prescription.schema';

@Injectable()
export class PrescriptionsService {
  constructor(
    @InjectModel(Prescription.name)
    private readonly prescriptionModel: Model<PrescriptionDocument>,
    private readonly patientsService: PatientsService,
    private readonly medicinesService: MedicinesService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * The flagship flow of the example: one click touches four collections
   * across three services.
   */
  async create(dto: CreatePrescriptionDto) {
    await this.patientsService.findById(dto.patientId);
    await this.medicinesService.assertAvailable(dto.medicines.map((item) => item.medicineId));

    const prescription = await this.prescriptionModel.create({
      patientId: dto.patientId,
      medicines: dto.medicines,
      diagnosis: dto.diagnosis,
      advice: dto.advice,
      followUpDays: dto.followUpDays,
    });

    await this.auditService.record('prescription.created', prescription._id);
    return prescription;
  }

  async latestForPatient(patientId: string) {
    return this.prescriptionModel.findOne({ patientId }).sort({ createdAt: -1 }).lean();
  }
}
