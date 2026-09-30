const fs = require('fs');

const NEWLINE = 0x0a;

/**
 * Find where the last nLines lines of a file start, in one pass over the raw bytes (no decoding,
 * no per-line strings). A final line without a newline counts as a line.
 * @param {string} filePath - Path to the file
 * @param {number} nLines - Number of lines wanted from the end
 * @returns {Promise<{startByte: number, startLine: number, totalLines: number}>} - Byte offset and
 *   0-based line number of the first of those lines ({0, 0} when the file has nLines or fewer)
 */
async function findTailStart(filePath, nLines) {
    // Start offsets of the most recent nLines + 1 lines after the first (ring buffer)
    const starts = new Array(nLines + 1);
    let newlines = 0;
    let offset = 0;
    let lastByte = NEWLINE;
    for await (const chunk of fs.createReadStream(filePath)) {
        let i = -1;
        while ((i = chunk.indexOf(NEWLINE, i + 1)) !== -1) {
            newlines++;
            starts[newlines % (nLines + 1)] = offset + i + 1;
        }
        offset += chunk.length;
        lastByte = chunk[chunk.length - 1];
    }
    const totalLines = newlines + (lastByte === NEWLINE ? 0 : 1);
    if (totalLines <= nLines) return { startByte: 0, startLine: 0, totalLines };
    const startLine = totalLines - nLines;
    return { startByte: starts[startLine % (nLines + 1)], startLine, totalLines };
}

/**
 * Read the complete lines of a file from startByte on. A last line without its newline yet (the
 * writer is mid-append) is left for the next read instead of being read half-written.
 * @param {string} filePath - Path to the file
 * @param {number} startByte - Byte offset to start at (the start of a line)
 * @param {(line: string) => void} onLine - Called with each line, without its newline
 * @returns {Promise<number>} - Byte offset just after the last complete line read
 */
async function readLines(filePath, startByte, onLine) {
    let offset = startByte;
    let pending = null; // bytes of a line that continues in the next chunk
    for await (const chunk of fs.createReadStream(filePath, { start: startByte })) {
        const buf = pending ? Buffer.concat([pending, chunk]) : chunk;
        let lineStart = 0;
        let nl;
        while ((nl = buf.indexOf(NEWLINE, lineStart)) !== -1) {
            onLine(buf.toString('utf8', lineStart, nl));
            lineStart = nl + 1;
        }
        offset += lineStart;
        pending = lineStart < buf.length ? buf.subarray(lineStart) : null;
    }
    return offset;
}

module.exports = {
    findTailStart,
    readLines
};
