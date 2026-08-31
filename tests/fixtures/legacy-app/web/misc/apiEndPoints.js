// Endpoint constants, the way real frontends keep them: one module, one
// exported string per route, referenced by name at every call site.
export const getCustomersList = "/api/admin/customers";
export const createShipment = "/api/shipments";
export const getShopSettings = "/api/shop/settings";
export const getStats = "/api/stats";

// A constant built from another constant in the same module.
const CUSTOMERS_BASE = "/api/admin/customers";
export const getCustomerById = `${CUSTOMERS_BASE}`;

// Declared twice with different values elsewhere — must not be guessed.
export const duplicated = "/api/one";
