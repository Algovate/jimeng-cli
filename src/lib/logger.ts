import path from 'path';
import _util from 'util';

import pc from 'picocolors';
import _ from 'lodash';
import fs from 'fs-extra';
import { format as dateFormat } from 'date-fns';

import config from './config.ts';
import util from './util.ts';

/** Maps level color names to picocolors formatter functions */
const colorFns: Record<string, (s: string) => string> = {
    green: pc.green,
    brightCyan: pc.cyan,
    white: pc.white,
    brightYellow: pc.yellow,
    brightRed: pc.red,
    red: pc.red,
};

const isVercelEnv = process.env.VERCEL;
const isCliSilentLogs = () => process.env.JIMENG_CLI_SILENT_LOGS === "true";

class LogWriter {

    #buffers = [];
    #timer = null;

    constructor() {
        !isVercelEnv && fs.ensureDirSync(config.system.logDirPath);
        !isVercelEnv && this.work();
    }

    push(content) {
        const buffer = Buffer.from(content);
        this.#buffers.push(buffer);
    }

    writeSync(buffer) {
        !isVercelEnv && fs.appendFileSync(path.join(config.system.logDirPath, `/${util.getDateString()}.log`), buffer);
    }

    async write(buffer) {
        !isVercelEnv && await fs.appendFile(path.join(config.system.logDirPath, `/${util.getDateString()}.log`), buffer);
    }

    flush() {
        if(!this.#buffers.length) return;
        !isVercelEnv && fs.appendFileSync(path.join(config.system.logDirPath, `/${util.getDateString()}.log`), Buffer.concat(this.#buffers));
        this.#buffers = [];
    }

    destroy() {
        if (this.#timer) clearTimeout(this.#timer);
        this.flush();
    }

    scheduleNext() {
        this.#timer = setTimeout(this.work.bind(this), config.system.logWriteInterval);
        if (this.#timer && typeof this.#timer.unref === "function") this.#timer.unref();
    }

    work() {
        if (!this.#buffers.length) return this.scheduleNext();
        const buffer = Buffer.concat(this.#buffers);
        this.#buffers = [];
        this.write(buffer)
        .finally(() => this.scheduleNext())
        .catch(err => console.error("Log write error:", err));
    }

}

class LogText {

    /** @type {string} 日志级别 */
    level;
    /** @type {string} 日志文本 */
    text;
    /** @type {string} 日志来源 */
    source;
    /** @type {Date} 日志发生时间 */
    time = new Date();

    constructor(level, ...params) {
        this.level = level;
        this.text = _util.format.apply(null, params);
        this.source = this.#getStackTopCodeInfo();
    }

    #getStackTopCodeInfo() {
        const unknownInfo = { name: "unknown", codeLine: 0, codeColumn: 0 };
        const stackArray = new Error().stack.split("\n");
        const text = stackArray[4];
        if (!text)
            return unknownInfo;
        const match = text.match(/at (.+) \((.+)\)/) || text.match(/at (.+)/);
        if (!match || !_.isString(match[2] || match[1]))
            return unknownInfo;
        const temp = match[2] || match[1];
        const _match = temp.match(/([a-zA-Z0-9_\-\.]+)\:(\d+)\:(\d+)$/);
        if (!_match)
            return unknownInfo;
        const [, scriptPath, codeLine, codeColumn] = _match as any;
        return {
            name: scriptPath ? scriptPath.replace(/.js$/, "") : "unknown",
            path: scriptPath || null,
            codeLine: parseInt(codeLine || 0),
            codeColumn: parseInt(codeColumn || 0)
        };
    }

    toString() {
        return `[${dateFormat(this.time, "yyyy-MM-dd HH:mm:ss.SSS")}][${this.level}][${this.source.name}<${this.source.codeLine},${this.source.codeColumn}>] ${this.text}`;
    }

}

class Logger {

    /** @type {Object} 系统配置 */
    config = {};
    /** @type {Object} 日志级别映射 */
    static Level = {
        Success: "success",
        Info: "info",
        Log: "log",
        Debug: "debug",
        Warning: "warning",
        Error: "error",
        Fatal: "fatal",
    };
    /** @type {Object} 日志级别文本颜色樱色 */
    static LevelColor = {
        [Logger.Level.Success]: "green",
        [Logger.Level.Info]: "brightCyan",
        [Logger.Level.Debug]: "white",
        [Logger.Level.Warning]: "brightYellow",
        [Logger.Level.Error]: "brightRed",
        [Logger.Level.Fatal]: "red"
    };
    static LevelPriority = {
        [Logger.Level.Fatal]: 1,
        [Logger.Level.Error]: 2,
        [Logger.Level.Warning]: 3,
        [Logger.Level.Success]: 4,
        [Logger.Level.Info]: 5,
        [Logger.Level.Log]: 6,
        [Logger.Level.Debug]: 7,
    }
    #writer;

    constructor() {
        this.#writer = new LogWriter();
    }

    header() {
        this.#writer.writeSync(Buffer.from(`\n\n===================== LOG START ${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")} =====================\n\n`));
    }

    footer() {
        this.#writer.flush();  //将未写入文件的日志缓存写入
        this.#writer.writeSync(Buffer.from(`\n\n===================== LOG END ${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")} =====================\n\n`));
    }

    #emit(level, consoleMethod, params, options: { requireDebug?: boolean; trailingNewline?: boolean } = {}) {
        if (isCliSilentLogs()) return;
        if (options.requireDebug && !config.system.debug) return;
        if (!this.#checkLevel(level)) return;
        const content = new LogText(level, ...params).toString();
        const colorFn = colorFns[Logger.LevelColor[level]] || ((s: string) => s);
        consoleMethod(colorFn(content));
        this.#writer.push(options.trailingNewline === false ? content : content + "\n");
    }

    #checkLevel(level) {
        const currentLevelPriority = Logger.LevelPriority[config.system.log_level] || 99;
        const levelPriority = Logger.LevelPriority[level];
        return levelPriority <= currentLevelPriority;
    }

    success(...params) {
        this.#emit(Logger.Level.Success, console.info, params);
    }

    info(...params) {
        this.#emit(Logger.Level.Info, console.info, params);
    }

    debug(...params) {
        this.#emit(Logger.Level.Debug, console.debug, params, { requireDebug: true });
    }

    warn(...params) {
        this.#emit(Logger.Level.Warning, console.warn, params);
    }

    error(...params) {
        this.#emit(Logger.Level.Error, console.error, params, { trailingNewline: false });
    }

    destroy() {
        this.#writer.destroy();
    }

}

export default new Logger();
