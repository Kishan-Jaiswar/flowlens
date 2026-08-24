import { useState } from 'react';
import { api } from '../api/client';
import { PatientForm } from '../components/PatientForm';

interface Patient {
  _id: string;
  name: string;
  phone: string;
}

export default function PatientsPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [query, setQuery] = useState('');

  const handleSearch = async () => {
    const response = await api.get(`/api/patients?search=${query}`);
    setPatients(response.data);
  };

  const handleDelete = async (id: string) => {
    await api.delete(`/api/patients/${id}`);
    await handleSearch();
  };

  /**
   * Intentional bug for the demo: the backend exposes PATCH for archiving,
   * this calls PUT. `flowlens doctor` reports it as a method mismatch.
   */
  const handleArchive = async (id: string) => {
    await api.put(`/api/patients/${id}/archive`, { archived: true });
  };

  return (
    <main>
      <input value={query} onChange={(event) => setQuery(event.target.value)} />
      <button onClick={handleSearch}>Search</button>

      <PatientForm />

      <ul>
        {patients.map((patient) => (
          <li key={patient._id}>
            {patient.name}
            <button onClick={() => handleDelete(patient._id)}>Delete</button>
            <button onClick={() => handleArchive(patient._id)}>Archive</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
