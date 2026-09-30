const { parseRequestLogLine } = require('./requestLogLine');
const fs = require('fs');
const { findTailStart, readLines } = require('./fileUtils');
const { recordNodeTimeoutSample, pruneNodeTimeoutCounts } = require('./metricsCalculators');
const { maxTimingEntriesPerNode, maxParamsChars } = require('../config');

// A copy of a string that was cut from a larger one. split() returns slices that keep the whole
// line they were cut from alive, so an entry would pin its full line (multicall params: 8+ KB).
function ownCopy(s) {
    return typeof s === 'string' ? Buffer.from(s, 'utf8').toString('utf8') : s;
}

// params as stored and served, cut to maxParamsChars. Multicall eth_calls carry 8+ KB of calldata;
// 40,000 of them made /poolRequests and /poolNodes ~300 MB each, and the logs page fetching both
// at once ran this process out of heap.
function storedParams(params) {
    if (typeof params !== 'string' || params.length <= maxParamsChars) return ownCopy(params);
    return `${ownCopy(params.slice(0, maxParamsChars))}… (${params.length} chars)`;
}

/**
 * Delete the oldest entries until the map holds maxEntries. Entries are inserted in file order and
 * a Map iterates in insertion order, so the oldest are the first keys: no sort needed.
 */
function pruneOldest(targetMap, maxEntries) {
    const keys = targetMap.keys();
    while (targetMap.size > maxEntries) {
        targetMap.delete(keys.next().value);
    }
}

/**
 * Parse a standard log file incrementally
 * Efficiently reads only new entries from log files
 * @returns {Promise<boolean>} - true if targetMap changed
 */
async function parseLogFile(logPath, targetMap, logType, lastProcessedIndexes, lastByteOffsets, maxLogEntries) {
    try {
        let startLine = lastProcessedIndexes[logType] + 1;
        let startByte = lastByteOffsets[logType];
        let reset = false;

        if (lastProcessedIndexes[logType] === -1) {
            // First run: only read the last maxLogEntries lines
            const tail = await findTailStart(logPath, maxLogEntries);
            startLine = tail.startLine;
            startByte = tail.startByte;
            if (startLine > 0) {
                console.log(`${logType}: Skipping first ${startLine} lines, reading last ${maxLogEntries} entries from ${tail.totalLines} total lines`);
            }
        }

        const stats = await fs.promises.stat(logPath);

        // If file was truncated or is smaller than our offset, reset
        if (stats.size < startByte) {
            console.log(`${logType}: Log file was rotated or truncated, re-reading from start`);
            targetMap.clear();
            lastProcessedIndexes[logType] = -1;
            lastByteOffsets[logType] = 0;
            reset = true;
            startLine = 0;
            startByte = 0;
        }

        if (stats.size === startByte) {
            // No new data
            return reset;
        }

        let newEntriesCount = 0;
        let currentLine = startLine;
        lastByteOffsets[logType] = await readLines(logPath, startByte, (line) => {
            // v2 or legacy format (utils/requestLogLine.js); unreadable lines are skipped
            const entry = parseRequestLogLine(line);
            if (entry) {
                const key = ownCopy(`${entry.epoch}-${currentLine}`);
                targetMap.set(key, {
                    timestamp: ownCopy(entry.timestamp),
                    epoch: ownCopy(entry.epoch),
                    requester: ownCopy(entry.requester || ''),
                    ip: ownCopy(entry.ip),
                    method: ownCopy(entry.method),
                    params: storedParams(entry.params),
                    elapsed: entry.elapsed,
                    status: ownCopy(entry.status),
                    lineIndex: currentLine
                });
                newEntriesCount++;
            }
            // Resume point is the last line read, parsed or skipped, so line numbers
            // (entry keys) stay right after an unreadable line
            lastProcessedIndexes[logType] = currentLine;
            currentLine++;
        });

        pruneOldest(targetMap, maxLogEntries);

        if (newEntriesCount > 0) {
            const mapName = logType + 'RequestsMap';
            console.log(`Added ${newEntriesCount} new entries to ${mapName}. Total entries: ${targetMap.size}`);
        }
        return reset || newEntriesCount > 0;
    } catch (error) {
        const mapName = logType + 'RequestsMap';
        console.error(`Error parsing ${mapName} log file:`, error);
        return false;
    }
}

