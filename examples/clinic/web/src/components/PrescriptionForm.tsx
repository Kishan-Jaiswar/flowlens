import { useState } from 'react';
import { api } from '../api/client';

interface Medicine {
  medicineId: string;
  dosage: string;
}

export function PrescriptionForm({ patientId }: { patientId: string }) {
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [diagnosis, setDiagnosis] = useState('');
  const [advice, setAdvice] = useState('');
  const [followUpDays, setFollowUpDays] = useState(7);

  const handleSubmit = async () => {
    await api.post('/api/prescriptions', {
      patientId,
      medicines,
      diagnosis,
      advice,
      followUpDays,
    });
    setMedicines([]);
    setDiagnosis('');
  };

  const handlePrint = async () => {
    const response = await api.get(`/api/prescriptions/${patientId}/latest`);
    window.print();
    return response.data;
  };

  return (
    <div>
      <textarea value={diagnosis} onChange={(event) => setDiagnosis(event.target.value)} />
      <textarea value={advice} onChange={(event) => setAdvice(event.target.value)} />
      <input
        type="number"
        value={followUpDays}
        onChange={(event) => setFollowUpDays(Number(event.target.value))}
      />
      <button onClick={handleSubmit}>Submit Prescription</button>
      <button onClick={handlePrint}>Print Prescription</button>
    </div>
  );
}
