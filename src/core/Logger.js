/**
 * Logger - tiny leveled console wrapper used across the engine.
 *
 * No console access happens at module scope: the console object is resolved
 * lazily inside the writer so the module stays importable in any environment.
 *
 * @module core/Logger
 */

/** Named log levels. Higher values are more verbose. */
export const LogLevel = Object.freeze({
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4
});

/** Keys already reported through the *Once helpers. */
const _seen = new Set();

/**
 * Writes to the console if it exists and exposes the requested method.
 *
 * @param {string} method Console method name.
 * @param {string} prefix Message prefix.
 * @param {IArguments|Array} args Arguments forwarded to the console.
 */
function write(method, prefix, args) {
  const target = typeof console !== 'undefined' ? console : null;
  if (target === null) return;
  const fn = typeof target[method] === 'function' ? target[method] : target.log;
  if (typeof fn !== 'function') return;
  const n = args.length;
  // Explicit fan-out avoids building an intermediate array for the common cases.
  if (n === 0) fn.call(target, prefix);
  else if (n === 1) fn.call(target, prefix, args[0]);
  else if (n === 2) fn.call(target, prefix, args[0], args[1]);
  else if (n === 3) fn.call(target, prefix, args[0], args[1], args[2]);
  else {
    const out = new Array(n + 1);
    out[0] = prefix;
    for (let i = 0; i < n; i++) out[i + 1] = args[i];
    fn.apply(target, out);
  }
}

/**
 * Global logger singleton.
 * Set `Logger.level` (or call `setLevel`) to control verbosity, 0..4.
 */
export const Logger = {
  /** @type {number} Current verbosity, see {@link LogLevel}. */
  level: LogLevel.WARN,

  /** @type {string} Prefix prepended to every message. */
  prefix: '[aicoders]',

  /**
   * Sets the verbosity level.
   * @param {number|string} level Numeric level or a {@link LogLevel} key.
   * @returns {number} The applied level.
   */
  setLevel(level) {
    let value = level;
    if (typeof level === 'string') {
      const key = level.toUpperCase();
      value = LogLevel[key] !== undefined ? LogLevel[key] : LogLevel.WARN;
    }
    if (typeof value !== 'number' || value !== value) value = LogLevel.WARN;
    this.level = value < 0 ? 0 : (value > 4 ? 4 : value | 0);
    return this.level;
  },

  /**
   * Tells whether messages of the given level would be emitted.
   * @param {number} level Level to test.
   * @returns {boolean} True when enabled.
   */
  isEnabled(level) {
    return level <= this.level;
  },

  /**
   * Verbose diagnostic message.
   * @param {...*} args Values to log.
   */
  debug(...args) {
    if (this.level >= LogLevel.DEBUG) write('debug', this.prefix, args);
  },

  /**
   * Informational message.
   * @param {...*} args Values to log.
   */
  info(...args) {
    if (this.level >= LogLevel.INFO) write('info', this.prefix, args);
  },

  /**
   * Warning message.
   * @param {...*} args Values to log.
   */
  warn(...args) {
    if (this.level >= LogLevel.WARN) write('warn', this.prefix, args);
  },

  /**
   * Error message.
   * @param {...*} args Values to log.
   */
  error(...args) {
    if (this.level >= LogLevel.ERROR) write('error', this.prefix, args);
  },

  /**
   * Emits a warning only the first time the given key is seen. Useful for
   * per frame code paths that would otherwise flood the console.
   * @param {string} key De-duplication key.
   * @param {...*} args Values to log.
   */
  warnOnce(key, ...args) {
    if (_seen.has(key)) return;
    _seen.add(key);
    if (this.level >= LogLevel.WARN) write('warn', this.prefix, args);
  },

  /**
   * Emits an error only the first time the given key is seen.
   * @param {string} key De-duplication key.
   * @param {...*} args Values to log.
   */
  errorOnce(key, ...args) {
    if (_seen.has(key)) return;
    _seen.add(key);
    if (this.level >= LogLevel.ERROR) write('error', this.prefix, args);
  },

  /** Clears the de-duplication table used by the *Once helpers. */
  resetOnce() {
    _seen.clear();
  }
};