/**
 * Parse poolNodes.log incrementally, in one pass for everything read from it:
 * - poolNodesMap: the last maxLogEntries lines
 * - poolNodesTimingMap: durations per node, the last maxTimingEntriesPerNode of each
 * - nodeTimeoutCounts: requests and failures per node per hour, last 7 days (metricsCalculators)
 * The first call reads the whole file (timing and timeout counts need it); later calls read only
 * what was appended.
 * @returns {Promise<boolean>} - true if anything changed
 */
async function parsePoolNodesLog(logPath, poolNodesMap, poolNodesTimingMap, nodeTimeoutCounts, lastProcessedIndexes, lastByteOffsets, maxLogEntries) {
    try {
        let startByte = lastByteOffsets.poolNodes;
        let reset = false;

        const stats = await fs.promises.stat(logPath);

        // If file was truncated or is smaller than our offset, reset
        if (stats.size < startByte) {
            console.log('poolNodes: Log file was rotated or truncated, clearing node maps and re-reading from start');
            poolNodesMap.clear();
            poolNodesTimingMap.clear();
            nodeTimeoutCounts.clear();
            lastProcessedIndexes.poolNodes = -1;
            lastByteOffsets.poolNodes = 0;
            reset = true;
            startByte = 0;
        }

        if (stats.size === startByte) {
            // No new data
            return reset;
        }

        // On a read from the start, lines before the last maxLogEntries only feed timing and counts
        const firstMapLine = startByte === 0 ? (await findTailStart(logPath, maxLogEntries)).startLine : 0;

        let newEntriesCount = 0;
        let newTimingCount = 0;
        let currentLine = lastProcessedIndexes.poolNodes + 1;
        lastByteOffsets.poolNodes = await readLines(logPath, startByte, (line) => {
            if (line.trim()) {
                const parts = line.split('|');
                const [timestamp, epochRaw, nodeIdRaw, ownerRaw, method, params, duration, status] = parts;
                const epoch = ownCopy(epochRaw);
                const nodeId = ownCopy(nodeIdRaw);
                const owner = ownCopy(ownerRaw);
                if (currentLine >= firstMapLine) {
                    const key = ownCopy(`${epoch}-${nodeId}-${currentLine}`);
                    poolNodesMap.set(key, {
                        timestamp: ownCopy(timestamp),
                        epoch,
                        nodeId,
                        owner,
                        method: ownCopy(method),
                        params: storedParams(params),
                        duration: parseFloat(duration),
                        status: ownCopy(status),
                        lineIndex: currentLine
                    });
                    pruneOldest(poolNodesMap, maxLogEntries);
                    newEntriesCount++;
                }

                // Timing: at least 7 fields (timestamp, epoch, nodeId, owner, method, params, duration),
                // and a nodeId that isn't a 13-digit epoch (a shifted line)
                if (parts.length >= 7 && nodeId && nodeId.trim() && !/^\d{13}$/.test(nodeId.trim())) {
                    const durationValue = parseFloat(duration);
                    if (!isNaN(durationValue)) {
                        let arr = poolNodesTimingMap.get(nodeId);
                        if (!arr) {
                            arr = [];
                            poolNodesTimingMap.set(nodeId, arr);
                        }
                        arr.push(durationValue);
                        // Trim oldest entries when array exceeds cap to prevent unbounded growth
                        if (arr.length > maxTimingEntriesPerNode) {
                            arr.splice(0, arr.length - maxTimingEntriesPerNode);
                        }
                        newTimingCount++;
                    }
                }

                recordNodeTimeoutSample(nodeTimeoutCounts, epoch, nodeId, owner, status);
            }
            lastProcessedIndexes.poolNodes = currentLine;
            currentLine++;
        });

        const pruned = pruneNodeTimeoutCounts(nodeTimeoutCounts);

        if (newEntriesCount > 0) {
            console.log(`Added ${newEntriesCount} new entries to poolNodesMap (${newTimingCount} timings). Total entries: ${poolNodesMap.size}, timing nodes: ${poolNodesTimingMap.size}, timeout hour buckets: ${nodeTimeoutCounts.size} (pruned ${pruned})`);
        }
        return reset || newEntriesCount > 0 || newTimingCount > 0 || pruned > 0;
    } catch (error) {
        console.error('Error parsing poolNodes log file:', error);
        return false;
    }
}

