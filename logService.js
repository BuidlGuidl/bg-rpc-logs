const path = require('path');

const { getMapContents } = require('./utils/dataTransformers');
const {
    parseLogFile,
    parsePoolNodesLog,
    parsePoolCompareResultsLog
} = require('./utils/logParsers');
const {
    updateRequestHistory,
    getDashboardMetrics,
    updateRequestorMetrics,
    calculateNodeTimeoutMetrics
} = require('./utils/metricsCalculators');
const { maxLogEntries, maxRequestHistoryHours, maxDashboardAgeMs } = require('./config');

/**
 * The logs service's data and its update cycle, without the HTTPS server (logs.js), so tests can
 * drive it. logDir holds the request, node and compare-results logs.
 */
function createLogService(logDir) {
    const fallbackLogPath = path.join(logDir, 'fallbackRequests.log');
    const cacheLogPath = path.join(logDir, 'cacheRequests.log');
    const poolLogPath = path.join(logDir, 'poolRequests.log');
    const poolNodesLogPath = path.join(logDir, 'poolNodes.log');
    const poolCompareResultsLogPath = path.join(logDir, 'poolCompareResults.log');

    // Data storage maps
    const fallbackRequestsMap = new Map();
    const cacheRequestsMap = new Map();
    const poolRequestsMap = new Map();
    const poolNodesMap = new Map();
    const poolNodesTimingMap = new Map();
    const nodeTimeoutCounts = new Map();
    const poolCompareResultsMap = new Map();

    // Last line read and byte offset after it, per log
    const lastProcessedIndexes = {
        fallback: -1,
        cache: -1,
        pool: -1,
        poolNodes: -1,
        poolCompareResults: -1
    };
    const lastByteOffsets = {
        fallback: 0,
        cache: 0,
        pool: 0,
        poolNodes: 0,
        poolCompareResults: 0
    };

    // Store request history data
    const requestHistory = new Map();

    let cachedRequestorMetrics = null;
    const lastProcessedRequestorEpoch = { value: 0 };
    let cachedDashboardMetrics = null;
    let dashboardUpdatedAt = 0;
    let cachedNodeTimeoutMetricsLastWeek = null;
    let cachedNodeTimeoutMetricsLastDay = null;
    let lastProcessedHour = null;
    let tickRunning = false;

    // Serialized responses, built on the first request after the data behind them changes and
    // reused until it changes again. versions[source] goes up whenever that data changes.
    const versions = {
        fallback: 0,
        cache: 0,
        pool: 0,
        poolNodes: 0,
        poolCompareResults: 0,
        dashboard: 0,
        requestor: 0,
        nodeTimeout: 0
    };
    const routes = {
        '/fallbackRequests': ['fallback', () => getMapContents(fallbackRequestsMap, poolCompareResultsMap)],
        '/cacheRequests': ['cache', () => getMapContents(cacheRequestsMap, poolCompareResultsMap)],
        '/poolRequests': ['pool', () => getMapContents(poolRequestsMap, poolCompareResultsMap)],
        '/poolCompareResults': ['poolCompareResults', () => getMapContents(poolCompareResultsMap, poolCompareResultsMap)],
        '/poolNodes': ['poolNodes', () => getMapContents(poolNodesMap, poolCompareResultsMap)],
        '/dashboard': ['dashboard', () => cachedDashboardMetrics],
        '/requestorTable': ['requestor', () => cachedRequestorMetrics],
        '/nodeTimeoutPercentLastWeek': ['nodeTimeout', () => cachedNodeTimeoutMetricsLastWeek],
        '/nodeTimeoutPercentLastDay': ['nodeTimeout', () => cachedNodeTimeoutMetricsLastDay]
    };
    const responseCache = new Map(); // url -> { version, body }

    function respond(url) {
        const route = routes[url];
        if (!route) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
        }
        const [source, build] = route;
        const cached = responseCache.get(url);
        if (cached && cached.version === versions[source]) {
            return { statusCode: 200, body: cached.body };
        }
        const body = JSON.stringify(build(), null, 2);
        responseCache.set(url, { version: versions[source], body });
        return { statusCode: 200, body };
    }

    // Free responses whose data has changed (the request logs' are ~40 MB each)
    function dropStaleResponses() {
        responseCache.forEach((cached, url) => {
            if (cached.version !== versions[routes[url][0]]) responseCache.delete(url);
        });
    }

    function updateCachedMetrics() {
        cachedDashboardMetrics = getDashboardMetrics(
            fallbackRequestsMap,
            cacheRequestsMap,
            poolRequestsMap,
            poolNodesTimingMap,
            requestHistory
        );
        cachedRequestorMetrics = updateRequestorMetrics(
            cachedRequestorMetrics,
            lastProcessedRequestorEpoch,
            fallbackRequestsMap,
            cacheRequestsMap,
            poolRequestsMap
        );
        dashboardUpdatedAt = Date.now();
        versions.dashboard++;
        versions.requestor++;
    }

    function updateNodeTimeoutMetrics() {
        cachedNodeTimeoutMetricsLastWeek = calculateNodeTimeoutMetrics(nodeTimeoutCounts, 'week');
        cachedNodeTimeoutMetricsLastDay = calculateNodeTimeoutMetrics(nodeTimeoutCounts, 'day');
        versions.nodeTimeout++;
    }

    // Read what was appended to every log. Returns which data changed.
    async function parseLogs() {
        const changed = {
            fallback: await parseLogFile(fallbackLogPath, fallbackRequestsMap, 'fallback', lastProcessedIndexes, lastByteOffsets, maxLogEntries),
            cache: await parseLogFile(cacheLogPath, cacheRequestsMap, 'cache', lastProcessedIndexes, lastByteOffsets, maxLogEntries),
            pool: await parseLogFile(poolLogPath, poolRequestsMap, 'pool', lastProcessedIndexes, lastByteOffsets, maxLogEntries),
            poolNodes: await parsePoolNodesLog(poolNodesLogPath, poolNodesMap, poolNodesTimingMap, nodeTimeoutCounts, lastProcessedIndexes, lastByteOffsets, maxLogEntries),
            poolCompareResults: await parsePoolCompareResultsLog(poolCompareResultsLogPath, poolCompareResultsMap, lastProcessedIndexes, lastByteOffsets)
        };
        Object.keys(changed).forEach(source => {
            if (changed[source]) versions[source]++;
        });
        return changed;
    }

    async function initialize() {
        await parseLogs();
        updateNodeTimeoutMetrics();

        // Reset lastProcessedRequestorEpoch to ensure we process all entries on first run
        lastProcessedRequestorEpoch.value = 0;

        updateRequestHistory(requestHistory, fallbackRequestsMap, cacheRequestsMap, poolRequestsMap, maxRequestHistoryHours);
        updateCachedMetrics();

        // Track the last hour we processed to detect hour changes
        lastProcessedHour = new Date(Date.now()).getHours();
    }

    // One update: hourly work when the hour has changed, then new log lines. The dashboard is
    // rebuilt only when a log changed, or when it is maxDashboardAgeMs old (its last-hour counts
    // move with the clock).
    async function tick() {
        if (tickRunning) return;
        tickRunning = true;
        try {
            const currentHour = new Date(Date.now()).getHours();
            if (currentHour !== lastProcessedHour) {
                console.log(`Hour changed from ${lastProcessedHour} to ${currentHour}, updating request history and node timeout metrics`);
                updateRequestHistory(requestHistory, fallbackRequestsMap, cacheRequestsMap, poolRequestsMap, maxRequestHistoryHours);
                updateNodeTimeoutMetrics();
                lastProcessedHour = currentHour;
            }

            const changed = await parseLogs();
            if (Object.values(changed).some(Boolean) || Date.now() - dashboardUpdatedAt >= maxDashboardAgeMs) {
                updateCachedMetrics();
            }
            dropStaleResponses();
        } finally {
            tickRunning = false;
        }
    }

    return {
        initialize,
        tick,
        respond,
        // for tests
        state: {
            fallbackRequestsMap,
            cacheRequestsMap,
            poolRequestsMap,
            poolNodesMap,
            poolNodesTimingMap,
            nodeTimeoutCounts,
            poolCompareResultsMap,
            responseCache,
            versions
        }
    };
}

module.exports = { createLogService };
