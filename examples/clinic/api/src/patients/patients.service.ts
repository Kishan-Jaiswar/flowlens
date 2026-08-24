import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditService } from '../common/audit.service';
import { CreatePatientDto } from './dto/create-patient.dto';
import { Patient, PatientDocument } from './patient.schema';

@Injectable()
export class PatientsService {
  constructor(
    @InjectModel(Patient.name) private readonly patientModel: Model<PatientDocument>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreatePatientDto) {
    const patient = await this.patientModel.create({
      name: dto.name,
      phone: dto.phone,
      age: dto.age,
      notes: dto.notes,
    });
    await this.auditService.record('patient.created', patient._id);
    return patient;
  }

  async search(query: string) {
    return this.patientModel
      .find({ name: { $regex: query, $options: 'i' }, archived: false })
      .limit(50)
      .lean();
  }

  async findById(id: string) {
    const patient = await this.patientModel.findById(id).lean();
    if (!patient) throw new NotFoundException('patient not found');
    return patient;
  }

  async archive(id: string) {
    await this.patientModel.findByIdAndUpdate(id, { archived: true });
    await this.auditService.record('patient.archived', id);
  }

  async remove(id: string) {
    await this.patientModel.deleteOne({ _id: id });
    await this.auditService.record('patient.deleted', id);
  }
}
