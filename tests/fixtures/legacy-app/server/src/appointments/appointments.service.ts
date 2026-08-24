import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Appointment, AppointmentDocument } from './appointment.schema';

@Injectable()
export class AppointmentsService {
  constructor(
    @InjectModel(Appointment.name)
    private readonly appointmentModel: Model<AppointmentDocument>,
  ) {}

  async create(input: { clinicId: string; notes: string }) {
    return this.appointmentModel.create({
      clinicId: input.clinicId,
      notes: input.notes,
    });
  }

  async stats(from: string) {
    return this.appointmentModel.countDocuments({ createdAt: { $gte: from } });
  }
}
