import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditService } from '../common/audit.service';
import { Patient, PatientDocument } from '../patients/patient.schema';

/**
 * Bulk import writes straight to `patients`, bypassing PatientsService.
 *
 * This is the coupling `flowlens doctor` is built to surface: two services
 * writing the same collection means a change to the patient shape has to be
 * made in two places, and nothing in either file says so.
 */
@Injectable()
export class ImportsService {
  constructor(
    @InjectModel(Patient.name) private readonly patientModel: Model<PatientDocument>,
    private readonly auditService: AuditService,
  ) {}

  async importPatients(rows: Array<{ name: string; phone: string; age: number }>) {
    await this.patientModel.insertMany(
      rows.map((row) => ({ name: row.name, phone: row.phone, age: row.age })),
    );
    await this.auditService.record('patients.imported', rows.length);
    return { imported: rows.length };
  }
}
