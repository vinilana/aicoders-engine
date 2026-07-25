/**
 * A scene-graph node that plays an AudioBuffer, optionally in 3D.
 */
export class AudioSource extends Node3D {
    /**
     * @param {import('./AudioEngine.js').AudioEngine} engine Owning engine.
     * @param {*} [buffer] Decoded AudioBuffer (may be assigned later).
     * @param {Object} [options] Source options.
     * @param {boolean} [options.positional=true] Use an HRTF PannerNode.
     * @param {boolean} [options.loop=false] Loop playback.
     * @param {number} [options.volume=1] Linear gain.
     * @param {number} [options.playbackRate=1] Playback rate.
     * @param {number} [options.detune=0] Detune in cents.
     * @param {string} [options.bus='sfx'] Destination bus name.
     * @param {number} [options.refDistance=1] Distance at which the volume is unattenuated.
     * @param {number} [options.maxDistance=10000] Distance beyond which attenuation stops.
     * @param {number} [options.rolloffFactor=1] Attenuation steepness.
     * @param {string} [options.distanceModel='inverse'] 'linear' | 'inverse' | 'exponential'.
     * @param {string} [options.panningModel='HRTF'] 'equalpower' | 'HRTF'.
     * @param {number} [options.coneInnerAngle=360] Inner cone angle in degrees.
     * @param {number} [options.coneOuterAngle=360] Outer cone angle in degrees.
     * @param {number} [options.coneOuterGain=0] Gain outside the outer cone.
     * @param {boolean} [options.autoplay=false] Start as soon as a buffer exists.
     * @param {string} [options.name] Node name.
     */
    constructor(engine: import('./AudioEngine.js').AudioEngine, buffer?: any, options?: {
        positional?: boolean;
        loop?: boolean;
        volume?: number;
        playbackRate?: number;
        detune?: number;
        bus?: string;
        refDistance?: number;
        maxDistance?: number;
        rolloffFactor?: number;
        distanceModel?: string;
        panningModel?: string;
        coneInnerAngle?: number;
        coneOuterAngle?: number;
        coneOuterGain?: number;
        autoplay?: boolean;
        name?: string;
    });
    /** @type {boolean} Type flag for fast checks. */
    isAudioSource: boolean;
    /** @type {*} Owning AudioEngine. */
    engine: any;
    /** @type {*} Shortcut to the AudioContext, or null when unsupported. */
    context: any;
    /** @type {*} Decoded AudioBuffer. */
    buffer: any;
    /** @type {boolean} Whether the source is routed through a PannerNode. */
    positional: boolean;
    /** @type {boolean} True while a buffer source is running. */
    isPlaying: boolean;
    /** @type {boolean} True when playback was paused (offset retained). */
    isPaused: boolean;
    /** @type {boolean} Start automatically once a buffer is present. */
    autoplay: boolean;
    /** @type {*} GainNode used for the source volume. */
    _gain: any;
    /** @type {*} PannerNode used for 3D placement. */
    _panner: any;
    /** @type {*} Currently running AudioBufferSourceNode. */
    _source: any;
    /** @type {*} Destination bus. */
    _bus: any;
    /** @type {string} Destination bus name. */
    busName: string;
    /** @type {number} Playback offset in seconds used by play()/pause(). */
    _offset: number;
    /** @type {number} Context time at which the current source started. */
    _startedAt: number;
    /** @type {number} Last uploaded panner X. */
    _lastX: number;
    /** @type {number} Last uploaded panner Y. */
    _lastY: number;
    /** @type {number} Last uploaded panner Z. */
    _lastZ: number;
    /** @type {number} Backing field for the `volume` accessor. */
    _volume: number;
    /** @type {boolean} Backing field for the `loop` accessor. */
    _loop: boolean;
    /** @type {number} Backing field for the `playbackRate` accessor. */
    _playbackRate: number;
    /** @type {number} Backing field for the `detune` accessor. */
    _detune: number;
    /** @type {number} Backing field for the `refDistance` accessor. */
    _refDistance: number;
    /** @type {number} Backing field for the `maxDistance` accessor. */
    _maxDistance: number;
    /** @type {number} Backing field for the `rolloffFactor` accessor. */
    _rolloffFactor: number;
    /** @type {string} Distance attenuation model. */
    distanceModel: string;
    /** @type {string} Panning model. */
    panningModel: string;
    /** @type {number} Inner cone angle in degrees. */
    coneInnerAngle: number;
    /** @type {number} Outer cone angle in degrees. */
    coneOuterAngle: number;
    /** @type {number} Gain applied outside the outer cone. */
    coneOuterGain: number;
    /** @type {Function|null} Called when a non-looping buffer finishes. */
    onEnded: Function | null;
    /** @type {Function} Internal ended handler. */
    _endedHandler: Function;
    /**
     * Builds the gain -> [panner] -> bus chain.
     * @private
     */
    private _buildGraph;
    /**
     * Connects the tail of the chain to the destination bus.
     * @param {*} node Tail node.
     * @private
     */
    private _connectOutput;
    /**
     * Routes the source to another bus.
     * @param {string} name Bus name.
     */
    setBus(name: string): void;
    /**
     * @param {number} value Linear gain.
     */
    set volume(arg: number);
    /**
     * Linear output gain.
     * @returns {number} Current volume.
     */
    get volume(): number;
    /**
     * @param {boolean} value Loop flag.
     */
    set loop(arg: boolean);
    /**
     * Whether playback repeats.
     * @returns {boolean} Loop flag.
     */
    get loop(): boolean;
    /**
     * @param {number} value Rate multiplier.
     */
    set playbackRate(arg: number);
    /**
     * Playback rate multiplier.
     * @returns {number} Rate.
     */
    get playbackRate(): number;
    /**
     * @param {number} value Detune in cents.
     */
    set detune(arg: number);
    /**
     * Detune in cents.
     * @returns {number} Detune.
     */
    get detune(): number;
    /**
     * @param {number} value Reference distance.
     */
    set refDistance(arg: number);
    /**
     * Distance at which the volume is unattenuated.
     * @returns {number} Reference distance.
     */
    get refDistance(): number;
    /**
     * @param {number} value Maximum distance.
     */
    set maxDistance(arg: number);
    /**
     * Distance beyond which attenuation stops growing.
     * @returns {number} Maximum distance.
     */
    get maxDistance(): number;
    /**
     * @param {number} value Rolloff factor.
     */
    set rolloffFactor(arg: number);
    /**
     * Attenuation steepness.
     * @returns {number} Rolloff factor.
     */
    get rolloffFactor(): number;
    /**
     * Duration of the assigned buffer in seconds.
     * @returns {number} Duration, 0 when no buffer is set.
     */
    get duration(): number;
    /**
     * Current playback head in seconds.
     * @returns {number} Playback position.
     */
    get currentTime(): number;
    /**
     * Assigns a new buffer, stopping any current playback.
     * @param {*} buffer Decoded AudioBuffer.
     * @returns {AudioSource} This instance.
     */
    setBuffer(buffer: any): AudioSource;
    /**
     * Starts (or restarts) playback.
     * @param {number} [offset] Start offset in seconds; defaults to the paused offset.
     * @param {number} [delay=0] Delay before starting, in seconds.
     * @returns {AudioSource} This instance.
     */
    play(offset?: number, delay?: number): AudioSource;
    /**
     * Stops playback and rewinds to the beginning.
     * @returns {AudioSource} This instance.
     */
    stop(): AudioSource;
    /**
     * Pauses playback, retaining the playback head.
     * @returns {AudioSource} This instance.
     */
    pause(): AudioSource;
    /**
     * Stops and releases the current buffer source node.
     * @private
     */
    private _teardownSource;
    /**
     * Handles natural end of playback.
     * @private
     */
    private _handleEnded;
    /**
     * Pushes the node's world transform into the PannerNode. Cheap and safe to
     * call every frame: uploads are skipped while the source does not move.
     * @param {boolean} [force=false] Upload even when the position is unchanged.
     */
    updateFromNode(force?: boolean): void;
    /**
     * Stops playback, tears down the audio graph and detaches the node.
     */
    dispose(): void;
}
import { Node3D } from "../scene/Node3D.js";
