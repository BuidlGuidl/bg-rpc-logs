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
const { classifyStatus } = require('./utils/errorClass');
const { maxLogEntries, maxRequestHistoryHours, maxDashboardAgeMs, defaultPageLimit, maxPageLimit } = require('./config');

// Filters the logs page offers. Request and node tables: 'no-client' drops buidlguidl-client's
// requests, success / warning / error keep one error class (utils/errorClass.js). Compare
// results: 'success' keeps matches, any other filter but 'all' keeps mismatches.
const PAGE_FILTERS = ['all', 'no-client', 'success', 'warning', 'error'];
const STATUS_FILTER_CLASS = { success: 'ok', warning: 'warning', error: 'error' };

// Search on the logs page: method (exact) and q (text, any case) in these fields of each table
const SEARCH_FIELDS = {
    request: ['requester', 'ip', 'method', 'params', 'status'],
    node: ['nodeId', 'owner', 'method', 'params', 'status'],
    compare: ['mismatchedNode', 'mismatchedOwner', 'nodeId1', 'nodeId2', 'nodeId3', 'method', 'params']
};
const MAX_METHOD_CHARS = 100;
const MAX_SEARCH_CHARS = 200;

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

    // Tables the logs page reads a page at a time
    const pagedTables = {
        '/fallbackRequests': fallbackRequestsMap,
        '/cacheRequests': cacheRequestsMap,
        '/poolRequests': poolRequestsMap,
        '/poolNodes': poolNodesMap,
        '/poolCompareResults': poolCompareResultsMap
    };

    function respond(url) {
        const { pathname, searchParams } = new URL(url, 'http://localhost');
        if (searchParams.has('page') && pagedTables[pathname]) {
            return respondPage(pagedTables[pathname], searchParams);
        }
        const route = routes[pathname];
        if (!route) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
        }
        const [source, build] = route;
        const cached = responseCache.get(pathname);
        if (cached && cached.version === versions[source]) {
            return { statusCode: 200, body: cached.body };
        }
        const body = JSON.stringify(build(), null, 2);
        responseCache.set(pathname, { version: versions[source], body });
        return { statusCode: 200, body };
    }

    // One page of a table, newest first, filtered and searched:
    // { total, page, limit, methods, entries }. total counts the entries that pass; methods lists
    // every method in the table (for the page's method dropdown). Request and node entries carry
    // their errorClass.
    function respondPage(targetMap, searchParams) {
        const page = Number(searchParams.get('page'));
        const limit = searchParams.has('limit') ? Number(searchParams.get('limit')) : defaultPageLimit;
        const filter = searchParams.get('filter') || 'all';
        const method = searchParams.get('method') || '';
        const q = searchParams.get('q') || '';
        if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > maxPageLimit ||
            !PAGE_FILTERS.includes(filter) || method.length > MAX_METHOD_CHARS || q.length > MAX_SEARCH_CHARS) {
            return { statusCode: 400, body: JSON.stringify({ error: `page must be >= 1, limit 1-${maxPageLimit}, filter one of ${PAGE_FILTERS.join(', ')}, method up to ${MAX_METHOD_CHARS} and q up to ${MAX_SEARCH_CHARS} characters` }) };
        }

        // Request and node tables are in file order; compare results are kept newest first
        const isCompare = targetMap === poolCompareResultsMap;
        const kind = isCompare ? 'compare' : targetMap === poolNodesMap ? 'node' : 'request';
        const newestFirst = Array.from(targetMap.values());
        if (!isCompare) newestFirst.reverse();

        const tests = [];
        if (filter !== 'all') {
            if (isCompare) {
                tests.push(entry => (filter === 'success') === Boolean(entry.resultsMatch));
            } else if (filter === 'no-client') {
                tests.push(entry => entry.requester !== 'buidlguidl-client');
            } else {
                tests.push(entry => classifyStatus(entry.status) === STATUS_FILTER_CLASS[filter]);
            }
        }
        if (method) {
            tests.push(entry => entry.method === method);
        }
        if (q) {
            const text = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            const fields = SEARCH_FIELDS[kind];
            tests.push(entry => fields.some(field => typeof entry[field] === 'string' && text.test(entry[field])));
        }
        const matching = tests.length ? newestFirst.filter(entry => tests.every(test => test(entry))) : newestFirst;

        const methods = [...new Set(newestFirst.map(entry => entry.method).filter(m => typeof m === 'string' && m))].sort();
        const entries = matching.slice((page - 1) * limit, page * limit)
            .map(entry => (isCompare ? entry : { ...entry, errorClass: classifyStatus(entry.status) }));
        return { statusCode: 200, body: JSON.stringify({ total: matching.length, page, limit, methods, entries }) };
    }

    // Free responses whose data has changed (the request logs' are ~40 MB each)
    function dropStaleResponses() {
        responseCache.forEach((cached, pathname) => {
            if (cached.version !== versions[routes[pathname][0]]) responseCache.delete(pathname);
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
