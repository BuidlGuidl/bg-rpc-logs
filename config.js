const logPort = 3001;
const parseInterval = 10000; // 10 seconds in milliseconds
const maxLogEntries = 40000;
const maxRequestHistoryHours = 24 * 30; // Maximum number of hourly history entries to keep (30 days)
const maxTimingEntriesPerNode = 10000; // Cap per-node duration arrays to prevent unbounded growth
const maxParamsChars = 1000; // Longest params kept per request/node entry; the logs page only displays them
const maxDashboardAgeMs = 60 * 1000; // Rebuild the dashboard at least this often even when no log changed
const defaultPageLimit = 30; // Entries per page when a paged request (?page=) gives no limit
const maxPageLimit = 1000; // Most entries one paged request may ask for

module.exports = {
  logPort,
  parseInterval,
  maxLogEntries,
  maxRequestHistoryHours,
  maxTimingEntriesPerNode,
  maxParamsChars,
  maxDashboardAgeMs,
  defaultPageLimit,
  maxPageLimit
};