import { api } from '../api/client';

export interface CreatePatientInput {
  name: string;
  phone: string;
  age: number;
  notes: string;
}

export function useCreatePatient() {
  const createPatient = async (input: CreatePatientInput) => {
    const response = await api.post('/api/patients', {
      name: input.name,
      phone: input.phone,
      age: input.age,
      notes: input.notes,
    });
    return response.data;
  };

  return { createPatient };
}
