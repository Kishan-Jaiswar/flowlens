import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Patient, PatientDocument } from './patient.schema';

@Injectable()
export class DoctorService {
  constructor(
    @InjectModel(Patient.name) private readonly patientModel: Model<PatientDocument>,
  ) {}

  async listPatients() {
    return this.patientModel.find({ archived: false }).limit(50).lean();
  }

  async findPatient(id: string) {
    return this.patientModel.findById(id).lean();
  }

  async updateNotes(id: string, notes: string) {
    return this.patientModel.findByIdAndUpdate(id, { notes });
  }
}
