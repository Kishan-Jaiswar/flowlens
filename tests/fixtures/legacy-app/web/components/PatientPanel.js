import { useState } from "react";
import {
  getRequest,
  postRequest,
  patchRequestNoLoader,
  getRequestV3,
  getState,
  deleteRow,
} from "../misc/axiosConfig";
import {
  getPatientsList,
  createAppointment,
  getClinicSettings,
  getStats,
} from "../misc/apiEndPoints";

export function PatientPanel({ clinicId }) {
  const [patients, setPatients] = useState([]);
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState([]);

  const handleLoadPatients = async () => {
    const response = await getRequest({ url: getPatientsList, auth: true });
    setPatients(response.data);
  };

  // params extends the *path*, so this is a different route.
  const handleLoadOne = async (id) => {
    const response = await getRequest({
      url: getPatientsList,
      params: `/${id}`,
      auth: true,
    });
    return response.data;
  };

  // params is only a query string — same route.
  const handleDownloadReport = async () => {
    const response = await getRequest({
      url: getStats,
      params: `?from=2026-01-01`,
      auth: true,
    });
    return response.data;
  };

  const handleBookAppointment = async () => {
    await postRequest({
      url: createAppointment,
      body: { clinicId, notes },
      auth: true,
    });
    setNotes("");
  };

  const handleUpdateNotes = async (id) => {
    await patchRequestNoLoader({
      url: getPatientsList,
      params: `/${id}`,
      body: { notes },
      auth: true,
    });
  };

  const handleLoadSettings = async () => {
    return getRequestV3({ url: getClinicSettings, auth: true });
  };

  // Ordinary functions that merely start with get/delete.
  const handleRestore = () => {
    const cached = getState("patients");
    setRows(deleteRow(rows, 0));
    return cached;
  };

  return (
    <div>
      {/* An icon with a click handler and no text of its own. */}
      <IoDownload onClick={handleDownloadReport} className="text-xl" />

      {/* A wrapper div labelled by the text inside it. */}
      <div onClick={handleLoadSettings}>
        <p>Preview</p>
      </div>

      <button onClick={handleLoadPatients}>Load Patients</button>
      <button onClick={handleBookAppointment}>Book Appointment</button>
      <button onClick={() => handleUpdateNotes(patients[0]?._id)}>Save Notes</button>
      <button onClick={() => handleLoadOne(patients[0]?._id)}>Open</button>
      <button onClick={handleRestore}>Restore</button>
    </div>
  );
}
