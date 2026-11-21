const ora = require('ora');

class Logger {
    constructor(debugMode, timestamps) {
        this.configure(debugMode, timestamps)
    }

    configure(debugMode = false, timestamps = false) {
        this.debugMode = debugMode;
        this.timestamps = timestamps;
    }

    setDebug(debug) {
        this.debugMode = debug;
    }

    /**
     * Local wall-clock time (what the engineer's watch says), e.g. "2026-11-21 19:42:05.123".
     * @param {Date} date
     * @returns {string}
     */
    static localTimestamp(date = new Date()) {
        const pad = (n, width = 2) => String(n).padStart(width, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
            `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
    }

    formatPrefix(level) {
        const timestamp = this.timestamps ? `${Logger.localTimestamp()} ` : '';
        const levelFormatted = `[${level}]`.padEnd(7);
        return timestamp + levelFormatted;
    }

    formatMessage(msg, level) {
        return `${this.formatPrefix(level)} ${msg}`;
    }

    info(msg) {
        console.log(this.formatMessage(msg, 'INFO'));
    }

    warn(msg) {
        console.warn(this.formatMessage(msg, 'WARN'));
    }

    error(msg) {
        console.error(this.formatMessage(msg, 'ERROR'));
    }

    debug(msg) {
        if (this.debugMode) {
            console.debug(this.formatMessage(msg, 'DEBUG'));
        }
    }

    loading(msg) {
        const spinner = ora({
            prefixText: this.formatPrefix('INFO'),
            text: msg,
            spinner: 'dots'
        }).start();
        return spinner;
    }
}

const logger = new Logger();
module.exports = logger;