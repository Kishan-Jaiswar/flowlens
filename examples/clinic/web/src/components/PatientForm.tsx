import { useState } from 'react';
import { useCreatePatient } from '../hooks/useCreatePatient';

export function PatientForm() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [age, setAge] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const { createPatient } = useCreatePatient();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    await createPatient({ name, phone, age, notes });
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit}>
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Full name" />
      <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Phone" />
      <input
        type="number"
        value={age}
        onChange={(event) => setAge(Number(event.target.value))}
        placeholder="Age"
      />
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" />
      <button type="submit" disabled={saving}>
        Create Patient
      </button>
    </form>
  );
}
