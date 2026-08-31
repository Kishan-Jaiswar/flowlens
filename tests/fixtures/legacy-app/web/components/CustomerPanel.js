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
  getCustomersList,
  createShipment,
  getShopSettings,
  getStats,
} from "../misc/apiEndPoints";

export function CustomerPanel({ shopId }) {
  const [customers, setCustomers] = useState([]);
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState([]);

  const handleLoadCustomers = async () => {
    const response = await getRequest({ url: getCustomersList, auth: true });
    setCustomers(response.data);
  };

  // params extends the *path*, so this is a different route.
  const handleLoadOne = async (id) => {
    const response = await getRequest({
      url: getCustomersList,
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

  const handleBookShipment = async () => {
    await postRequest({
      url: createShipment,
      body: { shopId, notes },
      auth: true,
    });
    setNotes("");
  };

  const handleUpdateNotes = async (id) => {
    await patchRequestNoLoader({
      url: getCustomersList,
      params: `/${id}`,
      body: { notes },
      auth: true,
    });
  };

  const handleLoadSettings = async () => {
    return getRequestV3({ url: getShopSettings, auth: true });
  };

  // Ordinary functions that merely start with get/delete.
  const handleRestore = () => {
    const cached = getState("customers");
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

      <button onClick={handleLoadCustomers}>Load Customers</button>
      <button onClick={handleBookShipment}>Book Shipment</button>
      <button onClick={() => handleUpdateNotes(customers[0]?._id)}>Save Notes</button>
      <button onClick={() => handleLoadOne(customers[0]?._id)}>Open</button>
      <button onClick={handleRestore}>Restore</button>
    </div>
  );
}
