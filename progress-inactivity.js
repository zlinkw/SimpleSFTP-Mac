"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProgressInactivity = void 0;
/** Heartbeats and identical payloads never extend the wait. */
class ProgressInactivity {
    idleMs;
    onIdle;
    now;
    timer;
    phases = new Set();
    phase = "";
    counts = new Map();
    pausedAt;
    ended = false;
    lastProgressAt;
    constructor(idleMs, onIdle, now = Date.now) {
        this.idleMs = idleMs;
        this.onIdle = onIdle;
        this.now = now;
        this.lastProgressAt = now();
        this.arm();
    }
    update(evidence) {
        if (this.ended)
            return false;
        const phase = String(evidence.phase || this.phase);
        const key = String(evidence.scope || "") + ":" + phase;
        const previous = this.counts.get(key) || { bytes: 0, files: 0 };
        const bytes = Math.max(previous.bytes, Number(evidence.processedBytes) || 0);
        const files = Math.max(previous.files, Number(evidence.processedFiles) || 0);
        const phaseChanged = Boolean(phase && !this.phases.has(key));
        const terminal = ['completed', 'succeeded', 'cancelled', 'failed'].includes(String(evidence.status));
        const changed = bytes > previous.bytes || files > previous.files || phaseChanged || terminal;
        this.counts.set(key, { bytes, files });
        this.phase = phase;
        if (phase)
            this.phases.add(key);
        if (changed) {
            this.lastProgressAt = this.now();
            this.arm();
        }
        if (terminal)
            this.dispose();
        return changed;
    }
    pause() {
        if (this.pausedAt === undefined)
            this.pausedAt = this.now();
        clearTimeout(this.timer);
    }
    resume() {
        if (this.pausedAt === undefined)
            return;
        this.lastProgressAt += this.now() - this.pausedAt;
        this.pausedAt = undefined;
        this.arm();
    }
    check() {
        if (this.ended || this.pausedAt !== undefined || this.now() - this.lastProgressAt < this.idleMs)
            return false;
        this.dispose();
        this.onIdle();
        return true;
    }
    dispose() { this.ended = true; clearTimeout(this.timer); }
    arm() {
        clearTimeout(this.timer);
        if (this.ended || this.pausedAt !== undefined)
            return;
        this.timer = setTimeout(() => { if (!this.check())
            this.arm(); }, Math.max(1, this.idleMs - (this.now() - this.lastProgressAt)));
        this.timer.unref?.();
    }
}
exports.ProgressInactivity = ProgressInactivity;
