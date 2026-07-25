/**
 * Logger - tiny leveled console wrapper used across the engine.
 *
 * No console access happens at module scope: the console object is resolved
 * lazily inside the writer so the module stays importable in any environment.
 *
 * @module core/Logger
 */
/** Named log levels. Higher values are more verbose. */
export const LogLevel: Readonly<{
    NONE: 0;
    ERROR: 1;
    WARN: 2;
    INFO: 3;
    DEBUG: 4;
}>;
export namespace Logger {
    import level = WARN;
    export { level };
    export const prefix: string;
    /**
     * Sets the verbosity level.
     * @param {number|string} level Numeric level or a {@link LogLevel} key.
     * @returns {number} The applied level.
     */
    export function setLevel(level: string | number): number;
    /**
     * Tells whether messages of the given level would be emitted.
     * @param {number} level Level to test.
     * @returns {boolean} True when enabled.
     */
    export function isEnabled(level: number): boolean;
    /**
     * Verbose diagnostic message.
     * @param {...*} args Values to log.
     */
    export function debug(...args: any[]): void;
    /**
     * Informational message.
     * @param {...*} args Values to log.
     */
    export function info(...args: any[]): void;
    /**
     * Warning message.
     * @param {...*} args Values to log.
     */
    export function warn(...args: any[]): void;
    /**
     * Error message.
     * @param {...*} args Values to log.
     */
    export function error(...args: any[]): void;
    /**
     * Emits a warning only the first time the given key is seen. Useful for
     * per frame code paths that would otherwise flood the console.
     * @param {string} key De-duplication key.
     * @param {...*} args Values to log.
     */
    export function warnOnce(key: string, ...args: any[]): void;
    /**
     * Emits an error only the first time the given key is seen.
     * @param {string} key De-duplication key.
     * @param {...*} args Values to log.
     */
    export function errorOnce(key: string, ...args: any[]): void;
    /** Clears the de-duplication table used by the *Once helpers. */
    export function resetOnce(): void;
}