/**
 * Parse pool compare results log file - only stores mismatches
 * @returns {Promise<boolean>} - true if targetMap changed
 */
async function parsePoolCompareResultsLog(logPath, targetMap, lastProcessedIndexes, lastByteOffsets) {
    try {
        let startByte = lastByteOffsets.poolCompareResults;
        let reset = false;

        const stats = await fs.promises.stat(logPath);

        // If file was truncated or is smaller than our offset, reset
        if (stats.size < startByte) {
            console.log(`poolCompareResults: Log file was rotated or truncated, re-reading from start`);
            targetMap.clear();
            lastProcessedIndexes.poolCompareResults = -1;
            lastByteOffsets.poolCompareResults = 0;
            reset = true;
            startByte = 0;
        }

        if (stats.size === startByte) {
            // No new data
            return reset;
        }

        if (startByte === 0) {
            console.log(`poolCompareResults: Scanning ${stats.size} bytes for mismatches on initial load`);
        }

        const newEntries = [];
        let currentLine = lastProcessedIndexes.poolCompareResults + 1;
        lastByteOffsets.poolCompareResults = await readLines(logPath, startByte, (line) => {
            if (line.trim()) {
                const [
                    timestamp, epoch, resultsMatch, mismatchedNode, mismatchedOwner,
                    mismatchedResults, nodeId1, nodeResult1, nodeId2, nodeResult2,
                    nodeId3, nodeResult3, method, params
                ] = line.split('|');

                // Only store mismatches
                if (resultsMatch === 'false') {
                    try {
                        newEntries.push({
                            key: ownCopy(`${epoch}-${currentLine}`),
                            value: {
                                timestamp,
                                epoch,
                                resultsMatch: false,
                                mismatchedNode: mismatchedNode === 'nan' ? null : mismatchedNode,
                                mismatchedOwner: mismatchedOwner === 'nan' ? null : mismatchedOwner,
                                mismatchedResults: mismatchedResults === '[]' ? [] : JSON.parse(mismatchedResults),
                                nodeId1,
                                nodeResult1: JSON.parse(nodeResult1),
                                nodeId2,
                                nodeResult2: JSON.parse(nodeResult2),
                                nodeId3,
                                nodeResult3: JSON.parse(nodeResult3),
                                method,
                                params,
                                lineIndex: currentLine
                            }
                        });
                    } catch (error) {
                        console.error(`poolCompareResults: skipping unreadable line ${currentLine}: ${error.message}`);
                    }
                }
            }
            lastProcessedIndexes.poolCompareResults = currentLine;
            currentLine++;
        });

        if (newEntries.length === 0) {
            return reset;
        }

        // Keep existing mismatched entries, add the new ones, newest first (timestamp, then line)
        const mismatchedEntries = [];
        targetMap.forEach((value, key) => {
            if (!value.resultsMatch) {
                mismatchedEntries.push({ key, value });
            }
        });
        mismatchedEntries.push(...newEntries);
        mismatchedEntries.sort((a, b) => {
            const timeA = new Date(a.value.timestamp).getTime();
            const timeB = new Date(b.value.timestamp).getTime();
            if (timeA !== timeB) {
                return timeB - timeA;
            }
            return b.value.lineIndex - a.value.lineIndex;
        });
        targetMap.clear();
        mismatchedEntries.forEach(({key, value}) => {
            targetMap.set(key, value);
        });
        console.log(`Added ${newEntries.length} new mismatched entries to poolCompareResultsMap. Total mismatched entries: ${targetMap.size}`);
        return true;
    } catch (error) {
        console.error('Error parsing poolCompareResultsMap log file:', error);
        return false;
    }
}

module.exports = {
    parseLogFile,
    parsePoolNodesLog,
    parsePoolCompareResultsLog,
    pruneOldest
};
