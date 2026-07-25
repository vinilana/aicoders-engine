/**
 * WebAudio front-end for the engine.
 */
export class AudioEngine {
    /**
     * @param {Object} [options] Engine options.
     * @param {string} [options.basePath=''] Prefix applied to relative sound URLs.
     * @param {number} [options.masterVolume=1] Initial master volume.
     * @param {boolean} [options.unlockOnGesture=true] Resume on the first user gesture.
     * @param {string[]} [options.buses] Extra bus names to create (music/sfx always exist).
     * @param {*} [options.target] Event target used for the gesture unlock (defaults to window).
     * @param {Object} [options.contextOptions] Options forwarded to the AudioContext.
     */
    constructor(options?: {
        basePath?: string;
        masterVolume?: number;
        unlockOnGesture?: boolean;
        buses?: string[];
        target?: any;
        contextOptions?: any;
    });
    /** @type {string} Prefix applied to relative URLs. */
    basePath: string;
    /** @type {*} Underlying AudioContext, or null when unsupported. */
    context: any;
    /** @type {*} AudioListener, or null when unsupported. */
    listener: any;
    /** @type {*} Master GainNode, or null when unsupported. */
    masterGain: any;
    /** @type {boolean} Whether WebAudio is usable. */
    supported: boolean;
    /** @type {Map<string, {name:string, gain:*, volume:number, muted:boolean}>} */
    buses: Map<string, {
        name: string;
        gain: any;
        volume: number;
        muted: boolean;
    }>;
    /** @type {AudioSource[]} Registered spatial sources. */
    sources: AudioSource[];
    /** @type {AudioVoice[]} Currently playing one-shots. */
    voices: AudioVoice[];
    /** @type {AudioVoice[]} Recycled voices. */
    _voicePool: AudioVoice[];
    /** @type {Map<string, *>} url -> AudioBuffer. */
    _buffers: Map<string, any>;
    /** @type {Map<string, Promise<*>>} url -> in-flight decode. */
    _loading: Map<string, Promise<any>>;
    /** @type {Array<*>} Registered gesture listeners, for dispose(). */
    _gestureListeners: Array<any>;
    /** @type {number} Cached master volume, kept even when muted. */
    _masterVolume: number;
    /** @type {boolean} */
    muted: boolean;
    /** @type {*} Target used for the gesture unlock. */
    gestureTarget: any;
    /**
     * Current context state ('running' | 'suspended' | 'closed' | 'unsupported').
     * @returns {string} State string.
     */
    get state(): string;
    /**
     * Resumes the audio context. Safe to call at any time.
     * @returns {Promise<void>} Resolves once the context is running.
     */
    resume(): Promise<void>;
    /**
     * Suspends the audio context (for example while the tab is hidden).
     * @returns {Promise<void>} Resolves once suspended.
     */
    suspend(): Promise<void>;
    /**
     * Installs one-shot listeners that resume the context on the first user
     * gesture, as required by browser autoplay policies.
     */
    unlockOnGesture(): void;
    /**
     * Removes the gesture unlock listeners.
     * @private
     */
    private _removeGestureListeners;
    /**
     * Creates (or returns) a named volume bus routed into the master gain.
     * @param {string} name Bus name.
     * @param {number} [volume=1] Initial linear volume.
     * @returns {{name:string, gain:*, volume:number, muted:boolean}|null} The bus.
     */
    createBus(name: string, volume?: number): {
        name: string;
        gain: any;
        volume: number;
        muted: boolean;
    };
    /**
     * Returns a bus by name, falling back to 'sfx' then 'master'.
     * @param {string} [name] Bus name.
     * @returns {{name:string, gain:*, volume:number, muted:boolean}|null} The bus.
     */
    getBus(name?: string): {
        name: string;
        gain: any;
        volume: number;
        muted: boolean;
    } | null;
    /**
     * Sets the linear volume of a bus.
     * @param {string} name Bus name.
     * @param {number} volume Linear volume.
     * @param {number} [rampSeconds] Optional ramp duration.
     * @returns {boolean} Whether the bus existed.
     */
    setBusVolume(name: string, volume: number, rampSeconds?: number): boolean;
    /**
     * Reads the linear volume of a bus.
     * @param {string} name Bus name.
     * @returns {number} Linear volume, 0 when unknown.
     */
    getBusVolume(name: string): number;
    /**
     * Mutes or unmutes a bus without losing its volume setting.
     * @param {string} name Bus name.
     * @param {boolean} muted Mute state.
     * @returns {boolean} Whether the bus existed.
     */
    setBusMuted(name: string, muted: boolean): boolean;
    /**
     * Sets the master volume.
     * @param {number} volume Linear volume.
     * @param {number} [rampSeconds] Optional ramp duration.
     */
    setMasterVolume(volume: number, rampSeconds?: number): void;
    /**
     * Reads the master volume.
     * @returns {number} Linear volume.
     */
    getMasterVolume(): number;
    /**
     * Applies a value to an AudioParam, ramping when a duration is given.
     * @param {*} param Target AudioParam.
     * @param {number} value New value.
     * @param {number} [rampSeconds] Ramp duration in seconds.
     * @private
     */
    private _rampParam;
    /**
     * Resolves a URL against `basePath`.
     * @param {string} url Relative or absolute URL.
     * @returns {string} Resolved URL.
     * @private
     */
    private _resolveUrl;
    /**
     * Decodes an ArrayBuffer, supporting both the promise and callback flavours of
     * `decodeAudioData`.
     * @param {ArrayBuffer} arrayBuffer Encoded audio data.
     * @returns {Promise<*>} Decoded AudioBuffer.
     */
    decodeAudioData(arrayBuffer: ArrayBuffer): Promise<any>;
    /**
     * Loads and decodes a sound, caching the result by resolved URL.
     * @param {string} url Sound URL.
     * @returns {Promise<*>} Decoded AudioBuffer.
     */
    loadSound(url: string): Promise<any>;
    /**
     * Loads several sounds at once.
     * @param {string[]} urls Sound URLs.
     * @returns {Promise<Map<string, *>>} Map of url -> AudioBuffer.
     */
    loadMany(urls: string[]): Promise<Map<string, any>>;
    /**
     * Returns a cached buffer without loading.
     * @param {string} url Sound URL.
     * @returns {*} AudioBuffer or null.
     */
    getBuffer(url: string): any;
    /**
     * Drops a cached buffer.
     * @param {string} url Sound URL.
     * @returns {boolean} Whether it was cached.
     */
    unload(url: string): boolean;
    /**
     * Plays a decoded buffer as a fire-and-forget voice.
     * @param {*} buffer Decoded AudioBuffer.
     * @param {Object} [options] Playback options.
     * @param {number} [options.volume=1] Linear gain.
     * @param {boolean} [options.loop=false] Loop the buffer.
     * @param {number} [options.playbackRate=1] Playback rate.
     * @param {number} [options.detune=0] Detune in cents (when supported).
     * @param {string} [options.bus='sfx'] Destination bus.
     * @param {number} [options.offset=0] Start offset in seconds.
     * @param {number} [options.delay=0] Delay before starting, in seconds.
     * @param {number} [options.fadeIn=0] Fade-in duration in seconds.
     * @param {{x:number,y:number,z:number}} [options.position] World position for 3D playback.
     * @param {number} [options.refDistance=1] Panner reference distance.
     * @param {number} [options.maxDistance=10000] Panner maximum distance.
     * @param {number} [options.rolloffFactor=1] Panner rolloff.
     * @returns {AudioVoice|null} The playing voice, or null when unsupported.
     */
    play(buffer: any, options?: {
        volume?: number;
        loop?: boolean;
        playbackRate?: number;
        detune?: number;
        bus?: string;
        offset?: number;
        delay?: number;
        fadeIn?: number;
        position?: {
            x: number;
            y: number;
            z: number;
        };
        refDistance?: number;
        maxDistance?: number;
        rolloffFactor?: number;
    }): AudioVoice | null;
    /**
     * Loads (or reuses) a sound and plays it.
     * @param {string} url Sound URL.
     * @param {Object} [options] Playback options, see `play`.
     * @returns {Promise<AudioVoice|null>} The playing voice.
     */
    playSound(url: string, options?: any): Promise<AudioVoice | null>;
    /**
     * Returns a finished voice to the pool.
     * @param {AudioVoice} voice Voice to recycle.
     * @private
     */
    private _recycleVoice;
    /**
     * Stops every playing voice and every registered source.
     * @param {number} [fadeSeconds=0] Optional fade-out.
     */
    stopAll(fadeSeconds?: number): void;
    /**
     * Creates a spatial source node bound to this engine.
     * @param {*} buffer Decoded AudioBuffer (may be null and set later).
     * @param {Object} [options] Source options, see AudioSource.
     * @returns {AudioSource} The created source.
     */
    createSource(buffer: any, options?: any): AudioSource;
    /**
     * Registers a source so `update()` refreshes its panner automatically.
     * @param {AudioSource} source Source to register.
     */
    registerSource(source: AudioSource): void;
    /**
     * Unregisters a previously registered source.
     * @param {AudioSource} source Source to remove.
     */
    unregisterSource(source: AudioSource): void;
    /**
     * Updates the 3D listener from a camera's world transform. Uses the AudioParam
     * interface when available and falls back to the deprecated setters.
     * @param {*} camera Camera (or any Node3D) to follow.
     */
    setListenerFromCamera(camera: any): void;
    /**
     * Refreshes every registered spatial source. Call once per frame.
     * @param {number} [dt] Frame time in seconds (unused, kept for symmetry).
     */
    update(dt?: number): void;
    /**
     * Stops everything, releases the graph and closes the context.
     */
    dispose(): void;
}
import { AudioSource } from "./AudioSource.js";
/**
 * A playing one-shot. Instances are pooled: the wrapper, its gain node and its
 * panner node are reused, only the (single use) buffer source is recreated.
 */
