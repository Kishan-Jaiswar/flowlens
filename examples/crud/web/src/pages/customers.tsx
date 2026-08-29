import { useState } from 'react';
import { api } from '../api/client';
import { CustomerForm } from '../components/CustomerForm';

interface Customer {
  _id: string;
  name: string;
  phone: string;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState('');

  const handleSearch = async () => {
    const response = await api.get(`/api/customers?search=${query}`);
    setCustomers(response.data);
  };

  const handleDelete = async (id: string) => {
    await api.delete(`/api/customers/${id}`);
    await handleSearch();
  };

  /**
   * Intentional bug for the demo: the backend exposes PATCH for archiving,
   * this calls PUT. `flowlens doctor` reports it as a method mismatch.
   */
  const handleArchive = async (id: string) => {
    await api.put(`/api/customers/${id}/archive`, { archived: true });
  };

  return (
    <main>
      <input value={query} onChange={(event) => setQuery(event.target.value)} />
      <button onClick={handleSearch}>Search</button>

      <CustomerForm />

      <ul>
        {customers.map((customer) => (
          <li key={customer._id}>
            {customer.name}
            <button onClick={() => handleDelete(customer._id)}>Delete</button>
            <button onClick={() => handleArchive(customer._id)}>Archive</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
