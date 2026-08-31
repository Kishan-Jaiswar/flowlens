import { api } from '../api/client';

export interface CreateCustomerInput {
  name: string;
  phone: string;
  age: number;
  notes: string;
}

export function useCreateCustomer() {
  const createCustomer = async (input: CreateCustomerInput) => {
    const response = await api.post('/api/customers', {
      name: input.name,
      phone: input.phone,
      age: input.age,
      notes: input.notes,
    });
    return response.data;
  };

  return { createCustomer };
}
