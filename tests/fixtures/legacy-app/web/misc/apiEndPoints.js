// Endpoint constants, the way real frontends keep them: one module, one
// exported string per route, referenced by name at every call site.
export const getPatientsList = "/api/doctor/patients";
export const createAppointment = "/api/appointments";
export const getClinicSettings = "/api/clinic/settings";
export const getStats = "/api/stats";

// A constant built from another constant in the same module.
const PATIENTS_BASE = "/api/doctor/patients";
export const getPatientById = `${PATIENTS_BASE}`;

// Declared twice with different values elsewhere — must not be guessed.
export const duplicated = "/api/one";
