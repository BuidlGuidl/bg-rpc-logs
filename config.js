const logPort = 3001;
const parseInterval = 10000; // 10 seconds in milliseconds
const poolNodeTimingParseInterval = 60 * 1000 * 10; // 10 minutes = 60 seconds * 1000 ms * 10
const maxLogEntries = 40000;
const maxRequestHistoryHours = 24 * 30; // Maximum number of hourly history entries to keep (30 days)
const maxTimingEntriesPerNode = 10000; // Cap per-node duration arrays to prevent unbounded growth
const maxParamsChars = 1000; // Longest params kept per request/node entry; the logs page only displays them

module.exports = {
  logPort,
  parseInterval,
  poolNodeTimingParseInterval,
  maxLogEntries,
  maxRequestHistoryHours,
  maxTimingEntriesPerNode,
  maxParamsChars
};