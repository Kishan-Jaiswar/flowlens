import axios from 'axios';

// This is a frontend HTTP client that happens to live in a folder called api/.
// The old path heuristic skipped this file and lost every call in it.
export async function fetchPatients() {
  const response = await axios.get('/api/patients');
  return response.data;
}

export async function archivePatient(id: string) {
  return axios.patch(`/api/patients/${id}/archive`, { archived: true });
}