declare class AudioVoice {
    /**
     * @param {AudioEngine} engine Owning engine.
     */
    constructor(engine: AudioEngine);
    /** @type {AudioEngine} */
    engine: AudioEngine;
    /** @type {*} */
    context: any;
    /** @type {*} */
    gain: any;
    /** @type {*} */
    panner: any;
    /** @type {*} */
    source: any;
    /** @type {boolean} */
    active: boolean;
    /** @type {boolean} */
    positional: boolean;
    /** @type {number} Monotonic id, invalidated on stop. */
    generation: number;
    /** @type {Function} */
    _onEnded: Function;
    /**
     * Lazily creates the panner node used for positional playback.
     * @returns {*} The panner node.
     */
    ensurePanner(): any;
    /**
     * Sets the voice gain, optionally ramping.
     * @param {number} value Linear gain.
     * @param {number} [rampSeconds=0] Ramp duration in seconds.
     */
    setVolume(value: number, rampSeconds?: number): void;
    /**
     * Moves the voice in world space (positional voices only).
     * @param {number} x World X.
     * @param {number} y World Y.
     * @param {number} z World Z.
     */
    setPosition(x: number, y: number, z: number): void;
    /**
     * Stops playback.
     * @param {number} [fadeSeconds=0] Optional fade-out before stopping.
     */
    stop(fadeSeconds?: number): void;
}
export {};
